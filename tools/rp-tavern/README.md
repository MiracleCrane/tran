# RP Tavern TUI

Tran 启动的终端酒馆客户端。它依赖已经运行的本机 SillyTavern 服务，通过
`http://127.0.0.1:8000` 读取角色、聊天、当前模型配置并请求生成。

生成由不可见的 Chrome/Edge 页面调用 SillyTavern 原版 `Generate()` 完成，因此
Prompt 顺序、世界书、Persona、角色示例、扩展 Prompt、正则和 token 裁剪与网页
完全一致。TUI 不再自行拼装简化提示词；关闭 TUI 时隐藏浏览器及其临时 Profile
会一并回收。

- Enter：发送
- Shift+Enter：换行；长内容会在输入框内自动软换行
- F2：AI 帮答，草稿写入输入框但不自动发送
- F3：续写角色上一条回复
- F4：重新生成角色上一条回复
- F6 / F7 / F8：缩小、放大、重置经典控制台字体
- F9：用默认浏览器打开完整 SillyTavern
- F12：默认老板键，在聊天和普通构建日志之间切换
- Ctrl+R：刷新角色与聊天
- Ctrl+Q：退出

生成结束不会重新抢输入框焦点，避免 Windows 控制台把中文输入法切回英文；首次
打开和退出老板模式时会延迟激活控制台窗口，以初始化正确的 IME 上下文。

Windows Terminal 也可以直接使用原生 `Ctrl+-` / `Ctrl++` 调整字体。

聊天区以低调日志流显示：玩家与角色使用不同的低饱和度颜色，Markdown 正文为
浅灰色。每条消息前包含 3～4 行 TRACE/DEBUG/INFO 日志，偶尔穿插一条已恢复的
WARN，并显示时间、方向、序号、字节数和流式分块数。

老板键可以修改：在输入框执行 `/bosskey ctrl+b`，会保存到
`%LOCALAPPDATA%\rp-tavern\config.json` 并立即生效。启动时也可使用
`--boss-key ctrl+b` 临时覆盖。

鼠标支持 `/bosskey mouse4`（侧键后退）、`/bosskey mouse5`（侧键前进）和
`/bosskey middle`（中键）。鼠标老板键在 Windows 上即使终端没有焦点也能触发。

API Key 始终由 SillyTavern 的密钥存储管理；TUI 不读取或复制明文 Key。
