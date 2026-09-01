"""Hidden browser engine that runs SillyTavern's original frontend generation path."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

import httpx
import websockets

ChunkHandler = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class BrowserGenerationResult:
    text: str
    chat: list[dict]
    user_name: str


def find_browser() -> str:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    match = next((path for path in candidates if path.exists()), None)
    if not match:
        raise RuntimeError("没有找到 Chrome 或 Edge，无法启动原版 SillyTavern 提示引擎")
    return str(match)


def reserve_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class SillyTavernBrowserEngine:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.port = reserve_loopback_port()
        self.profile_dir: Path | None = None
        self.process: subprocess.Popen | None = None
        self.websocket = None
        self.reader_task: asyncio.Task | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 0
        self.send_lock = asyncio.Lock()

    async def start(self) -> None:
        if self.websocket is not None:
            return
        state_dir = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "rp-tavern"
        state_dir.mkdir(parents=True, exist_ok=True)
        self.profile_dir = Path(tempfile.mkdtemp(prefix="engine-", dir=state_dir))
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        self.process = subprocess.Popen(
            [
                find_browser(),
                "--headless=new",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--remote-debugging-address=127.0.0.1",
                f"--remote-debugging-port={self.port}",
                f"--remote-allow-origins=http://127.0.0.1:{self.port}",
                f"--user-data-dir={self.profile_dir}",
                self.base_url,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        websocket_url = await self._wait_for_page()
        self.websocket = await websockets.connect(
            websocket_url,
            open_timeout=10,
            max_size=32 * 1024 * 1024,
            ping_interval=None,
        )
        self.reader_task = asyncio.create_task(self._read_messages())
        await self._wait_for_sillytavern()

    async def close(self) -> None:
        if self.websocket is not None:
            await self.websocket.close()
            self.websocket = None
        if self.reader_task is not None:
            self.reader_task.cancel()
            await asyncio.gather(self.reader_task, return_exceptions=True)
            self.reader_task = None
        for future in self.pending.values():
            if not future.done():
                future.cancel()
        self.pending.clear()
        if self.process is not None and self.process.poll() is None:
            if os.name == "nt":
                await asyncio.to_thread(
                    subprocess.run,
                    ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    check=False,
                )
            else:
                self.process.terminate()
                try:
                    await asyncio.wait_for(asyncio.to_thread(self.process.wait), timeout=5)
                except asyncio.TimeoutError:
                    self.process.kill()
        self.process = None
        if self.profile_dir is not None:
            shutil.rmtree(self.profile_dir, ignore_errors=True)
            self.profile_dir = None

    async def _wait_for_page(self) -> str:
        async with httpx.AsyncClient(timeout=2.0) as client:
            for _ in range(120):
                if self.process is not None and self.process.poll() is not None:
                    raise RuntimeError("隐藏浏览器启动失败")
                try:
                    response = await client.get(f"http://127.0.0.1:{self.port}/json")
                    pages = response.json()
                    page = next((item for item in pages if item.get("type") == "page"), None)
                    if page and page.get("webSocketDebuggerUrl"):
                        return str(page["webSocketDebuggerUrl"])
                except (httpx.HTTPError, ValueError):
                    pass
                await asyncio.sleep(0.1)
        raise RuntimeError("等待隐藏 SillyTavern 页面超时")

    async def _wait_for_sillytavern(self) -> None:
        expression = """
        (() => {
          try {
            const context = globalThis.SillyTavern?.getContext?.();
            return {
              ready: Boolean(document.querySelector('#send_textarea') && context?.characters?.length),
              documentReady: document.readyState,
              title: document.title,
              textarea: Boolean(document.querySelector('#send_textarea')),
              characters: Number(context?.characters?.length || 0),
              online: String(context?.onlineStatus || ''),
            };
          } catch (error) {
            return { ready: false, error: String(error), documentReady: document.readyState, title: document.title };
          }
        })()
        """
        last_state = None
        last_error = None
        for _ in range(600):
            try:
                state = await self._evaluate(expression)
                last_state = state
                if isinstance(state, dict) and state.get("ready"):
                    return
            except RuntimeError as error:
                last_error = str(error)
            await asyncio.sleep(0.1)
        raise RuntimeError(f"隐藏 SillyTavern 前端初始化超时: state={last_state}, error={last_error}")

    async def _read_messages(self) -> None:
        try:
            async for raw in self.websocket:
                message = json.loads(raw)
                request_id = message.get("id")
                if request_id is None:
                    continue
                future = self.pending.pop(int(request_id), None)
                if future is not None and not future.done():
                    future.set_result(message)
        except Exception as error:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)

    async def _evaluate(self, expression: str) -> object:
        await self.start()
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        async with self.send_lock:
            self.next_id += 1
            request_id = self.next_id
            self.pending[request_id] = future
            await self.websocket.send(json.dumps({
                "id": request_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "awaitPromise": True,
                    "returnByValue": True,
                },
            }))
        message = await asyncio.wait_for(future, timeout=240)
        if message.get("error") or message.get("result", {}).get("exceptionDetails"):
            detail = message.get("result", {}).get("exceptionDetails", {}).get("exception", {}).get("description")
            raise RuntimeError(detail or str(message.get("error") or "隐藏酒馆执行失败"))
        return message.get("result", {}).get("result", {}).get("value")

    async def generate(
        self,
        avatar: str,
        chat_id: str,
        mode: str,
        user_text: str = "",
        on_chunk: ChunkHandler | None = None,
    ) -> BrowserGenerationResult:
        arguments = json.dumps({
            "avatar": avatar,
            "chatId": chat_id,
            "mode": mode,
            "text": user_text,
        }, ensure_ascii=False)
        expression = f"""
        (async () => {{
          const args = {arguments};
          const st = await import('/script.js');
          const characterId = st.characters.findIndex(character => character.avatar === args.avatar);
          if (characterId < 0) throw new Error(`Character not found: ${{args.avatar}}`);
          await st.selectCharacterById(characterId, {{ switchMenu: false }});
          if (st.characters[characterId].chat !== args.chatId) {{
            await st.openCharacterChat(args.chatId);
          }}
          const textarea = document.querySelector('#send_textarea');
          if (!textarea) throw new Error('SillyTavern input is unavailable');
          if (args.mode === 'normal') {{
            textarea.value = args.text;
            textarea.dispatchEvent(new Event('input', {{ bubbles: true }}));
          }}
          const type = args.mode === 'retry' ? 'regenerate' : args.mode;
          const generated = await st.Generate(type);
          const text = args.mode === 'impersonate'
            ? String(textarea.value || generated || '')
            : String(st.chat.at(-1)?.mes || generated || '');
          const userName = String(st.chat.find(message => message?.is_user)?.name || '用户');
          return {{ text, userName, chat: structuredClone(st.chat) }};
        }})()
        """
        generation_task = asyncio.create_task(self._evaluate(expression))
        last_partial = ""
        snapshot_expression = """
        (async () => {
          const st = await import('/script.js');
          const last = st.chat.at(-1);
          return last && !last.is_user ? String(last.mes || '') : '';
        })()
        """
        while not generation_task.done():
            await asyncio.sleep(0.15)
            if on_chunk is None:
                continue
            try:
                partial = str(await self._evaluate(snapshot_expression) or "")
                if partial and partial != last_partial:
                    last_partial = partial
                    await on_chunk(partial)
            except RuntimeError:
                pass
        payload = await generation_task
        if not isinstance(payload, dict) or not str(payload.get("text") or "").strip():
            raise RuntimeError("原版 SillyTavern 前端没有返回正文")
        text = str(payload["text"]).strip()
        if on_chunk and text != last_partial:
            await on_chunk(text)
        chat = [dict(item) for item in payload.get("chat") or [] if isinstance(item, dict)]
        return BrowserGenerationResult(text, chat, str(payload.get("userName") or "用户"))

    async def capture_prompt(self, avatar: str, chat_id: str) -> list[dict]:
        """Assemble the exact current chat-completion prompt without calling the model."""
        arguments = json.dumps({"avatar": avatar, "chatId": chat_id}, ensure_ascii=False)
        expression = f"""
        (async () => {{
          const args = {arguments};
          const st = await import('/script.js');
          const characterId = st.characters.findIndex(character => character.avatar === args.avatar);
          if (characterId < 0) throw new Error(`Character not found: ${{args.avatar}}`);
          await st.selectCharacterById(characterId, {{ switchMenu: false }});
          if (st.characters[characterId].chat !== args.chatId) {{
            await st.openCharacterChat(args.chatId);
          }}
          let captured = null;
          st.eventSource.once(st.event_types.CHAT_COMPLETION_PROMPT_READY, event => {{
            captured = structuredClone(event.chat || event);
          }});
          await st.Generate('normal', {{}}, true);
          if (!Array.isArray(captured)) throw new Error('Chat completion prompt was not captured');
          return captured;
        }})()
        """
        payload = await self._evaluate(expression)
        return [dict(item) for item in payload or [] if isinstance(item, dict)]
