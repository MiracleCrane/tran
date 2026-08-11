# Handoff：Tran 浏览器控制（Chrome 扩展路线）

> 交接目标：在 Tran 里实现 Codex / Claude-in-Chrome 式的**真实 Chrome 控制**——
> 让 kimi 能操作用户日常在用、登录态齐全的那个 Chrome。本文档自包含，
> 新会话读完即可开工，不依赖任何旧对话上下文。

## 0. 项目背景（30 秒版）

- 仓库 `C:\LegacyD\project\tran`（GitHub `MiracleCrane/tran`，分支 `master`），子项目在 `cli/`。
- Tran 是 Windows Electron GUI，包装 Kimi Code CLI：主进程经 ACP 协议
  （newline-delimited JSON-RPC over stdio，`kimi acp` 子进程）驱动会话，见
  `cli/src/main/agent/KimiBackend.ts` / `AcpClient.ts`。
- 当前已发版 v1.0.77。构建 `npm run build:win`（在 `cli/` 下）。
- **多个 AI 代理并行改这个仓库**：提交必须 `git add <明确文件列表>`，绝不
  `git add -A`；提交前 `git status --short` 核对。

## 1. 要做什么（验收标准）

用户在 Tran 里对 kimi 说"打开 github.com 看看我有没有新通知"，kimi 通过
MCP 工具驱动**用户真实的 Chrome**（带全部登录态）完成：开标签页 → 读页面 →
汇报。用户全程能在自己的 Chrome 里看到操作发生。

MVP 工具集（第一阶段只做这些）：

| 工具 | 说明 |
|---|---|
| `tabs_list` | 列出标签页（id、title、url） |
| `tab_open` / `tab_activate` / `tab_close` | 标签页管理 |
| `navigate` | 当前/指定标签页导航到 URL |
| `read_page` | **无障碍树/DOM 转文本**快照（含可交互元素编号 ref_N） |
| `click` | 按 read_page 给的 ref 或 CSS selector 点击 |
| `type` | 向元素输入文本（支持回车提交） |
| `screenshot` | 截图（PNG base64；见 §5 图片支持警告） |

第二阶段（先不做）：网络请求读取、console 读取、多帧/iframe、拖拽。

## 2. 架构（已定，不要重新发明）

```
用户真实 Chrome                    Tran 主进程                      kimi CLI
┌──────────────────┐   WebSocket   ┌──────────────────┐   stdio    ┌─────────┐
│ MV3 扩展          │ ◄──────────► │ BrowserBridge     │ ◄────────► │ MCP     │
│ - service worker  │  localhost   │ - WS server       │  (子进程)   │ client  │
│ - chrome.debugger │  + token     │ - 工具实现/路由    │            │         │
└──────────────────┘              │ - 状态给渲染层     │            └─────────┘
                                   └──────────────────┘
                                     ▲ 渲染层：连接状态指示 / 配对 UI
```

- **扩展**（新目录 `cli/extension/`，纯 JS/TS，MV3）：
  - `manifest.json`：permissions `debugger`, `tabs`, `activeTab`, `storage`；
    host_permissions `<all_urls>`。
  - background service worker：连 `ws://127.0.0.1:<port>` （Tran 侧），断线指数
    退避重连；**MV3 SW 会被 Chrome 随时杀掉**——用 `chrome.alarms`（≥30s 周期）
    + WS 消息本身保活，所有状态存 `chrome.storage.session`，SW 重启后凭存储
    的 token 自动重连。
  - 操作实现优先 `chrome.debugger`（附加后走 CDP：`Input.dispatchMouseEvent`、
    `Runtime.evaluate`、`Page.captureScreenshot`、`Accessibility.getFullAXTree`）。
    已知代价：附加期间页面顶部有"正在调试此浏览器"横幅（Chrome 强制，Codex
    系产品同样有，不要试图绕过）。`read_page` 也可以先用 `chrome.scripting`
    注入脚本抓 DOM 文本 + 可点击元素做 MVP，比 AXTree 简单。
