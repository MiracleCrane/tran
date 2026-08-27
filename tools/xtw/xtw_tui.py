#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""xtw TUI：全屏刷 X。图片默认折叠成 [图N]，回车就地弹出原图查看窗
（滚轮缩放 / 拖动平移 / Esc 关闭），视频只显示标记。

键位：
    ↑/↓ 选择      回车 看推文/展开图片    b/退格 返回时间线
    0 刷新        1 "For you"  2 "Following"    q 退出
"""
import asyncio
import sys
from pathlib import Path

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.screen import Screen
from textual.widgets import Collapsible, Footer, Label, ListItem, ListView, Static

sys.path.insert(0, str(Path(__file__).parent))
import xtw  # noqa: E402

FEED_COUNT = 30
REPLY_COUNT = 30


def _download(url: str) -> bytes:
    import httpx

    with httpx.Client(proxy=xtw.get_proxy(), timeout=30, follow_redirects=True) as c:
        r = c.get(url, headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        return r.content


def _cache_image(url: str, no: int) -> str:
    """下载图片缓存到临时目录，返回本地路径。"""
    import hashlib
    import tempfile

    cache_dir = Path(tempfile.gettempdir()) / "xtw_imgs"
    cache_dir.mkdir(exist_ok=True)
    ext = ".png"
    for e in (".jpg", ".png", ".webp"):
        if e in url:
            ext = ".png"  # 统一转 PNG，WPF 不认 webp
            break
    path = cache_dir / f"img{no}_{hashlib.md5(url.encode()).hexdigest()[:8]}{ext}"
    if not path.exists():
        data = _download(url)
        try:
            import io
            from PIL import Image

            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.save(path, "PNG")
        except ImportError:
            path = path.with_suffix(".jpg")
            path.write_bytes(data)
    return str(path)


def _open_image_viewer(path: str) -> None:
    """复用 xhh 的 WPF 查看窗（独立进程，不阻塞终端）。"""
    import subprocess

    viewer = Path(__file__).parent.parent / "xhh" / "show-image.ps1"
    subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | "
         f"Where-Object {{ $_.CommandLine -match [regex]::Escape('{path}') }} | "
         "Stop-Process -Force"],
        capture_output=True, timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    subprocess.Popen(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-WindowStyle", "Hidden", "-File", str(viewer), "-Path", path],
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


class ImageBlock(Collapsible):
    """可折叠图片块：展开时下载原图并弹出查看窗。"""

    def __init__(self, url: str, no: int):
        self._body = Static("（展开加载中…）")
        super().__init__(self._body, title=f"[图{no}]", collapsed=True)
        self.url = url
        self.no = no

    def on_collapsible_expanded(self, event: Collapsible.Expanded):
        self._load()

    @work
    async def _load(self):
        try:
            path = await asyncio.to_thread(_cache_image, self.url, self.no)
            await asyncio.to_thread(_open_image_viewer, path)
            self._body.update("（已在外部窗口打开原图，Esc 或点击关闭）")
        except Exception as e:
            self._body.update(f"[图片加载失败: {e}]")


def _tweet_meta(t) -> Text:
    txt = Text()
    txt.append(f"@{t.user.screen_name}", style="cyan")
    txt.append(f"  {t.user.name}", style="yellow")
    txt.append(f"  ·  {t.created_at}", style="dim")
    return txt


def _media_blocks(t):
    """从 Tweet 提取 (图片url列表, 视频数)。"""
    imgs, vids = [], 0
    for m in t.media or []:
        if m.type == "photo":
            imgs.append(m.media_url + "?name=orig")
        else:
            vids += 1
    return imgs, vids


class TweetScreen(Screen):
    BINDINGS = [
        Binding("b", "back", "返回"),
        Binding("backspace", "back", "返回"),
        Binding("q", "back", "返回"),
    ]

    def __init__(self, tweet_id: str):
        super().__init__()
        self.tweet_id = tweet_id

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
        status.update("正在打开推文…")
        try:
            client = xtw.make_client()
            t = await xtw.with_retry(lambda: xtw.get_tweet_by_id(client, self.tweet_id))
            await status.remove()

            await content.mount(Static(_tweet_meta(t), classes="post-author"))
            if t.retweeted_tweet:
                rt = t.retweeted_tweet
                await content.mount(Static(f"🔁 转推 @{rt.user.screen_name}:", classes="dim"))
                await content.mount(Static(rt.full_text or "", classes="post-text"))
                t_show = rt
            else:
                await content.mount(Static(t.full_text or t.text or "", classes="post-text"))
                t_show = t

            img_no = 0
            imgs, vids = _media_blocks(t_show)
            for url in imgs:
                img_no += 1
                await content.mount(ImageBlock(url, img_no))
            for _ in range(vids):
                await content.mount(Static("[视频]（终端内不播放，网页版查看）", classes="dim"))

            if t_show.quote:
                q = t_show.quote
                qt = Text()
                qt.append(f"引用 @{q.user.screen_name}: ", style="dim")
                qt.append(" ".join((q.full_text or "").split())[:120], style="dim")
                await content.mount(Static(qt, classes="quote"))

            stats = Text()
            stats.append(f"❤ {t.favorite_count}  ", style="magenta")
            stats.append(f"🔁 {t.retweet_count}  💬 {t.reply_count}  ", style="dim")
            stats.append(f"👁 {getattr(t, 'view_count', '?')}", style="dim")
            await content.mount(Static(stats, classes="stats"))

            loading = Static("加载回复中…", id="comments-status")
            await content.mount(loading)
            replies = []
            if t.replies:
                replies = await xtw.with_retry(
                    lambda: xtw._iter_tweets(t.replies, REPLY_COUNT)
                ) or []
            await loading.remove()
            await content.mount(Static(f"── 回复 {len(replies)} ──", classes="comments-sep"))
            for i, r in enumerate(replies, 1):
                rt = Text()
                rt.append(f"#{i} ", style="dim")
                rt.append(f"@{r.user.screen_name}", style="cyan")
                rt.append(f" {r.user.name}", style="yellow")
                rt.append("\n  " + (r.full_text or ""))
                if r.favorite_count:
                    rt.append(f"\n  ❤ {r.favorite_count}", style="magenta")
                await content.mount(Static(rt, classes="comment"))
                r_imgs, _ = _media_blocks(r)
                for url in r_imgs:
                    img_no += 1
                    await content.mount(ImageBlock(url, img_no))
        except Exception as e:
            status.update(f"!! {type(e).__name__}: {e}\n（若是登录态失效，跑 xtw login 重新导出 cookie）")


class FeedScreen(Screen):
    BINDINGS = [
        Binding("0", "refresh", "刷新"),
        Binding("1", "mode_foryou", "ForYou"),
        Binding("2", "mode_following", "Following"),
        Binding("q", "quit", "退出"),
    ]

    def __init__(self):
        super().__init__()
        self.items = []
        self.mode = "foryou"

    def compose(self) -> ComposeResult:
        yield ListView(id="feed")
        yield Footer()

    def on_mount(self):
        self.title = "xtw · X 时间线"
        self.query_one("#feed", ListView).focus()
        self._load()

    def action_refresh(self):
        self._load()

    def action_mode_foryou(self):
        if self.mode != "foryou":
            self.mode = "foryou"
            self._load()

    def action_mode_following(self):
        if self.mode != "following":
            self.mode = "following"
            self._load()

    def action_quit(self):
        self.app.exit()

    @work
    async def _load(self):
        lv = self.query_one("#feed", ListView)
        lv.clear()
        lv.append(ListItem(Label("加载中…")))
        try:
            client = xtw.make_client()
            if self.mode == "following":
                result = await xtw.with_retry(lambda: client.get_latest_timeline(count=20))
                label = "Following"
            else:
                result = await xtw.with_retry(lambda: client.get_timeline(count=20))
                label = "For you"
            tweets = await xtw._iter_tweets(result, FEED_COUNT)
            lv.clear()
            self.items = tweets
            self.title = f"xtw · {label}"
            for i, t in enumerate(tweets, 1):
                if not getattr(t, "user", None):
                    continue  # 广告等无 author 的条目
                txt = Text()
                txt.append(f"[{i:>2}] ", style="dim")
                body = " ".join((t.full_text or t.text or "").split())
                imgs, vids = _media_blocks(t.retweeted_tweet or t)
                marks = f" [图x{len(imgs)}]" if imgs else ""
                marks += f" [视频x{vids}]" if vids else ""
                txt.append(body[:90] + ("…" if len(body) > 90 else ""), style="bold cyan")
                txt.append(marks, style="magenta")
                txt.append(f"\n     @{t.user.screen_name} · {t.user.name}", style="yellow")
                txt.append(
                    f"  ❤{t.favorite_count} 🔁{t.retweet_count} 💬{t.reply_count}",
                    style="dim",
                )
                lv.append(ListItem(Label(txt)))
        except Exception as e:
            lv.clear()
            lv.append(ListItem(Label(
                f"!! {type(e).__name__}: {e}\n（未登录或登录态失效：跑 xtw login）"
            )))

    def on_list_view_selected(self, event: ListView.Selected):
        idx = event.list_view.index
        if idx is None or not self.items or idx >= len(self.items):
            return
        shown = [t for t in self.items if getattr(t, "user", None)]
        if idx < len(shown):
            self.app.push_screen(TweetScreen(str(shown[idx].id)))


class XtwApp(App):
    CSS = """
    .post-text { padding: 0 0 1 0; }
    .comments-sep { color: gray; padding: 1 0; }
    .comment { padding-bottom: 1; border-bottom: dashed gray; }
    .stats { padding: 1 0; }
    .quote { padding: 0 0 1 2; }
    .dim { color: gray; }
    ImageBlock { border: round gray; padding: 0 1; margin: 0 0 1 0; }
    ImageBlock > CollapsibleTitle { color: magenta; }
    #status { color: gray; }
    """

    async def on_mount(self):
        self.push_screen(FeedScreen())


def run_tui():
    XtwApp().run()


if __name__ == "__main__":
    run_tui()
