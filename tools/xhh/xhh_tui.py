#!/usr/bin/env python3
"""xhh TUI：全屏浏览界面。图片默认折叠成一行，回车就地展开为
盲文高密字符画（每字符 2x4 像素），再按折叠。

键位：
    ↑/↓ 选择    回车 看帖/展开折叠图片    b/退格 返回热榜
    0 刷新热榜  q 退出（帖子里 q 先返回）
"""
import asyncio
import io
import sys
from pathlib import Path

from PIL import Image
from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.screen import Screen
from textual.widgets import Collapsible, Footer, Label, ListItem, ListView, Static

sys.path.insert(0, str(Path(__file__).parent))
from xhh import _download, daemon_call, ensure_daemon, post_id_of  # noqa: E402

# ---- 盲文渲染：每字符 2x4 像素，密度是半块字符的 4 倍 ----
_BRAILLE_BASE = 0x2800
_DOTS = {
    (0, 0): 0x01, (0, 1): 0x02, (0, 2): 0x04, (0, 3): 0x40,
    (1, 0): 0x08, (1, 1): 0x10, (1, 2): 0x20, (1, 3): 0x80,
}


def img_to_braille(data, cols=100, max_rows=50):
    """图片 → list[rich.Text]，墨点取与背景差异大的像素并着平均色。"""
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    cols = max(10, min(cols, (w + 1) // 2))
    rows = max(1, min(max_rows, int(h / (w / (cols * 2)) / 4)))
    im = im.resize((cols * 2, rows * 4), Image.LANCZOS)
    px = im.load()

    def lum(p):
        return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]

    lums = [lum(px[x, y]) for y in range(im.height) for x in range(im.width)]
    mean = sum(lums) / len(lums)
    # 亮图取暗像素为墨，暗图取亮像素为墨；阈值用均值自适应
    ink_is_dark = mean > 110

    def is_ink(p):
        return lum(p) < mean if ink_is_dark else lum(p) > mean

    lines = []
    for cy in range(rows):
        line = Text()
        for cx in range(cols):
            bits, rs, gs, bs, n = 0, 0, 0, 0, 0
            for (dx, dy), bit in _DOTS.items():
                p = px[cx * 2 + dx, cy * 4 + dy]
                if is_ink(p):
                    bits |= bit
                    rs, gs, bs, n = rs + p[0], gs + p[1], bs + p[2], n + 1
            ch = chr(_BRAILLE_BASE + bits)
            line.append(ch, style=f"rgb({rs//n},{gs//n},{bs//n})" if n else "rgb(60,60,60)")
        lines.append(line)
    return lines


class ImageBlock(Collapsible):
    """可折叠图片块：展开时下载并渲染盲文字符画。"""

    def __init__(self, url, no, width=100):
        self._body = Static("（展开加载中…）")
        super().__init__(self._body, title=f"[图{no}]", collapsed=True)
        self.url = url
        self.no = no
        self.width = width
        self._loaded = False

    def on_collapsible_expanded(self, event: Collapsible.Expanded):
        if not self._loaded:
            self._loaded = True
            self._load()

    @work
    async def _load(self):
        try:
            data = await asyncio.to_thread(_download, self.url)
            lines = await asyncio.to_thread(img_to_braille, data, self.width)
            text = Text("\n").join(lines)
            self._body.update(text)
        except Exception as e:
            self._body.update(f"[图片加载失败: {e}]")


class PostScreen(Screen):
    BINDINGS = [
        Binding("b", "back", "返回"),
        Binding("backspace", "back", "返回"),
        Binding("q", "back", "返回"),
    ]

    def __init__(self, pid):
        super().__init__()
        self.pid = pid

    def compose(self) -> ComposeResult:
        yield VerticalScroll(Static("加载中…", id="status"), id="content")
        yield Footer()

    def on_mount(self):
        self._fetch()

    def action_back(self):
        self.app.pop_screen()

    @work
    async def _fetch(self):
        content = self.query_one("#content", VerticalScroll)
        status = self.query_one("#status", Static)
        try:
            head = await daemon_call({"cmd": "post_head", "pid": self.pid})
            if not head.get("ok"):
                status.update(f"!! {head.get('error')}")
                return
            data = head["data"]
            await status.remove()

            author = " · ".join(x for x in (data.get("author"), data.get("level"), data.get("meta")) if x)
            await content.mount(Static(data["title"], classes="post-title"))
            if author:
                await content.mount(Static(author, classes="post-author"))

            img_no = 0
            for block in data.get("blocks", []):
                if block.get("type") == "img":
                    img_no += 1
                    await content.mount(ImageBlock(block["src"], img_no, width=max(60, self.app.size.width - 8)))
                else:
                    await content.mount(Static(block.get("text", ""), classes="post-text"))

            # 评论后补
            comments = await daemon_call({"cmd": "post_comments", "pid": self.pid})
            if not comments.get("ok"):
                return
            cdata = comments["data"]
            total = cdata.get("total") or "全部评论"
            await content.mount(Static(f"── {total} ──", classes="comments-sep"))
            for i, c in enumerate(cdata.get("comments", []), 1):
                t = Text()
                t.append(f"#{i} ", style="dim")
                t.append(c.get("name") or "匿名", style="cyan")
                if c.get("level"):
                    t.append(f" {c['level']}", style="dim")
                if c.get("time"):
                    t.append(f" {c['time']}", style="dim")
                if c.get("likes") and c["likes"] != "0":
                    t.append(f" {c['likes']}赞", style="magenta")
                if c.get("content"):
                    t.append("\n  " + c["content"])
                for r in c.get("replies", []):
                    who = r.get("name") or "匿名"
                    if r.get("reply_to"):
                        who += f" 回复 {r['reply_to']}"
                    t.append(f"\n  ↳ {who}: {r.get('content', '')}", style="dim")
                if c.get("more"):
                    t.append(f"\n  （{c['more']}）", style="dim")
                await content.mount(Static(t, classes="comment"))
        except Exception as e:
            status.update(f"!! {type(e).__name__}: {e}")


class FeedScreen(Screen):
    BINDINGS = [
        Binding("0", "refresh", "刷新"),
        Binding("q", "quit", "退出"),
    ]

    def __init__(self, count=20):
        super().__init__()
        self.count = count
        self.items = []

    def compose(self) -> ComposeResult:
        yield ListView(id="feed")
        yield Footer()

    def on_mount(self):
        self.title = "xhh · 小黑盒热榜"
        self.query_one("#feed", ListView).focus()
        self._load()

    def action_refresh(self):
        self._load()

    def action_quit(self):
        self.app.exit()

    @work
    async def _load(self):
        lv = self.query_one("#feed", ListView)
        lv.clear()
        lv.append(ListItem(Label("加载中…")))
        try:
            resp = await daemon_call({"cmd": "feed", "count": self.count})
            lv.clear()
            if not resp.get("ok"):
                lv.append(ListItem(Label(f"!! {resp.get('error')}")))
                return
            self.items = resp["data"]
            for it in self.items:
                t = Text()
                t.append(f"[{it['num']:>2}] ", style="dim")
                t.append(it["title"], style="bold")
                t.append(f"  ·  {it['author']}", style="dim")
                if it.get("summary"):
                    t.append(f"\n      {it['summary']}", style="dim")
                lv.append(ListItem(Label(t)))
        except Exception as e:
            lv.clear()
            lv.append(ListItem(Label(f"!! {type(e).__name__}: {e}")))

    def on_list_view_selected(self, event: ListView.Selected):
        idx = event.list_view.index
        if idx is None or not self.items or idx >= len(self.items):
            return
        self.app.push_screen(PostScreen(self.items[idx]["pid"]))


class XhhApp(App):
    CSS = """
    .post-title { text-style: bold; color: cyan; padding: 1 0 0 0; }
    .post-author { color: yellow; padding-bottom: 1; }
    .post-text { padding: 0 0 1 0; }
    .comments-sep { color: gray; padding: 1 0; }
    .comment { padding-bottom: 1; border-bottom: dashed gray; }
    ImageBlock { border: round gray; padding: 0 1; margin: 0 0 1 0; }
    ImageBlock > CollapsibleTitle { color: magenta; }
    #status { color: gray; }
    """

    def __init__(self, count=20):
        super().__init__()
        self.count = count

    async def on_mount(self):
        await ensure_daemon()
        self.push_screen(FeedScreen(self.count))


def run(count=20):
    XhhApp(count).run()
