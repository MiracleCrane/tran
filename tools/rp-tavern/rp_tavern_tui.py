#!/usr/bin/env python3
"""Terminal-first RP client backed by a running local SillyTavern."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import webbrowser
from datetime import datetime
from pathlib import Path

from rich.console import Group
from rich.markdown import Markdown
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal
from textual.widgets import RichLog, Select, Static, TextArea

from rp_tavern_client import (
    Character,
    ChatRef,
    TavernClient,
    append_exchange,
    continue_last_assistant,
    replace_last_assistant,
)

DEFAULT_BOSS_KEY = "f12"
MOUSE_BOSS_KEYS = {"middle": 0x04, "mouse4": 0x05, "mouse5": 0x06}
DECOY_MESSAGES = [
    "Resolving workspace dependencies",
    "Loading compiler configuration",
    "Scanning incremental build graph",
    "Checking generated type declarations",
    "Running integration test worker",
    "Validating local service health",
    "Rebuilding changed modules",
    "Waiting for file system events",
]


def default_config_path() -> Path:
    root = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return root / "rp-tavern" / "config.json"


def validate_boss_key(value: str) -> str:
    key = value.strip().lower()
    if not key or len(key) > 40 or not re.fullmatch(r"[a-z0-9_+,-]+", key):
        raise ValueError("按键格式无效，例如：f12、ctrl+b、ctrl+shift+space")
    return key


def load_boss_key(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return validate_boss_key(str(data.get("boss_key") or DEFAULT_BOSS_KEY))
    except (OSError, ValueError, json.JSONDecodeError):
        return DEFAULT_BOSS_KEY


def save_boss_key(path: Path, key: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"boss_key": key}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def set_console_title(value: str) -> None:
    if os.name == "nt":
        ctypes.windll.kernel32.SetConsoleTitleW(value)


def resize_console_font(delta: int = 0, reset: bool = False) -> int | None:
    """调整经典 Windows 控制台字号；Windows Terminal 仍可使用原生快捷键。"""
    if os.name != "nt":
        return None

    class Coord(ctypes.Structure):
        _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short)]

    class ConsoleFontInfoEx(ctypes.Structure):
        _fields_ = [
            ("size", ctypes.c_ulong),
            ("font_index", ctypes.c_ulong),
            ("font_size", Coord),
            ("font_family", ctypes.c_uint),
            ("font_weight", ctypes.c_uint),
            ("face_name", ctypes.c_wchar * 32),
        ]

    kernel = ctypes.windll.kernel32
    handle = kernel.GetStdHandle(-11)
    info = ConsoleFontInfoEx()
    info.size = ctypes.sizeof(info)
    if not kernel.GetCurrentConsoleFontEx(handle, False, ctypes.byref(info)):
        return None
    current = int(info.font_size.y or 18)
    target = 18 if reset else max(8, min(40, current + delta))
    info.font_size.y = target
    if not kernel.SetCurrentConsoleFontEx(handle, False, ctypes.byref(info)):
        return None
    return target


def message_timestamp(item: dict) -> str:
    raw_date = str(item.get("send_date") or "")
    matched_time = re.search(r"(\d{1,2}:\d{2}:\d{2})(?:[.,](\d{1,3}))?", raw_date)
    if matched_time:
        millis = (matched_time.group(2) or "000").ljust(3, "0")[:3]
        return f"{matched_time.group(1)}.{millis}"
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def message_log_line(item: dict, sequence: int) -> Text:
    is_user = bool(item.get("is_user"))
    stamp = message_timestamp(item)
    operation = "request.dispatch" if is_user else "response.commit"
    level = "DEBUG" if is_user else "INFO "
    byte_count = len(str(item.get("mes") or "").encode("utf-8"))
    return Text(
        f"[{stamp}] {level} {operation} seq={sequence:04d} bytes={byte_count} ... ok",
        style="#626262",
    )


def message_log_lines(item: dict, sequence: int) -> list[Text]:
    is_user = bool(item.get("is_user"))
    stamp = message_timestamp(item)
    message = str(item.get("mes") or "")
    byte_count = len(message.encode("utf-8"))
    char_count = len(message)
    if is_user:
        lines = [
            Text(f"[{stamp}] TRACE stdin.decode chars={char_count} encoding=utf-8 ... ok", style="#565656"),
            message_log_line(item, sequence),
            Text(f"[{stamp}] DEBUG context.merge turn={sequence:04d} source=interactive ... ok", style="#5d5d5d"),
        ]
    else:
        estimated_chunks = max(1, byte_count // 12)
        lines = [
            Text(f"[{stamp}] TRACE stream.aggregate chunks={estimated_chunks} bytes={byte_count} ... ok", style="#565656"),
            message_log_line(item, sequence),
            Text(f"[{stamp}] DEBUG transcript.flush turn={sequence:04d} durable=true ... ok", style="#5d5d5d"),
        ]
    if sequence % 3 == 0:
        lines.insert(
            1,
            Text(f"[{stamp}] WARN  cache.lookup key=turn-{sequence:04d} miss=true fallback=memory ... recovered", style="#806f52"),
        )
    return lines


def render_message(item: dict, sequence: int = 1) -> Group:
    is_user = bool(item.get("is_user"))
    name = str(item.get("name") or ("你" if is_user else "角色"))
    heading_color = "#7896a8" if is_user else "#879a75"
    body_color = "#98a7af" if is_user else "#a2a49a"
    heading = Text(f"{name} >", style=f"bold {heading_color}")
    body = Markdown(
        str(item.get("mes") or ""),
        style=body_color,
        code_theme="ansi_dark",
        inline_code_theme="ansi_dark",
    )
    return Group(*message_log_lines(item, sequence), heading, body)


class TavernApp(App):
    TITLE = "terminal"
    CSS = """
    Screen { background: #0c0c0c; color: #c7c7c7; }
    #toolbar { height: 3; padding: 0; background: #0c0c0c; }
    Select { width: 1fr; margin-right: 1; background: #0c0c0c; border: none; color: #b8b8b8; }
    Select:focus { border: none; background: #161616; }
    #model { width: 30; content-align: right middle; color: #777777; }
    #transcript { height: 1fr; border: none; padding: 0 1; background: #0c0c0c; }
    #hint { height: 1; padding: 0 1; color: #666666; }
    #status { height: 1; padding: 0 1; color: #777777; }
    #input { dock: bottom; height: 5; margin: 0; border: none; background: #111111; color: #d0d0d0; }
    #input:focus { border: none; background: #151515; }
    #decoy { display: none; height: 1fr; border: none; padding: 0 1; background: #0c0c0c; color: #bdbdbd; }
    Screen.decoy #toolbar, Screen.decoy #transcript, Screen.decoy #hint,
    Screen.decoy #status, Screen.decoy #input { display: none; }
    Screen.decoy #decoy { display: block; }
    """
    BINDINGS = [
        Binding("f2", "help_answer", "AI帮答", show=False),
        Binding("f3", "continue_story", "续写", show=False),
        Binding("f4", "retry", "重试", show=False),
        Binding("f6", "font_smaller", "缩小字体", show=False),
        Binding("f7", "font_larger", "放大字体", show=False),
        Binding("f8", "font_reset", "重置字体", show=False),
        Binding("f9", "open_web", "网页", show=False),
        Binding("enter", "send", "发送", show=False, priority=True),
        Binding("shift+enter", "newline", "换行", show=False, priority=True),
        Binding("ctrl+r", "refresh", "刷新", show=False),
        Binding("ctrl+q", "quit", "退出", show=False),
    ]

    def __init__(self, base_url: str, boss_key: str | None = None, config_path: Path | None = None) -> None:
        super().__init__()
        self.base_url = base_url.rstrip("/")
        self.config_path = config_path or default_config_path()
        self.boss_key = validate_boss_key(boss_key) if boss_key else load_boss_key(self.config_path)
        self.client = TavernClient(self.base_url)
        self.characters: dict[str, Character] = {}
        self.chats: dict[str, ChatRef] = {}
        self.character: Character | None = None
        self.chat_ref: ChatRef | None = None
        self.chat: list[dict] = []
        self.busy = False
        self.decoy_mode = False
        self.decoy_index = 0
        self.mouse_boss_down = False

    def compose(self) -> ComposeResult:
        with Horizontal(id="toolbar"):
            yield Select([], prompt="选择角色", id="character")
            yield Select([], prompt="选择对话", id="chat")
            yield Static("offline", id="model")
        yield RichLog(id="transcript", wrap=True, highlight=False, markup=False)
        yield Static("Enter send  Shift+Enter newline  F2 draft  F3 continue  F4 retry  F6-/F7+ font", id="hint")
        yield Static("connecting...", id="status")
        yield TextArea(
            "",
            id="input",
            soft_wrap=True,
            show_line_numbers=False,
            compact=True,
            highlight_cursor_line=False,
            placeholder="message >",
        )
        yield RichLog(id="decoy", wrap=False, highlight=False, markup=False)

    def on_mount(self) -> None:
        if self.boss_key not in MOUSE_BOSS_KEYS:
            self._bindings.bind(self.boss_key, "boss", description="", show=False, priority=True)
        self.set_interval(0.08, self.poll_boss_mouse)
        self.set_interval(1.6, self.append_decoy_line)
        self.load_initial()

    async def on_unmount(self) -> None:
        await self.client.close()

    def set_status(self, message: str, error: bool = False) -> None:
        status = self.query_one("#status", Static)
        status.update(message)
        status.styles.color = "#a85c5c" if error else "#777777"

    def render_chat(self) -> None:
        log = self.query_one("#transcript", RichLog)
        log.clear()
        visible_messages = [item for item in self.chat[-60:] if "mes" in item and not item.get("is_system")]
        for sequence, item in enumerate(visible_messages, start=1):
            log.write(render_message(item, sequence))
            log.write("")

    @work(exclusive=True)
    async def load_initial(self) -> None:
        try:
            if not await self.client.health():
                raise RuntimeError("SillyTavern 未运行或 8000 端口不可访问")
            items = await self.client.list_characters()
            if not items:
                raise RuntimeError("酒馆里还没有角色卡，请按 F9 打开网页导入")
            self.characters = {item.avatar: item for item in items}
            selector = self.query_one("#character", Select)
            selector.set_options([(item.name, item.avatar) for item in items])
            await self.select_character(items[0].avatar)
        except Exception as error:
            self.set_status(str(error), error=True)

    async def select_character(self, avatar: str) -> None:
        self.character = await self.client.get_character(avatar)
        refs = await self.client.list_chats(self.character)
        self.chats = {item.file_id: item for item in refs}
        chat_selector = self.query_one("#chat", Select)
        chat_selector.set_options([(item.file_id, item.file_id) for item in refs])
        self.query_one("#character", Select).value = avatar
        if refs:
            await self.select_chat(refs[0].file_id)
        else:
            ref, chat = await self.client.create_chat(self.character)
            self.chats = {ref.file_id: ref}
            chat_selector.set_options([(ref.file_id, ref.file_id)])
            self.chat_ref, self.chat = ref, chat
            chat_selector.value = ref.file_id
            self.render_chat()
        runtime = await self.client.runtime_config()
        self.query_one("#model", Static).update(runtime.model)
        self.set_status(f"ready · {self.character.name} · boss={self.boss_key} · /bosskey <key>")
        self.query_one("#input", TextArea).focus()

    async def select_chat(self, file_id: str) -> None:
        if not self.character:
            return
        ref = self.chats[file_id]
        self.chat_ref = ref
        self.chat = await self.client.load_chat(self.character, ref)
        self.query_one("#chat", Select).value = file_id
        self.render_chat()

    async def on_select_changed(self, event: Select.Changed) -> None:
        if event.value is Select.BLANK or self.busy:
            return
        try:
            if event.select.id == "character" and str(event.value) != (self.character.avatar if self.character else None):
                await self.select_character(str(event.value))
            elif event.select.id == "chat" and str(event.value) != (self.chat_ref.file_id if self.chat_ref else None):
                await self.select_chat(str(event.value))
        except Exception as error:
            self.set_status(str(error), error=True)

    def action_send(self) -> None:
        editor = self.query_one("#input", TextArea)
        value = editor.text.strip()
        if not value or self.busy:
            return
        editor.clear()
        if value.casefold() == "/bosskey":
            self.set_status(f"当前老板键：{self.boss_key}；修改示例：/bosskey ctrl+b")
            return
        if value.casefold().startswith("/bosskey "):
            try:
                new_key = validate_boss_key(value.split(maxsplit=1)[1])
                if self.boss_key not in MOUSE_BOSS_KEYS:
                    self._bindings.key_to_bindings.pop(self.boss_key, None)
                if new_key not in MOUSE_BOSS_KEYS:
                    self._bindings.bind(new_key, "boss", description="", show=False, priority=True)
                self.boss_key = new_key
                self.mouse_boss_down = False
                save_boss_key(self.config_path, new_key)
                self.set_status(f"老板键已改为 {new_key}")
            except (OSError, ValueError) as error:
                self.set_status(str(error), error=True)
            return
        self.generate("normal", value)

    def action_newline(self) -> None:
        self.query_one("#input", TextArea).insert("\n")

    @work(exclusive=True)
    async def generate(self, mode: str, user_text: str = "") -> None:
        if self.busy or not self.character or not self.chat_ref:
            return
        self.busy = True
        labels = {"normal": "回复", "retry": "重试", "continue": "续写", "impersonate": "帮答"}
        try:
            async def partial(value: str) -> None:
                tail = value[-90:].replace("\n", " ")
                self.set_status(f"AI {labels[mode]}中... {tail}")

            self.set_status(f"AI {labels[mode]}中...")
            reply, user_name, runtime = await self.client.generate(
                self.character, self.chat, mode, user_text, partial
            )
            if mode == "impersonate":
                self.query_one("#input", TextArea).load_text(reply)
                self.set_status("AI 帮答草稿已放入输入框；修改后按 Enter 发送")
            else:
                if mode == "normal":
                    append_exchange(self.chat, user_name, self.character.name, user_text, reply)
                elif mode == "retry":
                    replace_last_assistant(self.chat, reply)
                else:
                    continue_last_assistant(self.chat, reply)
                await self.client.save_chat(self.character, self.chat_ref, self.chat)
                self.render_chat()
                self.set_status(f"done · {runtime.model}")
        except Exception as error:
            self.set_status(f"{labels.get(mode, '生成')}失败：{error}", error=True)
            if mode == "normal" and user_text:
                self.query_one("#input", TextArea).load_text(user_text)
        finally:
            self.busy = False
            if not self.decoy_mode:
                self.query_one("#input", TextArea).focus()

    def action_help_answer(self) -> None:
        self.generate("impersonate")

    def action_continue_story(self) -> None:
        self.generate("continue")

    def action_retry(self) -> None:
        self.generate("retry")

    def action_open_web(self) -> None:
        webbrowser.open(self.base_url)
        self.set_status("opened web UI")

    def action_refresh(self) -> None:
        self.load_initial()

    def action_font_smaller(self) -> None:
        size = resize_console_font(delta=-2)
        self.set_status(f"font size: {size}" if size else "use terminal Ctrl+-")

    def action_font_larger(self) -> None:
        size = resize_console_font(delta=2)
        self.set_status(f"font size: {size}" if size else "use terminal Ctrl++")

    def action_font_reset(self) -> None:
        size = resize_console_font(reset=True)
        self.set_status(f"font size reset: {size}" if size else "reset font in terminal settings")

    def action_boss(self) -> None:
        self.decoy_mode = not self.decoy_mode
        if self.decoy_mode:
            self.screen.add_class("decoy")
            set_console_title("build - watch")
            decoy = self.query_one("#decoy", RichLog)
            decoy.clear()
            decoy.write("Microsoft Windows [Version 10.0.26200.6713]")
            decoy.write("C:\\workspace> npm run test:watch")
            decoy.write("")
            for _ in range(8):
                self.append_decoy_line()
            decoy.focus()
        else:
            self.screen.remove_class("decoy")
            set_console_title("terminal")
            self.query_one("#input", TextArea).focus()

    def append_decoy_line(self) -> None:
        if not self.decoy_mode:
            return
        message = DECOY_MESSAGES[self.decoy_index % len(DECOY_MESSAGES)]
        self.decoy_index += 1
        stamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        level = "DEBUG" if self.decoy_index % 3 else "INFO "
        self.query_one("#decoy", RichLog).write(f"[{stamp}] {level} {message} ... ok")

    def poll_boss_mouse(self) -> None:
        virtual_key = MOUSE_BOSS_KEYS.get(self.boss_key)
        if virtual_key is None or os.name != "nt":
            self.mouse_boss_down = False
            return
        pressed = bool(ctypes.windll.user32.GetAsyncKeyState(virtual_key) & 0x8000)
        if pressed and not self.mouse_boss_down:
            self.action_boss()
        self.mouse_boss_down = pressed


def main() -> None:
    parser = argparse.ArgumentParser(description="RP Tavern TUI")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument(
        "--boss-key",
        help="老板键，例如 f12、ctrl+b、mouse4、mouse5、middle；覆盖本机持久化配置",
    )
    args = parser.parse_args()
    TavernApp(args.url, boss_key=args.boss_key).run()


if __name__ == "__main__":
    main()
