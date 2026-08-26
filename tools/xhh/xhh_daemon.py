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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from websockets.exceptions import ConnectionClosed  # noqa: E402
import xhh  # noqa: E402
from xhh import CDP, fetch_feed, fetch_post_head, fetch_post_comments  # noqa: E402

PORT = 19812

# 启动时记录代码版本，客户端 ping 时对比：不一致说明代码已更新，应重启
CODE_MTIME = max(
    Path(xhh.__file__).stat().st_mtime,
    Path(__file__).stat().st_mtime,
)


async def handle(reader, writer, cdp):
    try:
        line = await asyncio.wait_for(reader.readline(), 30)
        req = json.loads(line.decode())
        cmd = req.get("cmd")
        if cmd == "ping":
            resp = {"ok": True, "mtime": CODE_MTIME}
        elif cmd == "feed":
            resp = {"ok": True, "data": await fetch_feed(cdp, int(req.get("count", 20)))}
        elif cmd == "post_head":
            resp = {"ok": True, "data": await fetch_post_head(cdp, str(req["pid"]))}
        elif cmd == "post_comments":
            resp = {"ok": True, "data": await fetch_post_comments(cdp, str(req["pid"]))}
        elif cmd == "stop":
            resp = {"ok": True}
            writer.write((json.dumps(resp) + "\n").encode())
            await writer.drain()
            writer.close()
            asyncio.get_running_loop().call_later(0.2, sys.exit, 0)
            return
        else:
            resp = {"ok": False, "error": f"未知命令: {cmd}"}
    except ConnectionClosed:
        # Chrome 重启/调试端口失效：退出，让客户端下次重新拉起
        resp = {"ok": False, "error": "Chrome 调试连接已断开，请重试（会自动重连）"}
        try:
            writer.write((json.dumps(resp) + "\n").encode())
            await writer.drain()
        except Exception:
            pass
        writer.close()
        asyncio.get_running_loop().call_later(0.2, sys.exit, 0)
        return
    except Exception as e:
        resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    try:
        writer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode())
        await writer.drain()
    except Exception:
        pass
    writer.close()


async def main():
    cdp = CDP()
    await cdp.connect()  # Chrome 的调试确认只在这里弹一次
    server = await asyncio.start_server(
        lambda r, w: handle(r, w, cdp), "127.0.0.1", PORT
    )
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
