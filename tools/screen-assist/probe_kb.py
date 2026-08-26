"""探针2：验证知识库目录会话 + 会话切换。

1. session/new 以 kb_test 目录为 cwd，问一个只有读目录文件才能答的问题
2. session/resume 切到旧会话，再切回来 —— 验证同连接多会话切换
"""

import json
import subprocess
import sys
import threading
import time

KIMI = r"C:\Users\12517\.kimi-code\bin\kimi.exe"
KB_DIR = r"C:\LegacyD\kb_outside_test"
OLD_SESSION = "session_0a6a2c13-daf8-48ba-baf6-2a95267cbbc4"
OLD_CWD = r"C:\LegacyD\projects\screen-assist"

proc = subprocess.Popen(
    [KIMI, "acp"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True, encoding="utf-8", errors="replace", bufsize=1,
)

_next_id = 0
_pending = {}
_prompt_id = None
_answer_parts = []


def send(method, params=None):
    global _next_id, _prompt_id
    _next_id += 1
    msg = {"jsonrpc": "2.0", "id": _next_id, "method": method, "params": params or {}}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    if method == "session/prompt":
        _prompt_id = _next_id
    return _next_id


def rpc(method, params, timeout=120):
    req_id = send(method, params)
    slot = {}
    event = threading.Event()
    _pending[req_id] = (slot, event)
    if not event.wait(timeout):
        raise RuntimeError(f"{method} 超时")
    msg = slot["msg"]
    if "error" in msg:
        raise RuntimeError(f"{method} 被拒：{msg['error']}")
    return msg.get("result", {})


def read_loop():
    global _prompt_id
    for line in proc.stdout:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" in msg and "method" in msg:
            if msg["method"] == "session/request_permission":
                options = msg["params"].get("options", [])
                allow = next((o for o in options if "allow" in o.get("kind", "")), None)
                title = msg["params"].get("toolCall", {}).get("title", "")
                print(f"  [tool] {title}", flush=True)
                result = ({"outcome": {"outcome": "selected", "optionId": allow["optionId"]}}
                          if allow else {"outcome": {"outcome": "cancelled"}})
                proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
                proc.stdin.flush()
            else:
                proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"],
                                             "error": {"code": -32601, "message": "n/a"}}) + "\n")
                proc.stdin.flush()
        elif "method" in msg:
            update = msg.get("params", {}).get("update", {})
            if update.get("sessionUpdate") == "agent_message_chunk":
                _answer_parts.append(update.get("content", {}).get("text", ""))
        elif msg.get("id") in _pending:
            slot, event = _pending[msg["id"]]
            slot["msg"] = msg
            event.set()
        elif msg.get("id") == _prompt_id:
            _prompt_id = None
            _pending["__prompt_done__"][1].set()


threading.Thread(target=read_loop, daemon=True).start()

rpc("initialize", {"protocolVersion": 1,
                   "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
                   "clientInfo": {"name": "probe2", "version": "0.1"}})
rpc("authenticate", {"methodId": "login"})

# 1) 以项目目录为 cwd 建会话，知识库用绝对路径指定
r = rpc("session/new", {"cwd": OLD_CWD, "mcpServers": []})
kb_session = r["sessionId"]
print(f"[1] 会话: {kb_session} (cwd={OLD_CWD})", flush=True)

done = threading.Event()
_pending["__prompt_done__"] = (None, done)
send("session/prompt", {"sessionId": kb_session, "prompt": [{"type": "text", "text":
    rf"你的知识库在目录 {KB_DIR}（绝对路径）下。请用工具查阅该目录中的文件后回答："
    "幻影引擎 PhantomEngine 的内部版本号是多少？一句话回答。"}]})
done.wait(300)
print(f"[1] 回答: {''.join(_answer_parts)}", flush=True)

# 2) 切到旧会话再切回来
rpc("session/resume", {"sessionId": OLD_SESSION, "cwd": OLD_CWD, "mcpServers": []})
print("[2] resume 旧会话 OK", flush=True)
rpc("session/resume", {"sessionId": kb_session, "cwd": OLD_CWD, "mcpServers": []})
print("[2] resume 切回 OK —— 同连接多会话切换可行", flush=True)

proc.terminate()
print("[done]", flush=True)
