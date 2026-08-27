# xtw —— 终端刷 X(Twitter)

纯文本终端里刷 X 的摸鱼工具，界面看起来像普通命令行输出。

与 xhh 不同：**不依赖浏览器运行**。首次在调试浏览器里登录一次 X、导出
cookie（`auth_token`/`ct0`）到 `%LOCALAPPDATA%\xtw\cookies.json`，之后所有
请求直接走 HTTP（twikit，X 内部 GraphQL 接口），直到 cookie 被 X 过期。

## 用法

```
xtw                TUI 全屏界面（默认）
xtw feed [N]       滚屏打印 "For you" 时间线（默认 20 条）
xtw latest [N]     滚屏打印 "Following" 时间线
xtw tweet <id>     推文全文 + 回复
xtw search <词>    搜索（Latest）
xtw trends         趋势榜
xtw login          从调试浏览器(127.0.0.1:9222)导出 cookie（一次性）
xtw proxy [url]    查看/设置代理（默认 http://127.0.0.1:7897）
```

## TUI 键位

| 键 | 作用 |
| --- | --- |
| ↑/↓ | 选择推文 |
| 回车 | 看推文 / 展开折叠图片 |
| b / 退格 | 返回时间线 |
| 0 | 刷新 |
| 1 / 2 | "For you" / "Following" 切换 |
| q | 退出 |

图片默认折叠成 `[图N]`，回车下载原图并弹出无边框查看窗（滚轮缩放、
左键拖动、Esc 或单击关闭，复用 `../xhh/show-image.ps1`）。视频只显示
`[视频xN]` 标记，不播放。

## 网络与代理

X 在国内需代理，默认走 `http://127.0.0.1:7897`（本地 Clash）。可用
`xtw proxy <url>` 或环境变量 `XTW_PROXY` 覆盖。代理 TLS 握手偶发抖动，
所有网络调用已内置自动重试。

## 登录（一次性）

1. 启动调试浏览器（专用 profile + CDP 端口 9222，脚本见仓库外约定）。
2. 在里面登录 x.com（建议邮箱+X 密码；Google 一键登录会被 Google 以
   "浏览器不安全" 拦截，若账号没有 X 密码先走"忘记密码"设置一个）。
3. 运行 `xtw login`：通过 CDP `Storage.getCookies` 导出 x.com/twitter.com
   的 cookie 存到 `%LOCALAPPDATA%\xtw\cookies.json`，并拉一条时间线验证。
4. 之后刷推不再需要浏览器。cookie 过期后重跑 `xtw login` 即可。

## 依赖与已知坑

- [twikit](https://github.com/d60/twikit) 免 API key 的 X 爬虫库。
  **上游 d60/twikit 已停更**，2026-03 X 改签名后出现
  `Couldn't get KEY_BYTE indices`（issue #409），本工具固定使用维护中的
  fork [unclecode/twikit](https://github.com/unclecode/twikit)
  （见 `pyproject.toml` 的 `[tool.uv.sources]`）。
- fork 里 `get_tweet_by_id` 对新版 cursor 条目结构会 `KeyError`，
  `xtw.py` 内置了修复版（兼容 `content.value` / `content.itemContent.value`）。
- fork 的 Top 搜索接口 hash 已失效（404），搜索固定走 Latest。
- `Client.user()` 的 GraphQL hash 同样失效（404），登录验证改为拉时间线。

## 自测

```
uv run python test_tui.py
```

textual pilot 无头驱动，覆盖启动→时间线→推文详情→回复→返回→
Following→刷新，需要已导出的 cookie 和可用代理。
