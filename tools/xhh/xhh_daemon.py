#!/usr/bin/env python3
"""xhh 守护进程：启动时连一次 Chrome（CDP 确认只弹一次），
之后常驻监听 127.0.0.1:19812，替 xhh 客户端执行取数。

协议：每条连接一行 JSON 请求 → 一行 JSON 响应。
    {"cmd": "ping"}              -> {"ok": true}
    {"cmd": "feed", "count": 20} -> {"ok": true, "data": [...]}
    {"cmd": "post", "pid": "..."}-> {"ok": true, "data": {...}}
    {"cmd": "stop"}              -> {"ok": true} 并退出
Chrome 连接断开（如浏览器重启）时自动退出，由下个命令重新拉起。
"""
import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from websockets.exceptions import ConnectionClosed  # noqa: E402
import xhh  # noqa: E402
from xhh import CDP, fetch_feed, fetch_post_head, fetch_post_comments  # noqa: E402

PORT = int(os.environ.get("XHH_DAEMON_PORT", "19812"))

# 启动时记录代码版本，客户端 ping 时对比：不一致说明代码已更新，应重启
CODE_MTIME = max(
    Path(xhh.__file__).stat().st_mtime,
    Path(__file__).stat().st_mtime,
)


async def dispatch(req, cdp):
    """执行一个完整浏览器事务；调用方负责串行化。"""
    cmd = req.get("cmd")
    if cmd == "feed":
        count = max(1, min(int(req.get("count", 20)), 100))
        return {"ok": True, "data": await fetch_feed(cdp, count)}
    if cmd in ("post_head", "post_comments"):
        pid = xhh.post_id_of(str(req.get("pid", "")))
        if not pid:
            return {"ok": False, "code": "BAD_REQUEST", "error": "帖子 id 无效"}
        fetch = fetch_post_head if cmd == "post_head" else fetch_post_comments
        return {"ok": True, "data": await fetch(cdp, pid)}
    return {"ok": False, "code": "BAD_REQUEST", "error": f"未知命令: {cmd}"}


async def dispatch_with_reconnect(req, cdp):
    """Chrome 重启导致断链时，在同一条用户命令中重连并重放一次。"""
    for attempt in range(2):
        try:
            return await dispatch(req, cdp)
        except ConnectionClosed:
            if attempt:
                raise
            await cdp.connect()


async def handle(reader, writer, cdp, operation_lock, token, stop_event):
    should_stop = False
    try:
        line = await asyncio.wait_for(reader.readline(), 30)
        req = json.loads(line.decode())
        cmd = req.get("cmd")
        supplied = str(req.get("token", ""))
        if not secrets.compare_digest(supplied, token):
            resp = {"ok": False, "code": "UNAUTHORIZED", "error": "未授权"}
        elif cmd == "ping":
            resp = {"ok": True, "mtime": CODE_MTIME}
        elif cmd == "stop":
            resp = {"ok": True}
            should_stop = True
        else:
            async with operation_lock:
                resp = await dispatch_with_reconnect(req, cdp)
    except RuntimeError as error:
        if str(error) == "CAPTCHA":
            resp = {"ok": False, "code": "CAPTCHA", "error": "CAPTCHA"}
        else:
            resp = {"ok": False, "code": "RUNTIME_ERROR", "error": f"RuntimeError: {error}"}
    except ConnectionClosed:
        resp = {
            "ok": False,
            "code": "CDP_DISCONNECTED",
            "error": "Chrome 调试连接已断开，自动重连失败",
        }
    except Exception as error:
        resp = {"ok": False, "code": "INTERNAL_ERROR", "error": f"{type(error).__name__}: {error}"}
    try:
        writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())
        await writer.drain()
    except Exception:
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
    if should_stop:
        stop_event.set()


async def main():
    token = xhh.daemon_token()
    operation_lock = asyncio.Lock()
    stop_event = asyncio.Event()
    ready = asyncio.Event()
    state = {}

    async def on_client(reader, writer):
        await ready.wait()
        await handle(reader, writer, state["cdp"], operation_lock, token, stop_event)

    # 先绑定端口再申请 CDP：并发首启时只有端口赢家会触发 Chrome 授权。
    server = await asyncio.start_server(
        on_client,
        "127.0.0.1",
        PORT,
        limit=xhh.DAEMON_MESSAGE_LIMIT,
    )
    cdp = CDP()
    try:
        await cdp.connect()
    except Exception:
        server.close()
        await server.wait_closed()
        raise
    state["cdp"] = cdp
    ready.set()

    serve_task = asyncio.create_task(server.serve_forever())
    try:
        await stop_event.wait()
    finally:
        server.close()
        await server.wait_closed()
        serve_task.cancel()
        await cdp.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
