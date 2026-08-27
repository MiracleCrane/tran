# 调研：OpenAI Codex Harness（app-server）架构

> 调研日期：2026-08-27。基于一手来源：OpenAI 官方开发者博客、developers.openai.com 官方文档、github.com/openai/codex 仓库源码（浅克隆 main 分支）。本文只描述 Codex 侧的事实与可借鉴的设计，不与 Tran 做对比。

## 0. 背景与一手来源

2026-08-19 OpenAI 发布博客《Codex as a platform: build on the open agent harness》，宣布把 Codex 底层的 Agent 执行框架（Harness）以 Apache-2.0 开源。

- 博客原文：https://developers.openai.com/blog/codex-as-a-platform
- 仓库：https://github.com/openai/codex （License: Apache-2.0，见仓库根 `LICENSE`）
- 开源组件清单（官方）：https://developers.openai.com/codex/open-source （会 307 跳转到 learn.chatgpt.com/docs/open-source）
- app-server 官方文档：https://developers.openai.com/codex/app-server
- app-server 协议权威文档（仓库内）：`codex-rs/app-server/README.md`（约 2800 行，含全部方法/事件/审批的 JSON 示例）
- 非交互模式（codex exec）官方文档：https://developers.openai.com/codex/non-interactive-mode

博客的核心论点：Codex App、CLI、IDE 扩展只是「同一个底层系统」的几种前端；可复用的部分是 **agent loop 外围的执行系统（harness）**——上下文管理、工具调用、流式执行、沙箱与审批策略、跨轮次推进。博客还给了一个 harness 设计影响效果的量化例子：在 ARC-AGI-3 上，retained reasoning + context compaction 把 GPT-5.6 Sol 的得分从 13.3% 提到 38.3%，同时输出 token 减少 6 倍（来源：博客原文「The reusable part is the agent loop」一节）。

开源组件清单页列出的组件与归属（来源：https://developers.openai.com/codex/open-source ）：

| 组件 | 位置 | 备注 |
|---|---|---|
| Codex CLI | openai/codex | 开源主仓库 |
| Codex SDK (TS/Python) | openai/codex 仓库 `sdk/` 目录 | 开源 |
| Codex App Server | openai/codex 仓库 `codex-rs/app-server` | 开源 |
| Skills / Plugins | openai/skills、openai/plugins | 开源 |
| Codex Security CLI 及其 TS SDK | openai/codex-security | 开源 |
| IDE 扩展、Codex cloud | — | **不开源** |

三种集成层的官方定位（来源：博客「Choose the right integration layer」一节）：

- **codex exec**：脚本、CI、一次性后台任务，运行有界 agent 工作流并返回结构化输出。
- **Codex SDK**：应用代码里以编程方式 start/resume/stream Codex 任务。
- **Codex app-server**：agent 是产品本身的一部分时使用——持久会话、流式事件、中断、暴露工具、响应审批。「SDK 简化常见编程工作流；app-server 让产品团队直接控制生命周期与用户体验。」

## 1. app-server 的传输层与协议

来源：`codex-rs/app-server/README.md`「Protocol」一节；https://developers.openai.com/codex/app-server 。

### 1.1 协议：JSON-RPC 2.0 变体

- 双向通信，类似 MCP，使用 JSON-RPC 2.0 消息，但**线上省略 `"jsonrpc":"2.0"` 头**。源码注释原文（`codex-rs/app-server-protocol/src/rpc.rs:1-2`）：`We do not do true JSON-RPC 2.0, as we neither send nor expect the "jsonrpc": "2.0" field.`
- 三类消息（源码 `JSONRPCMessage` enum：`Request | Notification | Response | Error`，见 `codex-rs/app-server-protocol/src/rpc.rs`）：

```json
// 请求：method + params + id
{ "method": "thread/start", "id": 10, "params": { "model": "gpt-5.6-terra" } }
// 响应：回显 id，带 result 或 error
{ "id": 10, "result": { "thread": { "id": "thr_123" } } }
{ "id": 10, "error": { "code": 123, "message": "Something went wrong" } }
// 通知：无 id，只有 method + params
{ "method": "turn/started", "params": { "turn": { "id": "turn_456" } } }
```

（示例摘自官方文档页 https://developers.openai.com/codex/app-server ）

