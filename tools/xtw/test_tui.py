# -*- coding: utf-8 -*-
"""xtw TUI 无头自测：textual pilot 驱动，覆盖主要交互路径。

跑法：uv run python test_tui.py
需要已导出的登录 cookie（先跑 xtw login）和可用代理。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from textual.widgets import ListView  # noqa: E402
from xtw_tui import FeedScreen, TweetScreen, XtwApp  # noqa: E402

PASS, FAIL = "PASS", "FAIL"
results = []


def report(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{PASS if ok else FAIL}] {name}" + (f"  {detail}" if detail else ""))


async def wait_for(pilot, cond, timeout=60, interval=0.5):
    for _ in range(int(timeout / interval)):
        if cond():
            return True
        await pilot.pause(interval)
    return False


async def main():
    app = XtwApp()
    async with app.run_test(size=(100, 35)) as pilot:
        # 1. 启动后进入 FeedScreen
        ok = await wait_for(pilot, lambda: isinstance(app.screen, FeedScreen), 15)
        report("启动进入时间线", ok)
        if not ok:
            return

        # 2. 时间线加载出条目
        lv = app.screen.query_one("#feed", ListView)
        ok = await wait_for(pilot, lambda: len(app.screen.items) >= 10, 90)
        report("时间线加载 >=10 条", ok, f"实际 {len(app.screen.items)} 条")
        if not ok:
            return

        # 3. 回车进第一条推文
        lv.index = 0
        await pilot.press("enter")
        ok = await wait_for(pilot, lambda: isinstance(app.screen, TweetScreen), 15)
        report("进入推文详情", ok)
        if not ok:
            return

        # 4. 详情内容加载（正文 + 回复分隔线出现）
        ok = await wait_for(
            pilot,
            lambda: len(app.screen.query(".comments-sep")) > 0
            or len(app.screen.query("#status")) == 0,
            90,
        )
        body_ok = any(
            str(w.render()).startswith("── 回复")
            for w in app.screen.query(".comments-sep")
        )
        report("推文详情+回复加载", ok and body_ok)

        # 5. 返回时间线
        await pilot.press("b")
        ok = await wait_for(pilot, lambda: isinstance(app.screen, FeedScreen), 15)
        report("返回时间线", ok)

        # 6. 切 Following
        await pilot.press("2")
        ok = await wait_for(
            pilot, lambda: app.screen.mode == "following" and len(app.screen.items) >= 5, 90
        )
        report("Following 时间线", ok, f"实际 {len(app.screen.items)} 条")

        # 7. 切回 For you + 刷新
        await pilot.press("1")
        ok = await wait_for(
            pilot, lambda: app.screen.mode == "foryou" and len(app.screen.items) >= 5, 90
        )
        report("切回 For you", ok)
        await pilot.press("0")
        ok = await wait_for(pilot, lambda: len(app.screen.items) >= 5, 90)
        report("刷新时间线", ok)


if __name__ == "__main__":
    asyncio.run(main())
    failed = [r for r in results if not r[1]]
    print(f"\n== {len(results) - len(failed)}/{len(results)} 通过 ==")
    sys.exit(1 if failed else 0)
