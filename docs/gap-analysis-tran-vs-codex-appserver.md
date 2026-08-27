# 差距分析：Tran ↔ Kimi Code 通信架构 vs OpenAI Codex app-server

> 日期：2026-08-27。
> Tran 侧现状来自对本仓库（`cli/src/main/agent/`）与 `C:/LegacyD/project/kimi-code` 的代码走读；
> Codex 侧事实来自同目录《调研：OpenAI Codex Harness（app-server）架构》（`research-codex-harness.md`，含一手来源清单）。
> 本文只做对比与启示，所有改动建议需另行评审。
>
> **重要约束（2026-08-27 修订）**：kimi-code 是 Moonshot 官方产品，**我们只能改 Tran 侧，改不了 kimi 侧**（本机 `C:/LegacyD/project/kimi-code` 仓库仅作参考源码）。因此本文所有建议只保留 Tran 侧可执行的路径；kimi 侧修法仅作为「若官方未来支持」的注记保留。

## 0. 一句话结论

Tran 的主链路（spawn 子进程 + stdio ndjson + 双向 JSON-RPC + 反向审批请求）与 Codex app-server **同构**，方向没有错；真正的差距集中在三点：**事件流完整性**（steered 唤醒/压缩不推送，Tran 被迫轮询 wire.jsonl）、**协议化的历史访问**（Tran 靠第二个进程 + 磁盘直读，Codex 有 `thread/list` / `thread/turns/list` 分页 API）、**多连接订阅模型**（Codex 一个 harness 进程服务多前端多窗口）。由于 kimi 侧改不了，Tran 的策略只能是：**把「协议外补盲」这层做成一个隔离的、可随 kimi 版本适配的适配器**——磁盘直读（wire.jsonl、tasks/*.json、sessions 目录）已经是事实，要做的是把它收敛成有版本守卫、有降级的单一模块，而不是散落在各处的临时补丁。

## 1. 对比总表

| 维度 | Tran（ACP over stdio） | Codex app-server | 差距 |
|---|---|---|---|
| 传输 | 仅 stdio ndjson，点对点 | stdio 默认，ws/unix socket 可选（带鉴权/健康探针） | 小（本地 GUI 够用） |
| 会话原语 | session / turn（ACP 两级） | Thread / Turn / Item 三级，item 十几种类型统一生命周期 | 中 |
| 流式事件 | `session/update` 单通道；**steered 轮、压缩零推送** | 一切 agent 活动皆为 item 流经标准通知；压缩是 `contextCompaction` item | **大** |
| 插话语义 | 只有 `session/cancel`；「催更」靠隐藏 turn 模拟 | `turn/interrupt` / `turn/steer` / `thread/queue/*` 各司其职 | 中 |
| 历史访问 | 另起进程跑 `session/list`；回放会丢压缩前内容，靠 wire.jsonl 全量重建 | `thread/list`（游标+过滤）、`thread/turns/list`、`thread/items/list`（分级加载）、`thread/read` 不 resume 只读 | **大** |
| 审批 | ACP 反向请求，optionId 词表（approve_once/always/reject） | 同为反向请求，另有 `acceptForSession`、持久规则沉淀（execpolicy/network amendment）、`serverRequest/resolved` 生命周期清理、`auto_review` 子 agent 审批 | 中 |
| 多前端共享 | 不支持：一个 `kimi acp` 进程只服务一个 client，跨前端只能磁盘层共享 | 多连接订阅、按连接 `optOutNotificationMethods`、闲置 30 分钟卸载、`thread/loaded/list` | 中 |
| 聚合视图 | 前端自行从 item 流拼装 | `turn/diff/updated`（整轮 unified diff 快照）、`turn/plan/updated` | 小 |
| 宿主工具供给 | stdio MCP server 进程 + 本地 WS 桥（mcp-browser/desktop） | MCP server，或实验性 `dynamicTools` + `item/tool/call` 宿主进程内直供 | 小 |
| 错误模型 | 错误字符串 | `codexErrorInfo` 枚举（额度/限流/上下文超限/沙箱…）协议化 | 小 |
| Schema 分发 | `@agentclientprotocol/sdk` 类型包 | 二进制自生成 `generate-ts`/`generate-json-schema` + `experimentalApi` 门控 | 相当 |
| 集成分层 | `kimi acp` 一档（另有 headless 能力未成体系） | exec → SDK → app-server 三层递进 | 小 |

## 2. 关键差距详析

### 2.1 事件流完整性：Tran 最大的痛点，Codex 的核心设计原则

**Tran 现状**：kimi 的 ACP server 对两类活动**零推送**——后台任务完成触发的 steered 唤醒轮（`agent.turn.steer`），以及上下文压缩（`full_compaction.*`）。实证见 `KimiBackend.ts:632-715` 长注释。Tran 的对策是 `maybeStartWireWatch/pollWire`（`KimiBackend.ts:716-825`）以 1s 轮询增量读 `wire.jsonl`，手工回放 steered 段并用「静默 4s + step.end」猜收尾。这是典型的协议覆盖不全导致 GUI 绕路读磁盘：脆弱（依赖内部文件格式）、有延迟（轮询）、语义靠猜（收尾判定）。

**Codex 做法**：一切 agent 活动都建模为 item，走统一通知流 `item/started → delta → item/completed`——压缩是 `contextCompaction` item，子 agent 活动是 `subAgentActivity` item，无一例外。前端没有任何「协议外补盲」的负担。

**启示**：根因修复只能在 kimi 侧（把 steered 轮与压缩映射为 `session/update`，改 `packages/acp-server/src/events-map.ts`），但我们改不了 kimi。Tran 侧的现实路径是把 wire 轮询收敛进统一的磁盘适配器并加固收尾判定（见 §3 第 1、2 条），同时把「协议给全事件时 GUI 代码该多简单」作为向官方提需求的依据。

### 2.2 协议化的历史访问：消灭第二个进程与磁盘重建

**Tran 现状**：(a) 为查历史会话要另起一个长寿 ACP 进程专跑 `session/list`（`kimiHistory.ts:10-22`）；(b) `session/load` 回放会应用压缩点、丢压缩前内容，Tran 只好 `flushWireHistory` 从 wire.jsonl 全量重建（`KimiBackend.ts:1928-1942`）。两处都是「协议给的不够，磁盘来凑」。

**Codex 做法**：历史访问全部协议化且不需要 resume——`thread/list`（游标分页 + modelProviders/sourceKinds/archived/cwd/searchTerm 过滤）、`thread/read`（只读不加载）、`thread/turns/list` / `thread/items/list`（分页 + `itemsView: notLoaded/summary/full` 分级加载）；resume 默认全量水合已废弃，改为 `excludeTurns: true` + 游标。token 用量也持久化并在 resume 时重放。

**启示**：理想解在 kimi 侧（`session/list` 下放 + 分页保真的 `session/history`），不可行。Tran 侧的次优解：历史列表改由磁盘适配器直接扫描 sessions 目录，第二 ACP 进程降级为后备（见 §3 第 3 条）；wire 重建链路保留但纳入适配器统一做格式守卫。

### 2.3 多连接订阅：当前不紧迫，但决定了架构上限

**Tran 现状**：ACP stdio 点对点，一个 `kimi acp` 进程只服务一个 client。多会话复用同一进程已支持（`acpToSession` 映射），但「同一 agent 进程被多个前端/窗口共享」不可能；跨进程共享只在磁盘层。

**Codex 做法**：订阅按连接管理——`thread/start`/`resume` 自动订阅当前连接，`optOutNotificationMethods` 按连接裁剪事件，`thread/unsubscribe` 退订后 30 分钟闲置卸载；ws/unix transport（虽标注 experimental）+ bearer 鉴权让远程前端成为可能；`thread/status/changed`（带 `activeFlags` 如 `waitingOnApproval`）让任何前端能渲染全局会话状态。

**启示**：Tran 短期内单窗口单进程够用，但「第二窗口」「移动端只读视图」「会话在 TUI 与 GUI 间热切换」这类需求一旦出现，stdio 点对点就是硬天花板。值得关注的是 Codex 把远程通道的成熟度（experimental）、鉴权（先于 initialize）、背压（有界队列 + `-32001` 可重试）都显式标注了——如果 kimi ACP 未来加 socket transport，这套边界划定方式可以直接照抄。

### 2.4 插话语义：steer 应该是协议原语，不是隐藏 turn

**Tran 现状**：只有 `session/cancel`。「待办催更」等需求用隐藏 turn（`turn.prompt` + 隐藏标记）模拟，还要用 `hasRunningDiskTasks` 守卫避免 steer 落进隐藏轮被吞（`kimiServerApi.ts:356-363`）。

**Codex 做法**：`turn/interrupt`（取消）、`turn/steer`（向进行中的 turn 追加输入，`expectedTurnId` 乐观并发校验）、`thread/queue/*`（持久化 FIFO 排队，空闲自动提交）三种语义各有方法；不可 steer 的特殊 turn 明确报 `ActiveTurnNotSteerable`。

**启示**：kimi 内部其实已有 `agent.turn.steer` 机制（后台唤醒就在用），只是没暴露到 ACP 面；把它提为 ACP 方法只能是官方行为。Tran 侧维持隐藏 turn 模拟，守卫逻辑保留。

### 2.5 审批：框架同构，差距在「决策升级」与生命周期清理

两者都是服务端反向 JSON-RPC 请求、前端同步应答，基本模式一致。Codex 多出三块值得借鉴：

1. **决策可沉淀为持久规则**：`acceptForSession`、`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`——用户不只「批准这一次」，还能把决定写进策略文件；`availableDecisions` 由服务端声明可选项集，前端不硬编码。ACP 的 `approve_always` 是最简版，但没有规则持久化与网络策略维度。
2. **`serverRequest/resolved`**：审批请求解决/清理后有显式确认事件，且 turn start/complete/interrupt 时服务端做挂起请求的生命周期清理——Tran 目前在 `pendingPermissions` 上自己做的重投递（`redeliverPendingPermissions`）、作废（`dropPendingPermissions`）逻辑，有一部分本可由协议保证。
3. **`auto_review`**：审批可路由给专门 prompt 的子 agent 自动决策，人工/自动走同一协议面。

### 2.6 其他小而实的差异

- **turn 级聚合事件**：`turn/diff/updated` 直接推整轮 unified diff 快照，Tran 目前需从 tool_call 流自行拼装 diff 视图。kimi ACP 加一个聚合事件即可。
- **错误枚举协议化**：`codexErrorInfo`（`UsageLimitExceeded`/`ContextWindowExceeded`/`rateLimitExceeded`…）让前端按类别做 UX，而不是解析错误文案。
- **dynamicTools**：Codex 实验性地允许宿主在 `thread/start` 注册进程内工具，agent 调用经 `item/tool/call` 反向请求宿主执行。Tran 的 mcp-browser/desktop 目前是「独立 stdio MCP 进程 + WebSocket 桥回主进程」两段式；若 kimi ACP 支持类似的进程内工具注册，可省掉一个进程和 WS 桥（连同配对 token 那套握手）。属于远期可选项。

### 2.7 项目归属：Codex 的 Project 是一等公民（2026-08-27 补查，推翻先前判断）

先前版本断言「Codex 也没有 thread 改挂项目的原语」——**这是错的**。补查 app-server README 与本机 Codex 数据目录（`C:/LegacyD/Programs/codex/state_5.sqlite`）后确认 Codex 有完整的项目归属体系：

- **协议面**（均为实验 API，README「API Overview」）：`project/list|read|create|import|update|move|delete` 一整套 SQLite 后端的 project 管理；`thread/start` 可带 `projectId` 直接归入项目；`thread/list` 可按 `projectId` 过滤（`null` = 未分配）；**改挂项目就是 `thread/metadata/update { projectId }`**（传空字符串清除归属）；变更后推 `thread/project/updated`、`project/changed` 通知；`project/import` 还能原子地把一批既有 thread ID 归入新项目。
- **存储面**（本机 sqlite 实证）：`threads` 表有独立的 `project_id` 列，与 `rollout_path`、`cwd` 是三列各管各的；`projects` + `project_roots`（有序绝对路径）+ `project_idempotency_keys` 三张表承载项目实体。
- **关键架构决策：rollout 存储位置与项目归属解耦**。Codex 的会话文件按**日期树**存放（`sessions/2026/07/...`、`sessions/2026/08/...`），不按项目目录命名空间。因此「移动会话到另一个项目」不涉及任何文件搬迁——只是 `UPDATE threads SET project_id=?`，rollout 文件原地不动。
- **语义边界**：改 `project_id` 改的是**组织归属**（侧边栏分组、过滤、项目级配置上下文），thread 的 `cwd` 不变——agent 恢复后仍在原工作目录执行。Codex 把「这个会话属于哪个项目」（元数据）和「这个会话在哪个目录干活」（cwd）拆成了两个维度。

对比 kimi：会话物理存在 `$KIMI_CODE_HOME/sessions/<workspace>/<sessionId>/`，**workspace 路径同时充当存储命名空间和组织归属**，两个维度焊死在一起——这是「会话随便移动」在 kimi 侧难做的根因。

**真实产品实测（2026-08-27）**：以上机制不只停留在文档——已在本机真实安装的 Codex 产品（codex-cli 0.150.0-alpha.8，`C:\Users\12517\AppData\Local\OpenAI\Codex`，CODEX_HOME=`C:\LegacyD\Programs\codex`）上走通完整闭环：spawn 官方 `codex.exe app-server` → `project/create` → `thread/metadata/update {projectId}` 改挂一个真实会话 → `thread/list {projectId}` 确认归属生效 → 再清除归属并删除项目恢复原状。过程中收到 `thread/project/updated`、`project/changed` 通知，会话 rollout 文件路径全程未动。实测还确认两点：会话的 `source` 可以是 `vscode`（多前端共享同一存储），且 `thread/list` 返回的 `path` 确为日期树 `sessions/2026/08/26/rollout-*.jsonl`。

## 3. 对 Tran 的可行动建议（按性价比排序，仅 Tran 侧可执行项）

前提：kimi 侧改不了。Codex 对照的价值在于——它展示了「harness 把该给的事件和历史都给全时，GUI 侧代码长什么样」，即 Tran 补短板的**目标形态**；手段上 Tran 只能靠磁盘直读和协议内现有方法逼近它。

1. **把磁盘补盲收敛成单一适配器模块**（最高优先级）：目前 wire.jsonl 轮询（`pollWire`）、wire 历史重建（`flushWireHistory`/`wireHistory.ts`）、磁盘 tasks 合并（`kimiServerApi.getSessionTasks`）是散点存在的三处「协议外依赖」。建议收敛为一个 `KimiDiskAdapter`：统一封装 sessions 目录布局、wire.jsonl/tasks 格式解析、kimi 版本探测与格式守卫（解析失败降级为「不推送」而非报错），所有协议外读取只走这一个口子。这样 kimi 官方哪天补了推送，或格式变了，只动一个文件。
2. **wire 轮询收尾判定加固**：现「静默 4s + step.end + 45s 兜底」是启发式。可在适配器内改用 wire.jsonl 自身的 turn 边界（下一个 `turn.prompt`/`turn.end` 类记录出现即收尾）替代纯静默计时，减少唤醒轮被截断或拖尾。纯 Tran 侧可做。
3. **历史列表绕开第二 ACP 进程**：`kimiHistory.ts` 为 `session/list` 另起长寿进程，成本是又一个 kimi 实例常驻。适配器可直接扫描 sessions 目录读元数据（标题/mtime/大小），配合已有的 `session/load` 做打开；把第二进程降级为「目录扫描失败时的后备」。
4. **会话跨项目移动（Tran 侧可做的版本）**：见 §3.1。
5. **审批 UX 不硬编码选项**：借 Codex `availableDecisions` 思路，渲染层按 kimi 返回的 options 动态渲染（目前 optionId 词表 `approve_once/approve_always/reject/plan_*` 已够用），为将来 kimi 扩词表留出兼容。
6. **【不可行，仅注记】**：steered/压缩事件推送、协议化 `session/history`、steer 提为 ACP 方法、多连接订阅——都依赖 kimi 官方改 ACP server，Tran 侧无法解决，只能等官方或通过需求渠道反馈。

### 3.1 会话跨项目移动：Tran 侧两条路径

上一轮讨论中「会话随便跨项目移动」，参照 Codex 的 Project 模型（§2.7），Tran 侧其实有三条路径，按推荐度排序：

- **路径 C（Tran 自建项目元数据层，推荐）**：照搬 Codex 的核心决策——**把组织归属从存储位置中拆出来**。Tran 自己维护一张 `sessionId → projectId` 的映射（自己的 sqlite/JSON，类似已有的 `sessionTitles.ts`、`archivedSessions.ts` 元数据思路，只是从单会话属性升级为项目实体 + 归属外键），UI 按 Tran 的项目分组会话。移动会话 = 改 Tran 自己的一行元数据，**零文件搬迁、零 kimi 格式依赖、纯 Tran 侧**。代价与边界：会话物理上仍属原 workspace，`session/load` 仍需用原 cwd，agent 恢复后也在原目录干活——和 Codex 改 `project_id` 不改 `cwd` 的语义完全一致。对「我就想按项目整理会话列表」这个真实需求，这条路已经够用。
- **路径 B（有损重植，低风险）**：在新项目开新会话，把旧会话的摘要/关键上下文（由 Tran 从 wire.jsonl 提取或由 agent 总结）作为首条消息注入。格式依赖小、语义明确（用户预期就是「带着上下文在新项目重新开」），但丢失完整逐字历史与可恢复性。
- **路径 A（无损物理迁移，高风险，一般不推荐）**：关闭会话后将 `sessions/<workspaceA>/<sessionId>/` 目录整体移到 `<workspaceB>/` 下，并改写 wire.jsonl / 状态文件里的 cwd 引用，再在新项目下 `session/load`。风险：sessions 目录布局与 wire 格式是 kimi 内部实现、无版本契约，格式一变就搬坏；且会话上下文里仍是旧项目的内容，agent 恢复后拿着旧路径在新目录工作，行为需要实测验证。仅当需求明确是「连工作目录一起搬」时才考虑，且必须先在 tran-qa-sandbox 做可行性实验。

Codex 的经验（§2.7）说明：主流产品的答案恰恰是**不做物理迁移**——rollout 按日期树全局存放、项目只是 sqlite 里的一个外键。kimi 把 workspace 焊进存储路径是它的实现选择，但 Tran 完全可以在自己的元数据层把这个结解开。

## 4. 若未来 Tran 要接 Codex 作为后端：一个必须知道的不对称

OpenAI 的 **TS SDK 只是 `codex exec` 的封装**（spawn 子进程交换 JSONL），没有审批回调、没有 steer、没有反向请求；**Python SDK 才是 app-server 全协议客户端**。Tran 是 Electron/TypeScript 产品，若接 Codex 不能依赖官方 TS SDK，需要自己实现 app-server JSON-RPC client（可用 `codex app-server generate-ts` 生成类型钉版本）。好消息是 Tran 的 `AcpClient` 已经是一个双向 JSON-RPC stdio client，传输层经验可直接复用；`AgentBridge` 的多后端路由（kimi/claude 并存）也证明加第三个后端在架构上有位置。届时真正的适配成本在会话模型映射：ACP 的 session 两级 ↔ Codex 的 Thread/Turn/Item 三级。

## 附：引用位置速查

- Tran 侧：`cli/src/main/agent/AcpClient.ts`、`KimiBackend.ts`（632-715 零推送实证、716-825 wire 轮询、1928-1942 wire 历史重建）、`kimiHistory.ts`、`wireHistory.ts`、`mcp-browser/index.ts`、`browserBridge.ts`；kimi 侧 `packages/acp-server/src/events-map.ts`、`approval.ts`
- Codex 侧：见 `docs/research-codex-harness.md` 各节来源标注（app-server README、rpc.rs、两个 SDK 源码、官方文档页）
