"""kimi acp 客户端：把 GUI 接到真实 Kimi 会话上。

协议：NDJSON（每行一个 JSON-RPC 2.0 消息）over stdio。
流程：initialize → authenticate(login) → 之后用 ensure() 按需 resume/新建会话。

多会话：同一条连接上 session/resume 可在不同会话间切换（已探针验证），
所以"本地多会话"只是 ensure 不同的 sessionId。

线程模型：
- 一个守护线程阻塞读 stdout，分发响应 / 通知 / 反向请求
- GUI 线程直接写 stdin（加锁），prompt 结果由读线程转成 Qt 信号
- 工具审批（session/request_permission）在读线程里自动选 allow 项，
  并上屏一条日志；演示工具不做人工审批，等价于 CLI 的 auto 模式
"""

import json
import os
import subprocess
import threading

from PySide6.QtCore import QObject, Signal

KIMI_EXE = r"C:\Users\12517\.kimi-code\bin\kimi.exe"


class AcpBridge(QObject):
    booted = Signal()          # 握手完成（尚未绑定任何会话）
    ready = Signal(str)        # 底层会话就绪：sessionId
    chunk = Signal(str)        # 回答增量
    thought = Signal(str)      # 思考增量（演示时也可上屏）
    tool_log = Signal(str)     # 工具调用/审批日志
    turn_done = Signal(str)    # stopReason
    failed = Signal(str)

    def __init__(self, cwd: str, kimi_home: str = "", parent: QObject | None = None):
        super().__init__(parent)
        self.cwd = cwd
        # kimi acp 的 KIMI_CODE_HOME 要和 Tran 一致，会话才会出现在 Tran 列表里
        self.kimi_home = kimi_home
        self.proc: subprocess.Popen | None = None
        self.session_id = ""
        self._next_id = 0
        self._send_lock = threading.Lock()
        self._pending: dict[int, dict] = {}   # 同步等待的握手/切换请求
        self._prompt_id: int | None = None    # 当前在途的 session/prompt

    # ---------------- 生命周期 ----------------

    def start(self) -> None:
        """启动子进程并完成握手；整个流程放后台线程，结果走信号。"""
        threading.Thread(target=self._boot, daemon=True).start()

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def _boot(self) -> None:
        try:
            env = None
            if self.kimi_home:
                env = os.environ.copy()
                env["KIMI_CODE_HOME"] = self.kimi_home
            self.proc = subprocess.Popen(
                [KIMI_EXE, "acp"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,   # 日志对演示无价值，丢弃防管道堵
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                # kimi.exe 是控制台程序，不压窗口会弹出一个空的终端黑窗
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            threading.Thread(target=self._read_loop, daemon=True).start()

            self._rpc("initialize", {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {"name": "screen-assist", "version": "0.3.0"},
            }, timeout=60)
            self._rpc("authenticate", {"methodId": "login"}, timeout=60)
            self.booted.emit()
        except Exception as ex:  # noqa: BLE001
            self.failed.emit(f"ACP 启动失败：{ex}")

    # ---------------- 会话管理 ----------------

    def ensure(self, session_id: str, cwd: str) -> None:
        """确保底层会话就绪：有 id 则 resume（可切换到别的会话），无则按 cwd 新建。

        就绪后发 ready(sessionId)；cwd 即该会话的“知识库目录”（Agent 可读写）。
        """
        threading.Thread(target=self._ensure_bg, args=(session_id, cwd),
                         daemon=True).start()

    def _ensure_bg(self, session_id: str, cwd: str) -> None:
        try:
            if session_id and session_id == self.session_id:
                self.ready.emit(session_id)
                return
            if session_id:
                self._rpc("session/resume",
                          {"sessionId": session_id, "cwd": cwd, "mcpServers": []},
                          timeout=60)
                self.session_id = session_id
            else:
                resp = self._rpc("session/new", {"cwd": cwd, "mcpServers": []},
                                 timeout=60)
                self.session_id = resp["sessionId"]
            self.ready.emit(self.session_id)
        except Exception as ex:  # noqa: BLE001
            self.failed.emit(f"准备会话失败：{ex}")

    # ---------------- 提问 ----------------

    def prompt(self, blocks: list[dict]) -> None:
        """发一轮提问；结果和流式增量都经读线程转信号。调用前确认没在途请求。"""
        if self._prompt_id is not None or not self.session_id:
            return
        req_id = self._send("session/prompt",
                            {"sessionId": self.session_id, "prompt": blocks})
        self._prompt_id = req_id

    @property
    def busy(self) -> bool:
        return self._prompt_id is not None

    # ---------------- 协议收发 ----------------

    def _send(self, method: str, params: dict) -> int:
        with self._send_lock:
            self._next_id += 1
            req_id = self._next_id
            msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
            return req_id

    def _rpc(self, method: str, params: dict, timeout: float) -> dict:
        """同步请求-响应（握手/切换阶段用），失败抛 RuntimeError。"""
        req_id = self._send(method, params)
        slot: dict = {}
        event = threading.Event()
        self._pending[req_id] = {"slot": slot, "event": event}
        try:
            if not event.wait(timeout):
                raise RuntimeError(f"{method} 超时")
            msg = slot["msg"]
            if "error" in msg:
                raise RuntimeError(f"{method} 被拒：{msg['error']}")
            return msg.get("result", {})
        finally:
            self._pending.pop(req_id, None)

    def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and "method" in msg:
                self._on_agent_request(msg)
            elif "method" in msg:
                self._on_notification(msg)
            elif msg.get("id") in self._pending:
                slot = self._pending[msg["id"]]
                slot["slot"]["msg"] = msg
                slot["event"].set()
            elif msg.get("id") == self._prompt_id:
                self._prompt_id = None
                if "error" in msg:
                    self.failed.emit(f"提问失败：{msg['error']}")
                else:
                    self.turn_done.emit(msg.get("result", {}).get("stopReason", ""))
        # 子进程 stdout 关闭 = 进程退出
        if self._prompt_id is not None:
            self._prompt_id = None
            self.failed.emit("kimi acp 进程意外退出")

    # ---------------- 消息分发 ----------------

    def _on_notification(self, msg: dict) -> None:
        if msg["method"] != "session/update":
            return
        update = msg.get("params", {}).get("update", {})
        kind = update.get("sessionUpdate")
        if kind == "agent_message_chunk":
            self.chunk.emit(update.get("content", {}).get("text", ""))
        elif kind == "agent_thought_chunk":
            self.thought.emit(update.get("content", {}).get("text", ""))
        elif kind == "tool_call":
            title = update.get("title", "")
            self.tool_log.emit(f"🔧 {title}")

    def _on_agent_request(self, msg: dict) -> None:
        """Agent 反向请求：目前只需处理工具审批，自动选 allow 类选项。"""
        method = msg["method"]
        if method == "session/request_permission":
            params = msg.get("params", {})
            options = params.get("options", [])
            allow = next((o for o in options if "allow" in o.get("kind", "")),
                         options[0] if options else None)
            title = params.get("toolCall", {}).get("title", "")
            self.tool_log.emit(f"🔧 自动批准：{title}")
            result = ({"outcome": {"outcome": "selected", "optionId": allow["optionId"]}}
                      if allow else {"outcome": {"outcome": "cancelled"}})
        else:
            # fs/* 等未实现的反向 RPC，回 methodNotFound，agent 会走本地执行
            self._reply(msg["id"], error={"code": -32601, "message": f"client 未实现 {method}"})
            return
        self._reply(msg["id"], result=result)

    def _reply(self, req_id, result=None, error=None) -> None:
        msg = {"jsonrpc": "2.0", "id": req_id}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result
        with self._send_lock:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(json.dumps(msg) + "\n")
            self.proc.stdin.flush()
