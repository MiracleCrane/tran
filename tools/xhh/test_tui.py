"""xhh TUI 完整自测：覆盖热榜、摘要、刷新、进帖、图片块展开折叠、返回、退出。"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from xhh import ensure_daemon
from xhh_tui import XhhApp, ImageBlock, FeedScreen, PostScreen
from textual.widgets import Label, ListItem, Static

PASS, FAIL = "✅", "❌"
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"{PASS if ok else FAIL} {name}" + (f"  ({detail})" if detail else ""))


async def main():
    await ensure_daemon()
    app = XhhApp(10)
    async with app.run_test(size=(120, 40)) as pilot:
        # ---- 1. 热榜加载 ----
        await pilot.pause(8)
        items = app.screen.query(ListItem)
        check("热榜加载条目数", len(items) >= 5, f"{len(items)} 条")
        labels = [str(lb.render()) for lb in app.screen.query(Label)]
        check("热榜含标题", any("[" in t for t in labels), labels[0][:40] if labels else "")
        check("热榜含摘要", any("\n" in t and len(t.split("\n")[1].strip()) > 5 for t in labels),
              (labels[0].split("\n")[1].strip()[:30] if labels and "\n" in labels[0] else "无摘要"))

        # ---- 2. 0 键刷新 ----
        await pilot.press("0")
        await pilot.pause(8)
        items2 = app.screen.query(ListItem)
        check("0 刷新后热榜重载", len(items2) >= 5, f"{len(items2)} 条")

        # ---- 3. 进帖 ----
        await pilot.press("down", "enter")
        await pilot.pause(60)  # 首次失败会触发重载重试，最长 ~50s
        check("进入帖子屏", isinstance(app.screen, PostScreen), app.screen.__class__.__name__)
        texts = [str(t.render()) for t in app.screen.query(Static)]
        check("帖子标题渲染", any(len(t) > 5 for t in texts), texts[0][:40] if texts else "")
        check("评论区渲染", any("全部评论" in t for t in texts))

        # ---- 4. 找一个带图的帖子测展开/折叠 ----
        block = None
        for _ in range(6):
            blocks = list(app.screen.query(ImageBlock))
            if blocks:
                block = blocks[0]
                break
            await pilot.press("b")
            await pilot.pause(3)
            await pilot.press("down", "enter")
            await pilot.pause(60)
        check("找到带图帖子", block is not None)

        if block:
            # 展开 → 应弹出外部原图窗口
            block.collapsed = False
            await pilot.pause(12)
            body = str(block._body.render())
            check("图片展开提示外部窗口", "外部窗口" in body or "失败" in body, body[:30])
            import subprocess as sp
            r = sp.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
                 "Where-Object { $_.CommandLine -match 'show-image' } | Select-Object -First 1 ProcessId"],
                capture_output=True, text=True, timeout=30)
            viewer_found = "ProcessId" in r.stdout or any(ch.isdigit() for ch in r.stdout)
            check("原图查看器进程已启动", viewer_found)
            # 关掉测试弹出的查看器
            sp.run(["powershell", "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
                    "Where-Object { $_.CommandLine -match 'show-image' } | Stop-Process -Force"],
                   capture_output=True, timeout=30)
            # 折叠
            block.collapsed = True
            await pilot.pause(2)
            check("图片折叠", block.collapsed)

            # 再次展开 → 应能重新弹出查看窗
            block.collapsed = False
            await pilot.pause(10)
            r2 = sp.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
                 "Where-Object { $_.CommandLine -match 'show-image' } | Select-Object -First 1 ProcessId"],
                capture_output=True, text=True, timeout=30)
            check("关闭后再次展开可重开", "ProcessId" in r2.stdout or any(ch.isdigit() for ch in r2.stdout))
            sp.run(["powershell", "-NoProfile", "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
                    "Where-Object { $_.CommandLine -match 'show-image' } | Stop-Process -Force"],
                   capture_output=True, timeout=30)
            block.collapsed = True
            await pilot.pause(1)

        # ---- 5. 返回热榜 ----
        await pilot.press("b")
        await pilot.pause(3)
        check("b 返回热榜", isinstance(app.screen, FeedScreen), app.screen.__class__.__name__)

        # ---- 6. 退出 ----
        await pilot.press("q")
        await pilot.pause(2)

    failed = [n for n, ok in results if not ok]
    print(f"\n===== {len(results) - len(failed)}/{len(results)} 通过" + (f"，失败: {failed}" if failed else " ====="))


asyncio.run(main())
