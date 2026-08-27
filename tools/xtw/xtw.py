# -*- coding: utf-8 -*-
"""xtw —— 终端刷 X(Twitter)

用法:
    xtw                 进入 TUI（默认）
    xtw login           从调试浏览器(127.0.0.1:9222)导出 X 登录 cookie，存到 %LOCALAPPDATA%\\xtw
    xtw feed [N]        滚屏打印 "For you" 时间线（默认 20 条）
    xtw latest [N]      滚屏打印 "Following" 时间线
    xtw tweet <id>      查看推文全文 + 回复
    xtw search <词>     搜索（Latest）
    xtw trends          趋势榜
    xtw proxy [url]     查看/设置代理（默认 http://127.0.0.1:7897）

登录只依赖调试浏览器一次：cookie 导出后独立走 HTTP，不再需要浏览器。
网络请求默认走本地代理 7897（X 在国内需代理），可用 XTW_PROXY 环境变量覆盖。
"""
import asyncio
import json
import os
import sys
import time

DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", "."), "xtw")
COOKIE_FILE = os.path.join(DATA_DIR, "cookies.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
DEFAULT_PROXY = "http://127.0.0.1:7897"

CDP_PORT = int(os.environ.get("XTW_CDP_PORT", "9222"))


def _load_config() -> dict:
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_config(cfg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def get_proxy() -> str:
    return os.environ.get("XTW_PROXY") or _load_config().get("proxy") or DEFAULT_PROXY


def load_cookies() -> dict:
    try:
        with open(COOKIE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cookies(cookies: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(COOKIE_FILE, "w", encoding="utf-8") as f:
        json.dump(cookies, f, ensure_ascii=False, indent=2)


def make_client():
    """构造已登录的 twikit Client；未导出 cookie 时报清晰错误。"""
    from twikit import Client

    cookies = load_cookies()
    if not cookies.get("auth_token") or not cookies.get("ct0"):
        raise RuntimeError(
            "还没有 X 登录 cookie。先在调试浏览器里登录 x.com，再跑: xtw login"
        )
    client = Client("zh-CN", proxy=get_proxy())
    client.set_cookies(cookies)
    return client


# ---------- cookie 导出（CDP） ----------

async def export_cookies(port: int = CDP_PORT) -> dict:
    import websockets
    import urllib.request

    with urllib.request.urlopen(
        f"http://127.0.0.1:{port}/json/version", timeout=5
    ) as r:
        ws_url = json.load(r)["webSocketDebuggerUrl"]

    async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                all_cookies = msg["result"]["cookies"]
                break

    picked = {
        c["name"]: c["value"]
        for c in all_cookies
        if "twitter.com" in c.get("domain", "") or "x.com" in c.get("domain", "")
    }
    return picked


async def with_retry(fn, tries: int = 3):
    """网络抖动（代理 TLS 握手偶发失败）自动重试，仅针对传输层错误。"""
    import httpx

    for i in range(tries):
        try:
            return await fn()
        except (httpx.TransportError, ConnectionError, TimeoutError):
            if i == tries - 1:
                raise
            await asyncio.sleep(1.5 * (i + 1))


async def cmd_login(port: int) -> None:
    cookies = await export_cookies(port)
    if not cookies.get("auth_token") or not cookies.get("ct0"):
        print("!! 没拿到 auth_token/ct0：调试浏览器里的 x.com 还没登录。")
        print("   请先在调试浏览器（127.0.0.1:%d）里登录 X，再重跑 xtw login" % port)
        sys.exit(1)
    # 用代理验证一下 cookie 真的可用（拉一条时间线即可）
    from twikit import Client

    client = Client("zh-CN", proxy=get_proxy())
    client.set_cookies(cookies)
    try:
        await with_retry(lambda: client.get_latest_timeline(count=1))
        print(">> 登录态验证通过（时间线可拉取）")
    except Exception as e:
        print(f"!! cookie 已导出但验证失败（可能是代理问题）: {e}")
        print("   cookie 仍已保存，可稍后重试 xtw feed")
    save_cookies(cookies)
    print(f">> cookie 已保存到 {COOKIE_FILE}（共 {len(cookies)} 条）")
    print("   之后刷推不再需要浏览器；cookie 过期后重跑 xtw login 即可")


# ---------- 数据格式化 ----------

def fmt_tweet_line(t) -> str:
    user = t.user
    text = " ".join((t.full_text or t.text or "").split())
    media = ""
    if t.media:
        n_img = sum(1 for m in t.media if m.type == "photo")
        n_vid = len(t.media) - n_img
        media = f" [图x{n_img}]" if n_img else ""
        media += f" [视频x{n_vid}]" if n_vid else ""
    return f"@{user.screen_name} {user.name}: {text}{media}"


def fmt_tweet_detail(t) -> str:
    user = t.user
    lines = [
        f"@{user.screen_name}  {user.name}  ·  {t.created_at}",
        "",
        t.full_text or t.text or "",
        "",
    ]
    if t.media:
        for i, m in enumerate(t.media, 1):
            kind = "图" if m.type == "photo" else "视频"
            lines.append(f"[{kind}{i}] {m.media_url}")
    stats = (
        f"❤ {t.favorite_count}  🔁 {t.retweet_count}  "
        f"💬 {t.reply_count}  👁 {getattr(t, 'view_count', '?')}"
    )
    lines += ["", stats]
    return "\n".join(lines)


async def _iter_tweets(result, limit: int):
    """遍历 Result[Tweet]，自动翻页，最多 limit 条。"""
    out = []
    r = result
    while r and len(out) < limit:
        batch = list(r)
        if not batch:
            break
        out.extend(batch)
        if len(out) >= limit:
            break
        try:
            r = await r.next()
        except Exception:
            break
    return out[:limit]


# ---------- 子命令 ----------

async def cmd_feed(count: int, latest: bool = False) -> None:
    client = make_client()
    if latest:
        result = await with_retry(lambda: client.get_latest_timeline(count=min(count, 20)))
    else:
        result = await with_retry(lambda: client.get_timeline(count=min(count, 20)))
    tweets = await _iter_tweets(result, count)
    for i, t in enumerate(tweets, 1):
        print(f"[{i:2}] {fmt_tweet_line(t)}  ·id {t.id}")


async def get_tweet_by_id(client, tweet_id: str):
    """修复版 get_tweet_by_id：fork 里 cursor 条目结构变了会 KeyError，
    这里兼容 content.value 与 content.itemContent.value 两种格式。"""
    from functools import partial

    from twikit.errors import TweetNotAvailable
    from twikit.tweet import tweet_from_data
    from twikit.utils import Result, find_dict

    response, _ = await client.gql.tweet_detail(tweet_id, None)
    if "errors" in response:
        raise TweetNotAvailable(response["errors"][0]["message"])

    entries = find_dict(response, "entries", find_one=True)[0]
    reply_to, replies_list, tweet = [], [], None

    for entry in entries:
        if entry["entryId"].startswith("cursor"):
            continue
        tweet_object = tweet_from_data(client, entry)
        if tweet_object is None:
            continue
        if entry["entryId"].startswith("tweetdetailrelatedtweets"):
            continue
        if entry["entryId"] == f"tweet-{tweet_id}":
            tweet = tweet_object
        else:
            if tweet is None:
                reply_to.append(tweet_object)
            else:
                replies, sr_cursor, show_replies = [], None, None
                for reply in entry["content"]["items"][1:]:
                    if "tweetcomposer" in reply["entryId"]:
                        continue
                    if "tweet" in reply.get("entryId"):
                        rpl = tweet_from_data(client, reply)
                        if rpl is not None:
                            replies.append(rpl)
                    if "cursor" in reply.get("entryId"):
                        c = reply.get("item", {}).get("itemContent") or {}
                        sr_cursor = c.get("value")
                        show_replies = partial(
                            client._show_more_replies, tweet_id, sr_cursor
                        )
                tweet_object.replies = Result(replies, show_replies, sr_cursor)
                replies_list.append(tweet_object)

    if tweet is None:
        raise TweetNotAvailable(f"tweet {tweet_id} not found in response")

    last = entries[-1]
    if last["entryId"].startswith("cursor"):
        c = last["content"].get("itemContent") or last["content"]
        reply_next_cursor = c.get("value")
        _fetch = partial(client._get_more_replies, tweet_id, reply_next_cursor)
    else:
        reply_next_cursor, _fetch = None, None

    tweet.replies = Result(replies_list, _fetch, reply_next_cursor)
    tweet.reply_to = reply_to
    return tweet


async def cmd_tweet(tweet_id: str) -> None:
    client = make_client()
    t = await with_retry(lambda: get_tweet_by_id(client, tweet_id))
    print(fmt_tweet_detail(t))
    if t.replies:
        print("\n-- 回复 " + "-" * 40)
        replies = await with_retry(lambda: _iter_tweets(t.replies, 30)) or []
        for r in replies:
            print(f"  @{r.user.screen_name}: {' '.join((r.full_text or '').split())}")


async def cmd_search(query: str, count: int = 20) -> None:
    client = make_client()
    # fork 的 Top 搜索接口 hash 已失效（404），用 Latest
    result = await with_retry(lambda: client.search_tweet(query, "Latest", count=min(count, 20)))
    tweets = await _iter_tweets(result, count)
    for i, t in enumerate(tweets, 1):
        print(f"[{i:2}] {fmt_tweet_line(t)}  ·id {t.id}")


async def cmd_trends() -> None:
    client = make_client()
    trends = await with_retry(lambda: client.get_trends("trending"))
    for i, tr in enumerate(trends[:20], 1):
        print(f"[{i:2}] {tr.name}")


async def cmd_proxy(arg: str | None) -> None:
    cfg = _load_config()
    if arg is None:
        print(f"当前代理: {get_proxy()}")
        return
    cfg["proxy"] = arg
    _save_config(cfg)
    print(f">> 代理已设置为 {arg}")


def main() -> None:
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if not args:
        from xtw_tui import run_tui

        run_tui()
        return

    cmd, rest = args[0], args[1:]
    if cmd == "login":
        port = int(rest[0]) if rest else CDP_PORT
        asyncio.run(cmd_login(port))
    elif cmd == "feed":
        asyncio.run(cmd_feed(int(rest[0]) if rest else 20))
    elif cmd == "latest":
        asyncio.run(cmd_feed(int(rest[0]) if rest else 20, latest=True))
    elif cmd == "tweet":
        if not rest:
            print("用法: xtw tweet <id>")
            sys.exit(1)
        asyncio.run(cmd_tweet(rest[0]))
    elif cmd == "search":
        if not rest:
            print("用法: xtw search <关键词>")
            sys.exit(1)
        asyncio.run(cmd_search(" ".join(rest)))
    elif cmd == "trends":
        asyncio.run(cmd_trends())
    elif cmd == "proxy":
        asyncio.run(cmd_proxy(rest[0] if rest else None))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