- **Tran 主进程**（新文件 `cli/src/main/browserBridge.ts`）：
  - `ws` 依赖已可用则用，否则用 Node 原生 http + ws 库（查 package.json，
    缺就 `npm i ws`，锁 cli/package.json 一并提交）。
  - 只监听 `127.0.0.1`，端口默认 9224（被占则递增，写进配对信息）。
  - **配对安全（必须做）**：首次启动生成随机 token 存
    `app.getPath('userData')/browser-bridge-token.json`；扩展安装引导页让用户
    把 token 粘进扩展 options（或扩展发现页轮询 + 用户在 Tran 里点"允许"确认）。
    WS 握手第一条消息必须带 token，不对就断开。**没有 token 校验的 localhost
    WS 等于给本机任意进程开浏览器后门，这条没商量。**
  - 工具调用协议自定义 JSON：`{id, tool, args}` → `{id, ok, result|error}`，
    30s 超时；扩展断线时所有工具立即报错"扩展未连接"。
- **MCP 接入**：kimi 只认 `$KIMI_CODE_HOME/mcp.json`（形如
  `{"mcpServers":{"名字":{command,args,env}}}`，**stdio 型，本机实证**；http/sse
  型未验证，别赌）。做一个薄的 stdio MCP server：
  - 新文件 `cli/src/mcp-browser/index.ts`，构建成独立 js（electron-vite 加一个
    入口或 esbuild 单独打包到 `out/mcp-browser.js`），实现 MCP stdio 协议
    （initialize / tools/list / tools/call——手写即可，协议很小；也可用
    `@modelcontextprotocol/sdk`，注意它要 Node ≥18）。
  - 它作为 kimi 的子进程启动，进程内**连 Tran 的 WS**（从 token 文件读端口+token,
    路径经 env 传入），把 tools/call 转发给 Tran → 扩展。
  - Tran 写 mcp.json 的现成链路：`cli/src/main/mcpConfig.ts` 的 `saveMcpServer`
    （scope 用 `user`）。注册的 command 用 `process.execPath`？——不行，那是
    Tran.exe。用 `node`？用户可能没有 node。**用打包进 resources 的
    `mcp-browser.js` + Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑**：
    `{"command": "<Tran安装目录>/Tran.exe", "args": ["<resources>/mcp-browser.js"], "env": {"ELECTRON_RUN_AS_NODE": "1", "TRAN_BRIDGE_TOKEN_FILE": "..."}}`。
    开发模式下则指向 out/ 的 js + 本机 electron。安装路径变动时 Tran 启动时
    自动修正 mcp.json 里的这条（幂等 upsert）。
- **渲染层 UI**（小而必要）：
  - 设置或 MCP 面板加一块"浏览器控制"：连接状态（扩展未装/未连/已连）、
    配对 token 展示/复制、安装引导（"chrome://extensions → 开发者模式 →
    加载已解压的扩展程序 → 选 <目录>"）。扩展目录随安装包发布到
    `resources/browser-extension/`（electron-builder extraResources，改
    `cli/electron-builder.yml`）。

## 3. 分步计划（每步可独立验证）

1. **扩展骨架 + WS 桥**：扩展连上 Tran，Tran 日志可见 hello；渲染层显示"已连接"。
2. **tabs_list / navigate / read_page（DOM 文本版）**：先不接 MCP，用 Tran 里
   临时 IPC 或 CDP 调试口直接调 BrowserBridge 验证三个工具真实工作。
3. **stdio MCP server**：单独起进程用 stdin 手敲 JSON-RPC 验证 tools/list、
   tools/call(navigate) 全链路（MCP → WS → 扩展 → Chrome）。
4. **写 mcp.json + kimi 实测**：Tran 注册 MCP，重启 kimi 会话，在 Tran 里让
   kimi "打开 example.com 并告诉我页面标题"——**这是关键验收点**。
5. **click / type / screenshot** 补齐 + 断线重连打磨 + 安装引导 UI。
6. changelog（中英双语，风格照 `cli/CHANGELOG.md` 既有条目）、版本号 bump、
   打包发版（见 §6）。

## 4. 测试基础设施（现成的）