- **关键设计点：请求是双向的**。不仅是客户端→服务端；服务端也会向客户端发起 JSON-RPC 请求（审批、MCP elicitation、动态工具调用、attestation、读取当前时间等），客户端必须作为 JSON-RPC server 应答。这是与普通「客户端调 API」模式的本质区别。
- `RequestId` 支持 string 或 integer（`rpc.rs` 中 `RequestId` 为 untagged enum）。

### 1.2 传输层：stdio 为默认，ws/unix socket 为辅

`codex app-server` 支持的 transport（来源：README「Protocol」一节）：

- **stdio（`--stdio` 或 `--listen stdio://`，默认）**：换行分隔 JSON（JSONL），一行一条消息。
- **websocket（`--listen ws://IP:PORT`）**：每个 ws text frame 一条 JSON-RPC 消息；官方标注 **experimental / unsupported，不要用于生产**。同一监听口还提供 `GET /readyz`、`GET /healthz` 健康探针；带 `Origin` 头的请求一律 403（防浏览器跨域滥用）。
- **unix socket（`--listen unix://` 或 `unix://PATH`）**：在 `$CODEX_HOME/app-server-control/app-server-control.sock` 或自定义路径上跑 websocket（HTTP Upgrade 握手）。配套 `codex app-server proxy` 命令把该 socket 的字节流桥接到 stdin/stdout，供只懂 stdio 的客户端使用。
- **off（`--listen off`）**：不暴露本地 transport。

ws 模式的鉴权（官方文档页）：非 loopback 监听默认在灰度期允许无鉴权连接，暴露到远端前必须配置 `--ws-auth capability-token --ws-token-file/--ws-token-sha256` 或 `--ws-auth signed-bearer-token --ws-shared-secret-file`（可配 `--ws-issuer/--ws-audience/--ws-max-clock-skew-seconds`）；客户端在 ws 握手时带 `Authorization: Bearer <token>`，鉴权先于 JSON-RPC `initialize` 执行。

背压（README「Backpressure behavior」）：传输入口、请求处理、出站写之间都是有界队列；入口打满时新请求被拒绝，返回错误码 `-32001`、消息 `"Server overloaded; retry later."`，客户端应按可重试处理（指数退避 + jitter）。

### 1.3 Schema 分发：由二进制自生成，版本强一致

```
codex app-server generate-ts --out DIR
codex app-server generate-json-schema --out DIR
```

输出的 TypeScript 类型 / JSON Schema 与运行它的 Codex 版本严格对应（README「Message Schema」）。协议类型用 Rust 定义并经 `ts-rs`/`schemars` 导出（源码 `codex-rs/app-server-protocol/src/`，如 `export.rs`、`precomputed_exports.rs`）。

另有**实验 API 门控**（README「Experimental API Opt-in」）：客户端在 `initialize.params.capabilities.experimentalApi = true` 时才解锁实验方法/字段；未 opt-in 而调用实验方法会被拒绝（`<descriptor> requires experimentalApi capability`）。`generate-ts` 默认只导出稳定面，`--experimental` 才含实验面。

### 1.4 初始化握手

每条 transport 连接必须先发一次 `initialize` 请求、再发 `initialized` 通知，否则后续请求收到 `"Not initialized"` 错误；重复 initialize 收到 `"Already initialized"`。`clientInfo.name` 用于 OpenAI 合规日志平台识别客户端（企业用途需联系 OpenAI 加入已知客户端列表）。官方 VS Code 扩展的实例（README「Initialization」）：

```json
{ "method": "initialize", "id": 0, "params": {
    "clientInfo": { "name": "codex_vscode", "title": "Codex VS Code Extension", "version": "0.1.0" },
    "capabilities": {
      "experimentalApi": true,
      "optOutNotificationMethods": ["thread/started", "item/agentMessage/delta"]
    }
} }
```

`capabilities.optOutNotificationMethods` 支持**按连接**精确屏蔽指定通知方法（精确匹配、无通配符；只影响通知，不影响请求/响应/错误）。

## 2. 会话模型：Thread / Turn / Item 三级原语

来源：README「Core Primitives」「Lifecycle Overview」。

