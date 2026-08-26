#!/usr/bin/env python3
"""xhh — 终端刷小黑盒：借你已登录的 Chrome，纯文本输出，看起来像日志。

用法:
    xhh                 TUI 全屏界面（默认）：热榜 → 回车看帖 → 回车展开图片
    xhh browse          滚屏浏览模式：热榜 → 编号看帖 → 回车返回
    xhh feed [N]        刷社区热榜，列出前 N 条（默认 20）
    xhh post <id|url> [--art]   看帖子正文 + 评论（--art 图片用字符画）

原理:
    通过 CDP 连接你正在运行的 Chrome（读取 DevToolsActivePort），
    复用小黑盒标签页的登录态。不另起浏览器、不发可疑请求，
    对网站来说就是"你自己点开了一个标签页"。
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

import websockets

# ---- ANSI 颜色（Windows 终端需开启 VT 处理）----
def _enable_ansi():
    if os.name == "nt":
        try:
            import ctypes
            h = ctypes.windll.kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_ulong()
            ctypes.windll.kernel32.GetConsoleMode(h, ctypes.byref(mode))
            ctypes.windll.kernel32.SetConsoleMode(h, mode.value | 0x4)
        except Exception:
            pass


class C:
    """颜色常量；非 TTY（管道/重定向）时全部置空。"""
    pass


if sys.stdout and sys.stdout.isatty():
    _enable_ansi()
    C.RESET = "\033[0m"
    C.TITLE = "\033[1;36m"   # 标题：亮青
    C.AUTHOR = "\033[33m"    # 作者：黄
    C.META = "\033[2m"       # 元信息：暗
    C.CNAME = "\033[36m"     # 评论者：青
    C.LIKES = "\033[1;35m"   # 赞数：亮紫
    C.REPLY = "\033[2;37m"   # 楼中楼：暗白
    C.SEP = "\033[2m"        # 分隔线：暗
else:
    for k in ("RESET", "TITLE", "AUTHOR", "META", "CNAME", "LIKES", "REPLY", "SEP"):
        setattr(C, k, "")

PORT_FILE = Path.home() / "AppData/Local/Google/Chrome/User Data/DevToolsActivePort"
HOME_URL = "https://www.xiaoheihe.cn/app/bbs/home"
POST_URL = "https://www.xiaoheihe.cn/app/bbs/link/{}"

FEED_JS = """JSON.stringify([...document.querySelectorAll('a[href*="/bbs/link/"]')]
  .map(a => ({
    href: a.getAttribute('href'),
    lines: a.innerText.split('\\n').map(s => s.trim()).filter(Boolean)
  })))"""

HEAD_JS = r"""
(() => {
  const qs = (sel) => document.querySelector(sel);
  const qc = (el, sel) => el ? el.querySelector(sel) : null;
  const txt = (el) => el ? el.innerText.trim().replace(/\n/g, ' ') : '';
  const head = qs('.hb-bbs-image-text') || qs('.image-text__container') || qs('.hb-bbs-link__content');
  const data = {
    title: txt(qs('.link-section-title')) || txt(qs('.section-title__content')),
    author: txt(qc(head, '.info-box__username')) || txt(qs('.page-header__user-wrapper')),
    level: txt(qc(head, '.info-box__level')),
    meta: txt(qc(head, '.info-box__line-2')),
    blocks: [
      // 题图画廊（meme/截图大多在这里）
      ...[...document.querySelectorAll('.header-image__item-image img')]
        .map(i => ({ type: 'img', src: i.currentSrc || i.src }))
        .filter(b => b.src.startsWith('http')),
      // 正文文字与内嵌图按原顺序
      ...[...document.querySelectorAll('.image-text__content')].flatMap(e => {
        const out = [];
        const walk = (node) => {
          for (const ch of node.childNodes) {
            if (ch.nodeType === 3) {
              const t = ch.textContent.trim();
              if (t) out.push({ type: 'text', text: t });
            } else if (ch.nodeType === 1) {
              if (ch.tagName === 'IMG') {
                const src = ch.src || ch.dataset.src || '';
                if (src.startsWith('http')) out.push({ type: 'img', src });
              } else walk(ch);
            }
          }
        };
        walk(e);
        return out;
      }),
    ],
    page_head: document.body ? document.body.innerText.slice(0, 400) : '',
  };
  // 兜底：等级/时间地点没匹配到时，从头部文本行里解析
  if (head && (!data.level || !data.meta)) {
    const lines = head.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    const ti = lines.findIndex(l => /^Lv\./.test(l));
    if (ti >= 0) {
      if (!data.level) data.level = lines[ti];
      if (!data.meta) data.meta = lines.slice(ti + 1, ti + 3).join(' ').replace(/\s*关注\s*$/, '').trim();
    }
  }
  return JSON.stringify(data);
})()
"""

COMMENTS_JS = r"""
(() => {
  const qc = (el, sel) => el ? el.querySelector(sel) : null;
  const txt = (el) => el ? el.innerText.trim().replace(/\n/g, ' ') : '';
  return JSON.stringify({
    total: txt(document.querySelector('.comment__comment-header')),
    comments: [...document.querySelectorAll('.link-comment__comment-item')].map(it => ({
      name: txt(qc(it, '.info-box__username')),
      level: txt(qc(it, '.info-box__level')),
      likes: txt(qc(it, '.comment-item-header__operation-box')),
      time: txt(qc(it, '.info-box__line-2')),
      content: txt(it.querySelector('.comment-item__content')),
      images: [...it.querySelectorAll('.comment-item__image img')]
        .map(i => i.currentSrc || i.src).filter(s => s.startsWith('http')),
      replies: [...it.querySelectorAll('.comment-children-item')].map(r => ({
        name: txt(qc(r, '.children-item__comment-creator')),
        reply_to: txt(qc(r, '.children-item__reply-to')).replace(/^回复\s*|[:：]\s*$/g, '').trim(),
        content: txt(qc(r, '.children-item__comment-content')),
      })),
      more: txt(qc(it, '.comment-children__load-all')),
    })),
  });
})()
"""

CAPTCHA_MARKERS = ("安全验证", "请依次点击", "操作过于频繁")

FALLBACK_JS = r"""
(() => {
  // 结构化选择器全部失配时的兜底：document.title + 全文粗暴截取
  let title = (document.title || '').replace(/[-_|]?\s*小黑盒.*$/, '').trim();
  let text = document.body ? document.body.innerText : '';
  const cutStart = text.indexOf('返回\n');
  if (cutStart >= 0) text = text.slice(cutStart + 3);
  const cutEnd = text.indexOf('立即下载小黑盒APP');
  if (cutEnd >= 0) text = text.slice(0, cutEnd);
  return JSON.stringify({
    title,
    author: '', level: '', meta: '',
    blocks: [{ type: 'text', text: text.trim() }],
    total: '', comments: [],
    page_head: text.slice(0, 400),
  });
})()
"""

EXPAND_JS = r"""
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let clicked = 0;
  // 逐轮点开「全部 N 条回复」，直到没有可点的为止
  for (let round = 0; round < 8; round++) {
    const btns = [...document.querySelectorAll('.comment-children__load-all')];
    if (!btns.length) break;
    for (const b of btns) { b.click(); clicked++; }
    await sleep(1000);
  }
  return clicked;
})()
"""


class CDP:
    """最小 CDP 客户端：连浏览器级 WebSocket，按 sessionId 收发。"""

    def __init__(self):
        self._id = 0
        self.ws = None
        self._lock = None

    async def connect(self):
        port, path = PORT_FILE.read_text().splitlines()[:2]
        url = f"ws://127.0.0.1:{port}{path}"
        last_err = None
        # Chrome 忙时握手偶尔会超时，重试几次即可
        for _ in range(4):
            try:
                self.ws = await websockets.connect(
                    url, max_size=64 * 1024 * 1024, open_timeout=10
                )
                self._lock = asyncio.Lock()
                return
            except Exception as e:
                last_err = e
                await asyncio.sleep(1)
        raise last_err

    async def call(self, method, params=None, session=None):
        async with self._lock:  # websockets 不允许并发 recv，串行化所有协议交换
            self._id += 1
            mid = self._id
            msg = {"id": mid, "method": method, "params": params or {}}
            if session:
                msg["sessionId"] = session
            await self.ws.send(json.dumps(msg))
            while True:
                data = json.loads(await self.ws.recv())
                if data.get("id") == mid:
                    if "error" in data:
                        raise RuntimeError(data["error"].get("message", data["error"]))
                    return data.get("result", {})

    async def eval_js(self, session, expression):
        r = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True},
            session,
        )
        return r.get("result", {}).get("value")

    async def eval_await_js(self, session, expression):
        """执行返回 Promise 的 JS 并等待结果。"""
        r = await self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            session,
        )
        return r.get("result", {}).get("value")

    async def close(self):
        if self.ws:
            await self.ws.close()


async def attach_xhh_tab(cdp):
    """找已开的小黑盒标签页；没有就在后台新开一个。"""
    targets = (await cdp.call("Target.getTargets"))["targetInfos"]
    page = next(
        (t for t in targets if t["type"] == "page" and "xiaoheihe.cn" in t.get("url", "")),
        None,
    )
    if page is None:
        page = await cdp.call("Target.createTarget", {"url": HOME_URL, "active": False})
    r = await cdp.call(
        "Target.attachToTarget", {"targetId": page["targetId"], "flatten": True}
    )
    return r["sessionId"]


async def goto_and_wait(cdp, session, url, ready_js, timeout=25):
    """导航并轮询页面就绪。ready_js 返回真值即算就绪。
    先等旧 DOM 失效（URL 变化或文档重新加载），避免命中上一个页面的残留内容。"""
    await cdp.call("Page.navigate", {"url": url}, session)
    # 至少等一个周期，让旧页面开始卸载
    await asyncio.sleep(0.6)
    for _ in range(int(timeout * 2)):
        await asyncio.sleep(0.5)
        try:
            if await cdp.eval_js(session, ready_js):
                return True
        except RuntimeError:
            pass  # 导航期间执行上下文短暂失效
    return False


def check_captcha(text):
    if any(m in text for m in CAPTCHA_MARKERS):
        print("!! 触发了网站安全验证：请到 Chrome 的小黑盒标签页手动完成验证，再重新执行命令。")
        sys.exit(2)


# ---- 图片 → ANSI 真彩字符画 ----
def _download(url, timeout=15):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def img_to_ansi(data, max_w=None, max_h=40):
    """每个字符用前景色画上半像素、背景色画下半像素（▀）。
    宽度默认取终端列数（上限 200），LANCZOS 采样保细节。"""
    import io
    import shutil
    from PIL import Image
    if max_w is None:
        max_w = min(shutil.get_terminal_size((100, 40)).columns - 2, 200)
    im = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = im.size
    cols = max(1, min(max_w, w))
    rows = max(1, min(max_h, int(h / w * cols * 0.5)))
    im = im.resize((cols, rows * 2), Image.LANCZOS)
    px = im.load()
    lines = []
    for y in range(0, rows * 2, 2):
        buf = []
        for x in range(cols):
            r1, g1, b1 = px[x, y]
            r2, g2, b2 = px[x, y + 1]
            buf.append(f"\033[38;2;{r1};{g1};{b1}m\033[48;2;{r2};{g2};{b2}m▀")
        lines.append("".join(buf) + "\033[0m")
    return "\n".join(lines)


async def prefetch_images(urls, limit=4):
    """并发预下载图片，返回 {url: bytes|None}。"""
    sem = asyncio.Semaphore(limit)

    async def one(u):
        async with sem:
            try:
                return u, await asyncio.to_thread(_download, u)
            except Exception:
                return u, None

    return dict(await asyncio.gather(*(one(u) for u in urls)))


def render_image_data(url, data):
    """TTY 下渲染字符画；否则降级为链接占位。"""
    if not sys.stdout.isatty():
        print(f"   [图片: {url}]")
        return
    if data is None:
        print(f"   {C.META}[图片加载失败: {url}]{C.RESET}")
        return
    try:
        print(img_to_ansi(data))
    except Exception as e:
        print(f"   {C.META}[图片解码失败: {url} ({e})]{C.RESET}")


def post_id_of(s):
    m = re.search(r"(\d{6,}|[0-9a-f]{12,})", s)
    return m.group(1) if m else None


async def fetch_feed(cdp, count):
    """抓热榜，返回 [{num, pid, title, author}]，失败抛 RuntimeError。"""
    session = await attach_xhh_tab(cdp)
    ok = await goto_and_wait(
        cdp, session, HOME_URL, "document.querySelectorAll('a[href*=\"/bbs/link/\"]').length > 0"
    )
    if not ok:
        raise RuntimeError("热榜加载超时")
    items = json.loads(await cdp.eval_js(session, FEED_JS) or "[]")
    if not items:
        raise RuntimeError("没抓到热榜条目，可能页面结构变了")

    seen, listing = set(), []
    for it in items:
        pid = post_id_of(it["href"] or "")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        lines = it["lines"]
        if len(lines) < 2:
            continue
        author = lines[0]
        title = lines[1]
        ti = 1
        for i, ln in enumerate(lines):
            if re.match(r"^Lv\.", ln) and i + 1 < len(lines):
                title = lines[i + 1]
                ti = i + 1
                break
        # 摘要：标题之后的第一个非标签、非统计数字的行
        summary = ""
        for ln in lines[ti + 1:]:
            if re.fullmatch(r"\d+", ln) or len(ln) <= 4:
                continue  # 跳过点赞/评论数和短标签
            summary = ln[:60] + ("…" if len(ln) > 60 else "")
            break
        listing.append({"num": len(listing) + 1, "pid": pid, "title": title,
                        "author": author, "summary": summary})
        if len(listing) >= count:
            break
    return listing


def print_feed(listing):
    for it in listing:
        print(f"{C.META}[{it['num']:>2}]{C.RESET} {C.TITLE}{it['title']}{C.RESET}")
        if it.get("summary"):
            print(f"     {it['summary']}")
        print(f"     {C.META}{it['author']} · id {it['pid']}{C.RESET}")


async def fetch_post_head(cdp, pid):
    """第一阶段：导航并提取标题/作者/正文（含图），失败抛 RuntimeError。"""
    session = await attach_xhh_tab(cdp)
    data = None
    for attempt in range(2):  # 首次失败重载一次再试
        await goto_and_wait(
            cdp, session, POST_URL.format(pid),
            "document.querySelector('.link-section-title,.section-title__content') !== null"
            " || (document.body && document.body.innerText.includes('全部评论'))"
            " || (document.body && document.body.innerText.includes('暂无内容'))",
        )
        data = json.loads(await cdp.eval_js(session, HEAD_JS) or "{}")
        if any(m in data.get("page_head", "") for m in CAPTCHA_MARKERS):
            raise RuntimeError("CAPTCHA")
        if data.get("title"):
            break
        if attempt == 0:
            await cdp.call("Page.reload", {"ignoreCache": True}, session)
            await asyncio.sleep(1)
    if any(m in data.get("page_head", "") for m in CAPTCHA_MARKERS):
        raise RuntimeError("CAPTCHA")

    # 结构化提取失败时降级：标题用 document.title，正文用全文粗暴截取
    if not data.get("title"):
        fb = json.loads(await cdp.eval_js(session, FALLBACK_JS) or "{}")
        if not fb.get("title"):
            raise RuntimeError(
                "帖子页未渲染：大概率是接口要求人机验证。"
                "请在 Chrome 的小黑盒标签页手动打开这篇帖子，完成弹出的验证后重试"
            )
        fb["crude"] = True
        data = fb
    return data


async def fetch_post_comments(cdp, pid):
    """第二阶段：在当前页面展开楼中楼并提取评论。页面应已在目标帖上。"""
    session = await attach_xhh_tab(cdp)
    expanded = await cdp.eval_await_js(session, EXPAND_JS)
    data = json.loads(await cdp.eval_js(session, COMMENTS_JS) or "{}")
    data["expanded"] = expanded or 0
    return data


def osc8(url, text):
    """终端超链接（OSC 8）：Windows Terminal / 现代终端 Ctrl+Click 打开。"""
    return f"\033]8;;{url}\033\\{text}\033]8;;\033\\"


# ---- 图片 OCR：把图里文字直接打成文本（最摸鱼的看图方式）----
OCR_SCRIPT = Path(__file__).with_name("ocr.ps1")


def _ocr_png(png_path):
    import subprocess
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", str(OCR_SCRIPT), "-Path", str(png_path)],
        capture_output=True, timeout=60,
    )
    try:
        return json.loads(r.stdout.decode("utf-8", "replace").strip() or "{}")
    except json.JSONDecodeError:
        return {}


def _ocr_image_data(data):
    """OCR 一张图，返回 {text, chars, words, confidence}。"""
    import io
    import os
    import tempfile
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert("RGB")
    fd, tmp = tempfile.mkstemp(suffix=".png")
    try:
        with os.fdopen(fd, "wb") as f:
            im.save(f, "PNG")
        return _ocr_png(tmp)
    finally:
        os.unlink(tmp)


def is_text_image(ocr_result):
    """OCR 产出判断是否为文字为主的图片。
    注意：中文 OCR 引擎置信度恒为 0（不填），只能靠字数/词数判断。"""
    return (ocr_result.get("chars", 0) >= 10
            and ocr_result.get("words", 0) >= 3)


async def ocr_images(imgs, limit=3):
    """对 {url: bytes|None} 并发 OCR，返回 {url: 文本}。"""
    sem = asyncio.Semaphore(limit)

    async def one(u, data):
        if data is None:
            return u, {}
        async with sem:
            try:
                return u, await asyncio.to_thread(_ocr_image_data, data)
            except Exception:
                return u, {}

    return dict(await asyncio.gather(*(one(u, d) for u, d in imgs.items())))


async def print_head(data, art=False):
    author_line = " · ".join(x for x in (data.get("author"), data.get("level"), data.get("meta")) if x)
    print(f"{C.SEP}{'=' * 60}{C.RESET}")
    print(f"{C.TITLE}{data['title']}{C.RESET}")
    if author_line:
        print(f"{C.AUTHOR}{author_line}{C.RESET}")
    print(f"{C.SEP}{'=' * 60}{C.RESET}")

    blocks = data.get("blocks", [])
    img_urls = [b["src"] for b in blocks if b.get("type") == "img"]
    imgs, ocr_texts = {}, {}
    if img_urls and sys.stdout.isatty():
        imgs = await prefetch_images(img_urls)
        if not art:
            ocr_texts = await ocr_images(imgs)
    img_no = 0
    for block in blocks:
        if block.get("type") == "img":
            img_no += 1
            src = block["src"]
            if art:
                render_image_data(src, imgs.get(src))
            else:
                ocr = ocr_texts.get(src, {})
                if is_text_image(ocr):
                    print(f"   {C.LIKES}[图{img_no}]{C.RESET} {C.META}{osc8(src, '原图')}{C.RESET}")
                    for line in ocr.get("text", "").splitlines():
                        if line.strip():
                            print(f"   {C.META}│ {line}{C.RESET}")
                else:
                    print(f"   {C.LIKES}[图{img_no}]{C.RESET} {C.META}{osc8(src, 'Ctrl+点击看原图')}{C.RESET}")
        else:
            print(block.get("text", ""))
        print()


def print_comments(data):
    if data.get("crude"):
        return
    if data.get("expanded"):
        print(f"{C.META}(展开了 {data['expanded']} 组楼中楼回复){C.RESET}")
    comments = data.get("comments", [])
    total = data.get("total") or "全部评论"
    print(f"{C.SEP}-- {total} {'-' * max(4, 50 - len(total))}{C.RESET}")
    for i, c in enumerate(comments, 1):
        head_parts = [f"{C.META}#{i}{C.RESET}", f"{C.CNAME}{c.get('name') or '匿名'}{C.RESET}"]
        if c.get("level"):
            head_parts.append(f"{C.META}{c['level']}{C.RESET}")
        if c.get("time"):
            head_parts.append(f"{C.META}{c['time']}{C.RESET}")
        if c.get("likes") and c["likes"] != "0":
            head_parts.append(f"{C.LIKES}{c['likes']}赞{C.RESET}")
        print(" ".join(head_parts))
        if c.get("content"):
            print(f"   {c['content']}")
        for img in c.get("images", []):
            print(f"   {C.META}[图] {osc8(img, 'Ctrl+点击看原图')}{C.RESET}")
        for r in c.get("replies", []):
            who = r.get("name") or "匿名"
            if r.get("reply_to"):
                who += f" 回复 {r['reply_to']}"
            print(f"   {C.REPLY}↳ {who}: {r.get('content', '')}{C.RESET}")
        if c.get("more"):
            print(f"   {C.META}（{c['more']}）{C.RESET}")
    print(f"{C.SEP}-- 完 {'-' * 53}{C.RESET}")


# ---- 守护进程客户端：一条 CDP 连接常驻，Chrome 只确认一次 ----
DAEMON_PORT = 19812
DAEMON_SCRIPT = Path(__file__).with_name("xhh_daemon.py")


async def daemon_call(payload, timeout=180):
    reader, writer = await asyncio.open_connection("127.0.0.1", DAEMON_PORT)
    try:
        writer.write((json.dumps(payload) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout)
        return json.loads(line.decode())
    finally:
        writer.close()


def _code_mtime():
    return max(Path(__file__).stat().st_mtime, DAEMON_SCRIPT.stat().st_mtime)


async def ensure_daemon():
    """守护进程不在就拉起它（首次拉起时 Chrome 会弹一次调试确认）。
    已在运行但代码版本不一致时，先让它退出再拉起新的。"""
    try:
        resp = await daemon_call({"cmd": "ping"}, timeout=3)
        if resp.get("mtime") == _code_mtime():
            return
        # 代码已更新：旧守护进程退出
        try:
            await daemon_call({"cmd": "stop"}, timeout=3)
        except Exception:
            pass
        await asyncio.sleep(1)
    except Exception:
        pass
    import subprocess
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    subprocess.Popen(
        [str(pythonw if pythonw.exists() else sys.executable), str(DAEMON_SCRIPT)],
        cwd=str(DAEMON_SCRIPT.parent),
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    for _ in range(70):
        await asyncio.sleep(1)
        try:
            await daemon_call({"cmd": "ping"}, timeout=3)
            return
        except Exception:
            continue
    print("!! 守护进程启动失败：确认 Chrome 正在运行后重试（Chrome 调试监听器偶发卡死，chrome://restart 可解）。")
    sys.exit(1)


async def run_via_daemon(cmd, **kw):
    resp = await daemon_call({"cmd": cmd, **kw})
    if not resp.get("ok"):
        err = resp.get("error", "未知错误")
        if err == "CAPTCHA":
            print("!! 触发了网站安全验证：请到 Chrome 的小黑盒标签页手动完成验证，再重新执行命令。")
            sys.exit(2)
        print(f"!! {err}")
        return None
    return resp.get("data")


async def stream_post(pid, art=False):
    """两段式看帖：先出标题正文，评论随后补。art=True 时图片渲染为字符画。"""
    head = await run_via_daemon("post_head", pid=pid)
    if not head:
        return
    await print_head(head, art=art)
    comments = await run_via_daemon("post_comments", pid=pid)
    if comments:
        comments["crude"] = head.get("crude", False)
        print_comments(comments)


async def cmd_browse(count=20):
    """交互浏览：走常驻守护进程，Chrome 只确认一次。
    回车返回当前热榜（不刷新），输入 r 才重新拉取。"""
    print("xhh 浏览模式 —— 编号看帖，回车返回热榜，0 刷新，q 退出\n")
    listing = None
    while True:
        if listing is None:
            listing = await run_via_daemon("feed", count=count)
            if not listing:
                return
        print_feed(listing)
        try:
            choice = (await asyncio.to_thread(input, "\n看哪篇? [编号/回车返回/0刷新/q] ")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if choice.lower() in ("q", "quit", "exit"):
            return
        if not choice:
            continue  # 回车：重印当前热榜，不刷新
        if choice.lower() == "0":
            listing = None  # 下一轮重新拉取
            continue
        if choice.isdigit():
            pid = next((it["pid"] for it in listing if it["num"] == int(choice)), None)
            if pid is None:
                print("!! 编号超出范围")
                continue
        else:
            pid = post_id_of(choice)
            if pid is None:
                print("!! 输入编号或帖子 id/链接")
                continue
        await stream_post(pid)
        try:
            await asyncio.to_thread(input, "\n[回车返回热榜] ")
        except (EOFError, KeyboardInterrupt):
            print()
            return


HELP = __doc__.strip()


async def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(HELP)
        return

    if args and args[0] == "stop":
        try:
            await daemon_call({"cmd": "stop"}, timeout=3)
            print("守护进程已停止。")
        except Exception:
            print("守护进程未在运行。")
        return

    await ensure_daemon()

    if not args or args[0] == "tui":
        # 裸 xhh 默认进 TUI 全屏界面
        n = int(args[1]) if len(args) > 1 else 20
        from xhh_tui import XhhApp
        await XhhApp(n).run_async()
        return
    if args[0] in ("browse", "b"):
        n = int(args[1]) if len(args) > 1 else 20
        await cmd_browse(n)
    elif args[0] == "feed":
        n = int(args[1]) if len(args) > 1 else 20
        listing = await run_via_daemon("feed", count=n)
        if listing:
            print_feed(listing)
    elif args[0] == "post":
        if len(args) < 2:
            print("用法: xhh post <id|url> [--art]")
            return
        pid = post_id_of(args[1])
        if not pid:
            print(f"!! 无法从 '{args[1]}' 解析帖子 id")
            return
        await stream_post(pid, art="--art" in args[2:])
    else:
        print(HELP)


if __name__ == "__main__":
    if sys.stdout:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    asyncio.run(main())