- 开发运行：`cli/` 下 `npm run dev`，**自动开 CDP 调试口 9223**（仅 dev；
  `cli/src/main/index.ts` 里有守卫）。驱动渲染层 UI 做自动化测试的办法：连
  `http://127.0.0.1:9223/json/list` 拿 page target，`Runtime.evaluate` 里用
  native setter 设 textarea 值 + dispatch input 事件 + dispatch Enter keydown
  即可代替用户发消息（历史会话里这套已验证可靠）。
- kimi 数据根目录是 **`KIMI_CODE_HOME=C:\LegacyD\Programs\kimi-code`**（
  `~/.kimi-code` 是过期副本，只有 `~/.kimi-code/bin/kimi.exe` 这个可执行文件
  例外）。读 mcp.json / 会话数据一律走 `cli/src/main/kimiHome.ts` 的解析。
- 测试 kimi 会话随便花 token，用户明确说过不心疼。

## 5. 已知约束与坑（都是实证，别踩第二遍）

- **kimi 对图片工具结果的支持未验证**（K3 的 prompt 支持图片，tool result 不
  确定）。所以 `read_page` 的文本快照是主通道，`screenshot` 做出来后要实测
  kimi 能不能消费；不能的话降级为"保存到临时文件并返回路径"。
- **绝不调用 `api.kimi.com` 的私有接口**（用户账号曾因 usages 接口被封）。
  本功能用不到它，但写任何探测代码时记住这条红线。
- PowerShell 脚本必须纯 ASCII（中文注释会让 PS 5.1 报 ParserError）；控制台是
  GBK，涉及中文的 JSON 一律写 UTF-8 文件再 `--data-binary @file`。
- MV3 `chrome.debugger` 同一标签页只能有一个 debugger——用户开着 DevTools 的
  标签页会附加失败，工具要把这个错误如实返回（"该标签页开着 DevTools"）。
- 扩展与 Tran 版本要能对上：WS hello 里带双方版本号，不匹配时提示更新扩展
  （重新加载解压目录即可）。

## 6. 发版流程（照抄即可）

1. 版本号：`cli/` 下 `node -e` 脚本改 package.json（不要手编 JSON）。
2. `npm run build:win`。**杀软 EPERM 是常态**：失败就
   `mv release/win-unpacked.tmp X && mv X release/win-unpacked.tmp` 探测一把，
   紧接着重跑（两次发版实证有效）。产物必须验证：
   `grep -ao '1\.0\.NN' release/win-unpacked/resources/app.asar`——EPERM 中断
   的残留目录只有裸 Electron，拿去做安装包就是空壳事故。
3. 无 gh CLI。token：`printf "protocol=https\nhost=github.com\n" | git credential fill`。
   创建 release 走 `api.github.com`（可走代理）；**上传资产必须直连**：
   `curl --ssl-no-revoke --noproxy uploads.github.com https://uploads.github.com/...`。
4. 静默安装：`./Tran-1.0.NN-setup.exe //S`（Git Bash 下双斜杠）。
5. commit 尾部加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 7. 相关现成代码索引

| 文件 | 与本任务的关系 |
|---|---|
| `cli/src/main/mcpConfig.ts` | 写 kimi mcp.json 的现成实现（含防覆盖保护） |
| `cli/src/main/kimiHome.ts` | KIMI_CODE_HOME 解析（唯一真源） |
| `cli/src/main/ipc.ts` | IPC handler 注册模式参考 |
| `cli/src/renderer/components/McpPanel.tsx` | MCP 面板（"浏览器控制"块放这附近） |
| `cli/src/main/agent/AcpClient.ts` | JSON-RPC over stdio 的现成参考（MCP stdio 协议同型） |
| `cli/electron-builder.yml` | extraResources 配置处（扩展目录、mcp-browser.js） |
| `cli/src/main/atomicWrite.ts` | 所有配置写盘用它（原子写） |

## 8. 明确不做的事

- 不做 Web Store 发布（先"加载已解压"跑起来）。
- 不做 Firefox/Edge 适配。
- 不碰 Chrome 用户 profile 文件（Cookie 库等）——一切通过扩展 API。
- 不在无 token 校验的情况下开任何 localhost 服务。
- 不改动与本功能无关的文件；与并行代理共存，提交只列自己的文件。
