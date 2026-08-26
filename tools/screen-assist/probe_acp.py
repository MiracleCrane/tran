"""一次性探针：验证 kimi acp 的 NDJSON JSON-RPC 握手与会话流程。

用系统 Python 直接跑（只依赖标准库）：
  C:\\LegacyD\\Python\\Python312\\python.exe probe_acp.py
"""

import json
import subprocess
import sys
import threading
import time

KIMI = r"C:\Users\12517\.kimi-code\bin\kimi.exe"
CWD = r"C:\LegacyD\projects\screen-assist"

proc = subprocess.Popen(
    [KIMI, "acp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)


def drain_stderr():
    for line in proc.stderr:
        print(f"[stderr] {line.rstrip()}", flush=True)


threading.Thread(target=drain_stderr, daemon=True).start()

_next_id = 0


def send(method, params=None):
    global _next_id
    _next_id += 1
    msg = {"jsonrpc": "2.0", "id": _next_id, "method": method, "params": params or {}}
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    print(f"[>>] {method} (id={_next_id})", flush=True)
    return _next_id


def read_msg(timeout=120):
    """读一行 stdout，带超时。返回解析后的 dict 或 None。"""
    result = {}

    def _read():
        result["line"] = proc.stdout.readline()

    t = threading.Thread(target=_read, daemon=True)
    t.start()
    t.join(timeout)
    line = result.get("line")
    if not line:
        return None
    return json.loads(line)


def wait_for_result(req_id, timeout=180):
    """等指定 id 的 result，途中打印通知、自动应答权限请求。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = read_msg(timeout=max(1, int(deadline - time.time())))
        if msg is None:
            print("[timeout] 等待 result 超时", flush=True)
            return None
        if "id" in msg and "method" in msg:  # agent 发来的请求
            method = msg["method"]
            print(f"[<< request] {method}: {json.dumps(msg.get('params'), ensure_ascii=False)[:300]}", flush=True)
            if method == "session/request_permission":
                options = msg["params"].get("options", [])
                allow = next((o for o in options if "allow" in o.get("kind", "")), options[0] if options else None)
                resp = {"jsonrpc": "2.0", "id": msg["id"],
                        "result": {"outcome": {"outcome": "selected", "optionId": allow["optionId"]}} if allow
                        else {"outcome": {"outcome": "cancelled"}}}
                proc.stdin.write(json.dumps(resp) + "\n")
                proc.stdin.flush()
                print(f"[>>] permission -> {allow and allow.get('optionId')}", flush=True)
            elif method == "fs/read_text_file":
                resp = {"jsonrpc": "2.0", "id": msg["id"],
                        "error": {"code": -32601, "message": "probe: fs not implemented"}}
                proc.stdin.write(json.dumps(resp) + "\n")
                proc.stdin.flush()
            continue
        if "method" in msg:  # 通知
            update = msg.get("params", {}).get("update", {})
            kind = update.get("sessionUpdate")
            if kind == "agent_message_chunk":
                text = update.get("content", {}).get("text", "")
                print(f"[chunk] {text}", end="", flush=True)
            else:
                print(f"[notify] {kind}: {json.dumps(update, ensure_ascii=False)[:200]}", flush=True)
            continue
        if msg.get("id") == req_id:
            print(f"\n[<< result id={req_id}] {json.dumps(msg, ensure_ascii=False)[:500]}", flush=True)
            return msg
    return None


init_id = send("initialize", {
    "protocolVersion": 1,
    "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
    "clientInfo": {"name": "screen-assist-probe", "version": "0.1.0"},
})
init_resp = wait_for_result(init_id)
if not init_resp or "error" in init_resp:
    sys.exit("initialize 失败")

auth_id = send("authenticate", {"methodId": "login"})
wait_for_result(auth_id)

new_id = send("session/new", {"cwd": CWD, "mcpServers": []})
new_resp = wait_for_result(new_id)
if not new_resp or "result" not in new_resp:
    sys.exit("session/new 失败")
session_id = new_resp["result"]["sessionId"]
print(f"sessionId = {session_id}", flush=True)

prompt_id = send("session/prompt", {
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": "用一句话回答：1+1等于几？"}],
})
wait_for_result(prompt_id, timeout=300)

print("\n[done] 探针完成", flush=True)
proc.terminate()