- **Thread**：用户与 agent 的一次对话，含多个 turn。
- **Turn**：一轮对话，通常从一条用户消息开始、到 agent 消息结束，含多个 item。
- **Item**：turn 内的一次输入/输出单元，**会被持久化并作为后续对话的上下文**。item 类型（tagged union `ThreadItem`）包括：`userMessage`、`agentMessage`、`reasoning`、`plan`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabToolCall`、`subAgentActivity`、`webSearch`、`imageGeneration`、`imageView`、`sleep`、`enteredReviewMode`/`exitedReviewMode`、`contextCompaction`、`functionCallOutput` 等（README「Items」一节）。

典型生命周期（README「Lifecycle Overview」，方法名均为实际 JSON-RPC method）：

1. `initialize` → `initialized`（每连接一次）。
2. `thread/start` 开新会话（返回 thread 对象并发 `thread/started` 通知，且**自动订阅**该 thread 的 turn/item 事件）；继续旧会话用 `thread/resume { threadId }`；分叉用 `thread/fork { threadId, lastTurnId? }`（复制历史到新 thread id；`ephemeral: true` 表示纯内存临时会话，`thread.path` 为 null）。
3. `turn/start { threadId, input: [...] }` 开始一轮；立即返回 `{ turn: { id, status: "inProgress", items: [], error: null } }`，实际开跑时发 `turn/started`。input 是判别联合：`text` / `image`(data URL) / `localImage` / `audio` / `localAudio` / `skill`。
4. 流式消费通知：`item/started` → 若干 item 专属 delta → `item/completed`。
5. `turn/completed` 收尾，`turn.status ∈ {completed, interrupted, failed}`，附 token usage（usage 另走 `thread/tokenUsage/updated` 流式推送）。

会话管理 API 的完整度（README「API Overview」，摘选）：`thread/list`（游标分页 + modelProviders/sourceKinds/archived/cwd/searchTerm 过滤）、`thread/read`（不 resume 只读）、`thread/turns/list` 与 `thread/items/list`（不加载会话直接分页历史，itemsView 可选 notLoaded/summary/full）、`thread/loaded/list`、`thread/archive` / `thread/unarchive` / `thread/delete`、`thread/name/set`、`thread/metadata/update`（pin、gitInfo 等存 sqlite）、`thread/compact/start`（手动触发上下文压缩）、`thread/shellCommand`、`thread/unsubscribe`（最后一个订阅者退出后 30 分钟无活动才卸载并发 `thread/closed`）。

### 2.1 恢复（resume）与分叉（fork）

- `thread/resume` 默认返回重建的完整 turn 历史 `thread.turns`；对 paginated thread 该全量水合已废弃（返回 `deprecationNotice`），客户端应传 `excludeTurns: true` 只拿元数据 + `turnsBackwardsCursor`/`itemsBackwardsCursor`，再用 `thread/turns/list`、`thread/items/list` 分页；也可用实验参数 `initialTurnsPage` 一个往返拿到首页（README「Start or resume a thread」）。
- 冷恢复时 approval policy / 权限 profile 的取值顺序：请求覆盖 > 线程持久化设置 > 当前配置默认。
- resume 时不显式指定 model 则沿用线程最近持久化的 `model`/`reasoningEffort`。
- **写独占**：同一时刻只允许一个 app-server 进程以写方式打开一个 paginated thread；被占用时 `thread/resume`/`thread/archive`/`thread/delete` 返回 `-32600`，只读请求不受影响（README 同节）。

### 2.2 中断与「插队」

- `turn/interrupt { threadId, turnId }`：请求取消，成功响应 `{}`，随后 turn 以 `status: "interrupted"` 的 `turn/completed` 结束（README 明确：以 `turn/completed` 事件作为中断完成的信号；不会杀后台终端，另有 `thread/backgroundTerminals/clean`）。
- `turn/steer { threadId, input, expectedTurnId }`：**向正在进行的 turn 追加用户输入**而不起新 turn；不触发新的 `turn/started`；`expectedTurnId` 必须匹配当前活动 turn（乐观并发控制）。review/手动 compact 等特殊 turn 拒绝 steer（错误 `ActiveTurnNotSteerable`）。
- `thread/queue/*`（实验）：把用户 turn 持久化进 FIFO 队列，线程空闲时自动提交（add/list/update/delete/reorder/start + `thread/queue/changed` 通知）。

### 2.3 并发会话的表达

- 一个 app-server 进程可同时加载多个 thread（`thread/loaded/list` 返回内存中的 thread id 列表）。
- 订阅模型是**按连接**的：`thread/start`/`resume`/`fork` 自动订阅当前连接；`thread/unsubscribe` 退订；每个连接可用 `optOutNotificationMethods` 独立裁剪事件流。多个连接可同时挂在同一进程上（每条连接独立做 initialize 握手）。
- 线程运行时状态通过 `thread/status/changed` 通知推送，形如 `{ "threadId": "thr_123", "status": { "type": "active", "activeFlags": ["waitingOnApproval"] } }`（示例摘自官方文档页）。status 取值：`notLoaded` / `idle` / `systemError` / `active`（带 activeFlags）。

## 3. 流式事件模型

来源：README「Events」「Turn events」「Items」。

### 3.1 三级事件流

- 线程级：`thread/started`、`thread/archived`、`thread/unarchived`、`thread/deleted`、`thread/closed`、`thread/status/changed`、`thread/name/updated`、`thread/tokenUsage/updated`、`thread/goal/updated` 等。
- 轮次级：`turn/started`、`turn/completed`、`turn/diff/updated`（**turn 级聚合 unified diff 快照，每个 FileChange item 后推送**，UI 无需自己拼接单个 fileChange）、`turn/plan/updated`（计划步骤 `{step, status}`，status ∈ pending/inProgress/completed）。
- 条目级：生命周期恒为 `item/started` → 0..n 个 item 专属 delta → `item/completed`。`item/started` 携带完整 item 供立即渲染；`item/completed` 是**权威的执行/结果状态**。

### 3.2 item 专属 delta（从 README 摘录的方法名）

- `item/agentMessage/delta` — agent 文本流，按 itemId 顺序拼接还原全文。
- `item/reasoning/summaryTextDelta` / `item/reasoning/summaryPartAdded` / `item/reasoning/textDelta` — 推理摘要/原始推理流（`summaryIndex`/`contentIndex` 分组）。
- `item/plan/delta`（实验）— plan 文本流。
- `item/commandExecution/outputDelta` — 命令 stdout/stderr 流；最终 item 带 `commandActions`、`status`、`exitCode`、`durationMs`。
- `item/fileChange/patchUpdated` — apply_patch 流式结构化快照（特性开关控制）。

### 3.3 错误事件

中途出错发 `error` 通知，载荷与 `turn.status: "failed"` 相同：`{ error: { message, codexErrorInfo?, additionalDetails?, misalignment? } }`。`codexErrorInfo` 常见取值：`ContextWindowExceeded`、`SessionBudgetExceeded`、`UsageLimitExceeded`、`rateLimitExceeded`、`HttpConnectionFailed { httpStatusCode? }`、`ResponseStreamDisconnected`、`ActiveTurnNotSteerable { turnKind }`、`Unauthorized`、`SandboxError`、`InternalServerError`、`Other` 等（README「Errors」）。

## 4. 审批（approval）机制：服务端反向请求

来源：README「Approvals」全节。

核心模式：当 turn 中的动作（执行命令、修改文件、请求权限等）按配置需要人工批准时，**app-server 向客户端发起一条 JSON-RPC 请求**，客户端 UI 展示后同步返回决定。所有审批请求都带 `threadId` + `turnId`（+ `itemId`），便于把 UI 状态绑定到具体会话。回应后服务端发 `serverRequest/resolved { threadId, requestId }` 确认该挂起请求已解决或被清理（turn start/complete/interrupt 时也会做生命周期清理），随后 `item/completed` 给出终态。

### 4.1 命令执行审批

消息顺序（README「Command execution approvals」）：

1. `item/started`：pending 的 `commandExecution` item（含 `command`、`cwd` 等展示字段）。
2. `item/commandExecution/requestApproval`（服务端→客户端请求）：携带 `itemId/threadId/turnId`、可空 `environmentId`、`kind`（`command` 或 `writeStdin`）、可选 `approvalId`、`reason`；普通命令审批还带 `command/cwd/commandActions`；网络类审批带 `networkApprovalContext`；可选持久化建议 `proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments`；`availableDecisions` 给出服务端希望暴露的确切选项集。
3. 客户端响应，例如：
   - `{ "decision": "accept" }`
   - `{ "decision": "acceptForSession" }`（会话内同类免批）
   - `{ "decision": { "acceptWithExecpolicyAmendment": { "execpolicy_amendment": [...] } } }`（批准并把规则写入 execpolicy）
   - `{ "decision": { "applyNetworkPolicyAmendment": { "network_policy_amendment": { "host": "example.com", "action": "allow" } } } }`
   - `{ "decision": "decline" }` 或 `{ "decision": "cancel" }`
4. `serverRequest/resolved { threadId, requestId }`。
5. `item/completed`：`commandExecution` 终态 `status ∈ {completed, failed, declined}` + 执行输出。

### 4.2 文件变更审批

同样五步，请求方法为 `item/fileChange/requestApproval`（含可选 `reason`、不稳定字段 `grantRoot`——请求某 root 下会话级写权限），响应为 `accept` / `acceptForSession` / `decline` / `cancel`。README 给 IDE 的指引原文：审批请求一到立刻弹审批 UI；服务端收到响应后 turn 继续；以 `item/completed` 的状态收尾 diff 展示。

### 4.3 其他「服务端反向请求」家族

同一模式被复用到多类交互（README 各节）：

- `item/permissions/requestApproval` — 内置 `request_permissions` 工具发起的细粒度权限请求（网络 + 文件系统写路径），客户端回 `result.permissions`（授予的子集）+ 可选 `scope: "session"` 让授权跨 turn 粘滞；未授予的视为拒绝，请求外的权限被忽略。
- `item/tool/requestUserInput` — 工具向用户提 1–3 个短问题，`isBlocking` 表示是否无限等待。
- `mcpServer/elicitation/request` — MCP server 中断 turn 请求结构化输入，三种 mode：`form` / `openai/form` / `url`；客户端回 `{ "action": "accept", "content": ... }` 或 `decline`/`cancel`。
- `item/tool/call`（实验）— **动态工具**：客户端在 `thread/start` 时通过 `dynamicTools` 注册自己的函数工具（带 JSON Schema），agent 调用时服务端把调用以请求形式转发给客户端执行，客户端返回 `contentItems`（`inputText`/`inputImage`/`inputAudio`）+ `success`。这意味着宿主应用可以不开 MCP server、直接在本进程内给 agent 供工具。
- `attestation/generate` — 桌面宿主提供上游 attestation token（`capabilities.requestAttestation` opt-in）。
- `currentTime/read`（实验）— 服务端向客户端要当前时间（外部时钟源）。

### 4.4 自动审批（auto review）

`turn/start` 的 `approvalsReviewer` 可取 `"user"`（默认，客户端人工审批）或 `"auto_review"`（把审批路由给一个专门 prompt 的子 agent，基于风险决策框架自动批准/拒绝）。自动评审过程通过 `item/autoApprovalReview/started|completed`（UNSTABLE）通知推送 `{threadId, turnId, targetItemId, review, action}`，`review.status ∈ {inProgress, approved, denied, aborted}`、`riskLevel ∈ {low, medium, high, critical}`。托管配置 `requirements.toml` 可强制指定模型走 auto_review。

## 5. 状态归属：harness 侧 vs 前端侧

### harness（app-server / core）侧拥有的状态

- **对话历史与持久化**：thread 以 JSONL rollout 文件存盘（TS SDK README 明确「Threads are persisted in `~/.codex/sessions`」；app-server README 中 archive/unarchive/delete 都是移动/删除 rollout 文件），线程元数据（pin、gitInfo、name、project 归属等）存 sqlite（`thread/metadata/update`「patch stored thread metadata in sqlite」）。
- **上下文压缩**：自动压缩（`contextCompaction` item 通知）+ 手动 `thread/compact/start`；压缩过程本身以标准 turn/item 通知流出。
- **工具执行与沙箱**：命令执行、文件补丁、MCP 工具调用、execpolicy/网络策略、审批策略的判定与执行全部在 harness 侧。
- **token 用量**：`thread/tokenUsage/updated` 流式推送，且持久化——resume 时会重放已存的用量。
- **turn 级聚合视图**：`turn/diff/updated` 直接给整轮 unified diff 快照。
- **模型/配置目录**：`model/list`（含 reasoning effort 选项、modalities）、`config/read`（分层解析后的生效配置）、`experimentalFeature/list`（特性开关及生命周期阶段）、`permissionProfile/list`。
- **认证**：完整的 auth 端点家族（API key、ChatGPT 浏览器流、device code、Bedrock、logout、rate limits 查询等，README「Auth endpoints」）。
- **附属能力**：`command/exec`（不开会话直接在沙箱里跑命令，支持 PTY、stdin、resize）、`fs/*`（读写/监听文件）、`fuzzyFileSearch/*`、`skills/list`、`mcpServerStatus/list`、`mcpServer/tool/call` 等——前端需要的工具性能力基本都协议化了。

### 前端（客户端）侧拥有的状态

- **UI 状态与呈现**：如何渲染 item、diff、审批对话框；`clientUserMessageId`（客户端消息 id 透传，回显在 `userMessage.clientId`）用于客户端把自己的消息记录与服务端 item 对账。
- **审批决定与权限授予**：审批策略的执行在 harness，但「问谁、怎么问、答什么」由前端实现；动态工具的实际执行也在前端进程。
- **产品域状态**：博客明确宿主应用继续拥有自己的 dashboard、records、controls（Relay 一节：「the product continues to own its dashboard, records, and controls」）。
- **通知裁剪**：每连接 `optOutNotificationMethods`。

## 6. CLI / IDE / 桌面 App 如何共享同一 harness

- 博客开宗明义：App、CLI、IDE 扩展「只是同一个底层系统的几种使用方式」，harness 开源后开发者可以检视并改造「应用与模型之间的这一层」。
- app-server README 第一句：app-server 是 Codex 用来驱动富客户端（如官方 VS Code 扩展）的接口；`clientInfo.name: "codex_vscode"` 的 initialize 示例即取自官方扩展。
- CLI（TUI）本身也是 app-server 的客户端：官方文档页给出远端模式——服务端 `codex app-server --listen ws://127.0.0.1:4500`，终端 UI 用 `codex --remote ws://127.0.0.1:4500` 连接（`--remote` 接受 ws/wss/unix；远端用 `--remote-auth-token-env` 传 bearer token）。即 CLI 的交互界面可以脱离本机 harness 进程运行。
- 桌面 App 侧另有桌面特有的协议能力（如 `attestation/generate`、`windowsSandbox/setupStart` 等），说明桌面端同样走 app-server 协议、只是 opt-in 了更多 capability。
- `thread/list` 的 `sourceKinds` 过滤值（`cli`、`vscode`、`exec`、`appServer`、`subAgent*` 等）说明各前端产生的会话落在同一份存储里、可以互相看到和恢复——CLI 里开的会话能在 IDE 扩展里 resume，反之亦然。

## 7. codex exec 与 SDK 的能力边界

### 7.1 codex exec（非交互模式）

来源：https://developers.openai.com/codex/non-interactive-mode 。

- 定位：CI/脚本/一次性任务。运行期进度走 stderr，**只有最终 agent 消息走 stdout**，便于管道串联。
- `--json`：stdout 变为 JSONL 事件流，事件类型 `thread.started` / `turn.started` / `turn.completed` / `turn.failed` / `item.*` / `error`（注意：这是 exec 自己的事件格式，与 app-server 的 JSON-RPC 通知不同——蛇形命名、无 JSON-RPC 信封）。样例：

```
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

- `--output-schema schema.json` + `-o result.json`：约束最终消息符合 JSON Schema 并落盘。
- 默认只读沙箱；`--sandbox workspace-write` / `danger-full-access` 显式放权；`--ephemeral` 不落 rollout；`--skip-git-repo-check`；`--ignore-user-config` / `--ignore-rules`。
- 恢复：`codex exec resume --last "..."` 或 `codex exec resume <SESSION_ID> "..."`（两段式流水线）。
- 边界：无中途交互、无审批回调（审批策略只能预先设定）、无 steer——本质是「一次 turn 到底」的有界运行。

### 7.2 TypeScript SDK（`@openai/codex-sdk`，仓库 `sdk/typescript/`）

来源：`sdk/typescript/README.md`、`sdk/typescript/src/exec.ts`。

- **实现方式：spawn `codex exec --experimental-json` 子进程，通过 stdin/stdout 交换 JSONL 事件**（`exec.ts:92`：`const commandArgs: string[] = ["exec", "--experimental-json"]`；resume 用 `exec resume <threadId>`，`exec.ts:167`）。即 TS SDK 是 codex exec 的编程封装，**不是** app-server 客户端。
- API：`const codex = new Codex(); const thread = codex.startThread(); const turn = await thread.run("...")`；`runStreamed()` 返回结构化事件异步迭代器（`item.completed`、`turn.completed` 等）；`resumeThread(id)` 恢复（线程持久化在 `~/.codex/sessions`）；per-turn `outputSchema`；`env` 参数显式控制子进程环境（README 特别提到「useful for sandboxed hosts like Electron apps」）；`config`/`configOverrides` 拍平成 `--config key=value`。
- 边界：exec 能给的它都能给（结构化输出、流式事件、resume），但**没有审批回调、没有 steer、没有服务端反向请求**——交互深度受限于 exec。

### 7.3 Python SDK（`openai-codex`，仓库 `sdk/python/`）

来源：`sdk/python/README.md`、`sdk/python/src/openai_codex/client.py`、`api.py`。

- **实现方式与 TS SDK 不同：是一个 typed JSON-RPC 客户端，走 `codex app-server` stdio**。`client.py:213` 注释原文：`Synchronous typed JSON-RPC client for codex app-server over stdio.`， spawn 参数为 `["app-server", "--listen", "stdio://"]`（`client.py:252`）。协议类型由 app-server schema 生成（`sdk/python/src/openai_codex/generated/v2_all.py`、`generated/notification_registry.py`）。
- API：`with Codex() as codex: thread = codex.thread_start(); result = thread.run("...")`；有 `thread_start/thread_list/thread_resume/thread_fork/thread_archive/thread_unarchive/models`、登录（api_key / ChatGPT 浏览器流 / device code）、`account`、`logout`；同步 `Codex` 与异步 `AsyncCodex` 双客户端；`ApprovalMode` 高层枚举（`deny_all` / `auto_review`，见 `_approval_mode.py`）。
- 因为底层是 app-server，Python SDK 天然覆盖持久会话、fork、登录态等 exec 给不了的能力。

> 小结：同一「Codex SDK」品牌下两种实现路径——TS SDK = exec 封装（轻、无反向通道），Python SDK = app-server 客户端（全协议）。选型时这一不对称值得注意（均见上文源码出处）。

## 8. Relay 示例应用

来源：博客「Example: Relay」一节。

- Relay 是 OpenAI 构建在 app-server 上的**示例运营应用**：一个虚构的货运（shipment）dashboard 旁边嵌一个 agent。
- 演示的集成模式：
  1. **宿主自有 UI 驱动上下文**：用户不是从零写 prompt，而是选中一票运单、点击「Compare recovery」之类的动作，由应用把相关记录作为上下文提供给 Codex。
  2. **应用自有 MCP 工具**：agent 通过宿主应用的 MCP 工具拉取最新运营数据，再给出恢复方案建议。
  3. ** consequential write 必须人工审批**：重订 shipment 这类写操作走审批流。
  4. **业务视图回刷**：工具改变底层记录后，应用刷新自己的业务视图；harness 只管 agent loop、会话状态、流式活动和工具交互，dashboard/记录/控件始终归产品所有（博客原文：「The harness handles the agent loop, conversation state, streamed activity, and tool interaction; the product continues to own its dashboard, records, and controls.」）。
- 数据为虚构种子数据，但博客强调该模式可推广到 incident response、账户运营、研究工作流等。
- **开源状态：Relay 未开源**。截至调研日，官方开源组件清单（https://developers.openai.com/codex/open-source ）不含 Relay；openai/codex 仓库内亦无 Relay 应用代码（仓库中的 `codex-rs/exec-server/src/relay.rs` 等是 exec-server 的远程执行中继，与示例应用无关）；GitHub openai org 下也检索不到对应仓库。Relay 目前只以博客描述 + 截图形式公开，其价值在于示范集成模式而非可运行代码。

## 9. 对 GUI 壳类产品的设计启示

以下每条均可从上文标注的一手来源回溯。

1. **把「客户端协议」设计成双向 JSON-RPC，而不是请求-响应 API**。app-server 最大的结构特征是服务端会向客户端发请求（审批、elicitation、动态工具调用、attestation、读时钟）。GUI 壳一旦支持反向请求，「harness 需要人/宿主参与」的所有场景都能用同一信封表达，且天然支持多个前端各自实现自己的应答 UI。
2. **Thread / Turn / Item 三级原语 + 统一 item 生命周期**（`item/started` → delta → `item/completed`）让前端可以用一套渲染管线处理文本、推理、命令、diff、MCP 调用、子 agent 活动等十几种内容；`item/completed` 作为权威终态、`item/started` 携带完整对象用于即时渲染，是很干净的契约。
3. **会话状态全部下沉到 harness 并持久化**（JSONL rollout + sqlite 元数据），前端只持有 UI 状态。由此免费获得：跨前端共享会话（CLI 开的会话 IDE 能恢复）、崩溃恢复、历史分页（`thread/turns/list` 的 cursor + itemsView 分级加载）、归档/删除/fork。
4. **fork 是一等公民**。`thread/fork`（可带 `lastTurnId` 截断点、`ephemeral` 内存分支）以极小协议成本支撑了「从中间某轮重试」「分叉实验」「detached review」等产品功能。
5. **中断与 steer 分开建模**：`turn/interrupt` 取消、`turn/steer` 向进行中的 turn 追加输入（带 `expectedTurnId` 做乐观并发校验）、`thread/queue/*` 做排队。三种「用户想插话」的语义各有独立方法，前端语义清晰。
6. **审批协议预留了「决策升级」通道**：`acceptForSession`、`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment` 允许用户不只是「批准这一次」，还能把决定沉淀为持久规则；`availableDecisions` 让服务端声明可选项集，前端不必硬编码。另有 `approvalsReviewer: "auto_review"` 把审批本身委派给子 agent——人工审批与自动审批走同一协议面。
7. **turn 级聚合事件减少前端拼装负担**：`turn/diff/updated` 直接给整轮 unified diff 快照、`turn/plan/updated` 给计划状态，前端不必从 item 流里推导全局视图。
8. **按连接的通知裁剪与订阅**（`optOutNotificationMethods`、`thread/unsubscribe`、30 分钟闲置卸载）让一个长驻 harness 进程服务多个窗口/视图时，各自只收自己关心的事件。
9. **Schema 从实现自生成**（`generate-ts` / `generate-json-schema`），并用 `experimentalApi` capability 把稳定面与实验面分开——协议演进时前端可以钉版本、按需 opt-in。
10. **传输分层：默认 stdio（JSONL）足够本地 GUI 使用**；ws/unix socket 作为可选远程通道，且明确标注成熟度（experimental）、配健康探针、鉴权先于 initialize、背压用有界队列 + `-32001` 可重试错误。本地优先、远程可选、风险显式标注。
11. **集成分层产品化**：exec（一次性、无交互）→ SDK（编程封装）→ app-server（全生命周期控制）三层能力递进，同一 harness 承载。GUI 壳可以借鉴这种「同一内核、按交互深度分层暴露」的思路，而不是让所有用户都啃最重的协议。
12. **宿主工具供给有两条路**：标准 MCP server，或实验性 `dynamicTools`（thread 级注册、`item/tool/call` 反向调用宿主进程内函数）。对「工具逻辑就在 GUI 进程里」的桌面壳，后者省掉一个 MCP server 进程。
13. **Relay 模式**：宿主 UI 动作（选中记录 + 点按钮）→ 应用组装上下文 → agent 用宿主 MCP 工具取数 → 建议 → 关键写操作走人工审批 → 应用回刷业务视图。这是「agent 嵌入既有产品」而非「聊天框替代产品」的参考范式；博客明确「机会不是用通用聊天框替换这些界面，而是给它们一个懂工作的 agent」。
14. **错误分类协议化**：`codexErrorInfo` 把额度、限流、上下文超限、沙箱错误等归类成枚举并透传上游 HTTP 状态，前端可按类别做差异化 UX（如额度用尽引导、断流重试），而不是解析错误字符串。

## 附：本调研阅读的主要一手材料清单

- 博客：https://developers.openai.com/blog/codex-as-a-platform
- 官方文档：https://developers.openai.com/codex/app-server 、https://developers.openai.com/codex/non-interactive-mode 、https://developers.openai.com/codex/open-source
- 仓库（浅克隆 main，2026-08-27）：
  - `codex-rs/app-server/README.md`（协议权威文档）
  - `codex-rs/app-server-protocol/src/rpc.rs`、`src/protocol/`（消息信封与类型定义）
  - `sdk/typescript/README.md`、`sdk/typescript/src/exec.ts`
  - `sdk/python/README.md`、`sdk/python/src/openai_codex/client.py`、`api.py`、`_approval_mode.py`
  - `docs/exec.md`（仅一行，指向官方非交互模式文档）
