# Open Issue 逐条核查 — 2026-07-29

对 `MiracleCrane/tran` 全部 **37 个 open issue** 逐条对照 v1.0.39 代码核查。

**⚠️ 我没有权限关闭 issue** —— 本会话的 GitHub token 只读，写操作返回
`403 Resource not accessible by integration`。下面的「建议关闭」需要你手动执行。

**核查方式：** 五组并行读代码，每条结论都要求给出 `file:line` 证据。
**没有实测**（Windows 专用应用，审查环境是 Linux）—— 结论基于代码而非运行。

---

## 一、建议直接关闭（22 条）

代码里已确认修复，证据充分。

| # | 标题 | 关键证据 |
|---|---|---|
| 10 | 输入框多行自动扩展 | `Composer.tsx:374-383` 测量 effect + `:83-94` 上下限 + `styles.css:1676-1685` `overflow-y:auto` |
| 14 | 新建会话目录跟随所选目录 | `sessionStore.ts:2022,2070` 直接取 `meta.cwd`；`projects.ts:68-81` 归一化比较 |
| 15 | MCP 信息展示 + status 命令 UI | `McpStatusBar.tsx:17-23` 目标格式；`KimiBackend.ts:1891-1908` 解析；`QueryResultCard.tsx` 专用卡 |
| 21 | 额度明细 | `quotaService.ts:267-325` 解析；进度条在 `UsageRings.tsx:57-86`（**不在 QuotaPanel**）；明细 `QuotaPanel.tsx:228-279` |
| 27 | 僵尸 turn 自动恢复 | `KimiBackend.ts:410-439` cancel + 2s grace + 重试一次，三个调用点全覆盖 |
| 28 | UI 三小项 | (a) `ChipPopover.tsx:74-80`；(b) `styles.css:2804-2812` + SVG 勾；(c) `ToolCallCard.tsx:57-109` |
| 29 | Ctrl+S 消息被吞 | `Composer.tsx:721-728` + `sessionStore.ts:1582` unacked 台账 + `:3034-3045` 回收 |
| 30 | Bash 卡片 JSON 尾巴 | `ToolCallCard.tsx:114-126` 拒渲染 + `KimiBackend.ts:1420-1427` 两道后端守卫 |
| 31 | 草稿丢失 | `sessionStore.ts:1406-1414` `composerDrafts` + localStorage 写穿 |
| 32 | 后台子代理状态/计时 | `toolStats.ts:85-100` + `taskRows.tsx:45-58` |
| 33 | 更新不走代理 | `updater.ts:1` 只 import electron `net`，无 `node:https` |
| 34 | 面板全显示运行中 | `kimiServerApi.ts:258-313` 磁盘任务源替代纯 REST |
| 38 | 自动增高回归 | `Composer.tsx:374-383` 与 v1.0.31 逐字节相同；真凶是持久化高度，现已只读不写 |
| 40 | 后台命令摘要 | `KimiBackend.ts:2180-2200` `salvageStreamingInput` + 前后台两条 ingest 都合并 |
| 41 | 15 分钟硬超时 | `KimiBackend.ts:1088` 传 `0`；`900` 字面量全文消失；活跃看门狗 `:480-505` |
| 42 | 幽灵空项目 | `projects.ts:26-28` 归一化去重；`addProject` 只有两个显式用户入口 |
| 44 | 待办条宽度 | `PlanCard.tsx:65-67` `max-w-[92%]` |
| 45 | 历史图片 | `sentImages.ts` IndexedDB 侧存 + `Transcript.tsx:555-574` 匹配 |
| 46 | chip 流光 | `styles.css:2599-2614` + `Composer.tsx:876,890,904` 三个 chip 全接 |
| 48 | 消息导航条 | `UserMessageNav.tsx` + `Transcript.tsx:1130` |
| 49 | 待办卡卡旧帧 | `KimiBackend.ts:1340-1355` plan 分支在 hiddenTurn 吞噬前 return |
| 50 | 导航条偏移/长跳卡顿 | `Transcript.tsx:678-722` DOM 几何 + `:661-670` 长跳 auto |

### 关闭时值得留一句话的三条

- **#21** —— 进度条被有意上移到 `UsageRings` 悬停卡，只看 `QuotaPanel.tsx` 会误判为「还没做」
- **#38** —— issue 里猜的根因（#31 store 重构影响 deps）**是错的**；真凶是持久化的手动高度。现在的 effect 和 v1.0.31 逐字节相同
- **#37** —— 月海斑纹确实去掉了，但视觉已在 v1.0.34 按你的选择改成彗星环绕，不再是「纯渐变球」。**建议你自己确认后再关**

---

## 二、本次已修（4 条，可在验证后关闭）

提交 `b4496d5`。

### #25 kimi-server 反复起不来 —— **真的还在，而且是被 #34 掩盖后回归的**

这条是本次核查最有价值的发现。

`ensureKimiServer`（`kimiServerApi.ts:228-248`）**没有任何失败记忆**：每次调用都是
probe → 失败 → `spawnServer()`，而 `spawnServer` 要等满 `SERVER_BOOT_TIMEOUT_MS`
(10s) 才判死。

`ipc.ts:833-836` 那套 15s→60s→5min 退避看似能兜住，但它**只在 `tasks === null`
分支才走**（`:848-856`）。而 #34 引入磁盘任务回退后：

```ts
// kimiServerApi.ts:318-320
const handle = await ensureKimiServer()
const disk = readDiskTasks(sessionId)
if (!handle) return disk.length > 0 ? disk : null   // ← 磁盘有记录就返回非 null
```

于是 server 挂着时 `getSessionTasks` 依然返回非 null → `swarmFailures = 0`
（`ipc.ts:858`）→ **退避阶梯永远不启动** → 每 2~15s 就重新 spawn 一次 `kimi web`。
用户看到的正是「每十几秒一轮」。

**修复：** `ensureKimiServer` 加 5 分钟拉起冷却。探测不受影响（server 真起来了
仍会被前面两步探测命中），只挡住反复 spawn。

**副作用提示：** 冷却期内 `getSessionTasks` 会快速返回，顺带缓解了「每次轮询都
要等满 probe+boot timeout」的延迟问题。

### #18(1) 冷启动慢

`sweepOrphanSessionDirs()` 是**同步全树遍历**（`readFileSync` 整个索引 + 逐项目
目录 `readdirSync`/`statSync`/`rmSync`），此前排在 `createWindow()` **之前**
（`index.ts:335` vs `:350`），直接把窗口创建卡住。已移到窗口创建之后 +
`setImmediate` 让出一轮。

**注意：#18 没有完全修完** —— 见第三节。

### #35 返回按钮（补齐两个漏网面板）

五个面板（Settings/Skills/Help/Translate/Providers）确实已吸顶。但
**`McpPanel` 和 `WslHealthPanel` 压根没有返回入口**（grep `setView` 零命中），
用户只能从侧栏离开。已补吸顶返回栏。

### #36 发送后回底（补齐排队路径）

已修的是直发路径（新用户消息进 `items` 触发 effect）。但 turn 忙时
`sendMessage` 推的是 `pendingQueue`（`sessionStore.ts:1579-1580`），`items` 不变，
effect 不触发 —— **而排队正是运行中发送的默认路径**。已补一条监听队列变长的
effect（只在变长时触发，出队不抢滚动位置）。

---

## 三、仍未修完，建议保持 open（8 条）

这些我**没有动**：要么是设计级决策，要么改动风险高于收益，需要你定夺。

### #3 [P0-top] ACP 超时中断 —— 大部分已修，**缺重连**

已修：turn 硬超时取消（`AcpClient.ts:106-118` 支持 `timeoutMs<=0`）、僵尸 turn
恢复、切走后台保活、`bridgeEnded` 后下次发消息惰性 resume（`sessionStore.ts:1482-1514`）。

**未修：** `handleClientClose`（`KimiBackend.ts:1573-1586`）在 ACP 子进程死亡时
**无条件把所有会话强制 ended**，进行中 turn 的输出丢失，只有用户再次输入才恢复。
另外 `initialize` 60s / `session/new` 120s / `session/load` 120s 超时仍会
直接销毁会话且无重试。

**为什么没改：** 加自动重连是架构级改动（需要决定重连策略、状态一致性、
重放语义），不该我擅自加。

### #5 [P0-top] 运行状态可见性 —— 三分之二已修

侧栏运行标识（`Sidebar.tsx:1500`）、输入区忙碌原因（`Composer.tsx:908-916`）都有了。

**未修：** 「重启后恢复进行中状态」。`running` 纯内存态，退出时
`AgentBridge.dispose()` 还会 kill 掉 ACP 子进程 —— 重启后确实没有东西在跑，
显示「无运行中」技术上诚实。但你的原意如果是「告诉我上次是哪个会话中途断的」，
那需要持久化一个未完成 turn 标记，是新功能。

### #6 [P0-top] 后台续跑 —— 已实现，三个洞

架构确实落地了（`closeSession` 改为 background 语义、per-session 缓冲、attach 不重放）。

遗留：
1. swarm 任务轮询是**单例**、只跟前台会话（`ipc.ts:865-871`），后台会话拿不到任务更新
2. 权限请求载荷**没有 sessionId**（`shared/ipc.ts:46-53`），后台会话的授权弹窗会挂在当前会话名下
3. 缓冲淘汰超上限时会 `destroySession` **正在跑的**会话（我这次把无上限增长修了，
   但「淘汰活跃会话」这个取舍本身仍在）

### #18 [P2] 启动性能 —— 只修了阻塞那半

**未修：渲染层零代码分割。** `electron.vite.config.ts` 单入口、无 `manualChunks`；
`App.tsx:1-32` 静态 import 了所有重面板（`Sidebar` 1700 行、`GitToolbar` 1088、
`SettingsPanel` 807…），全仓 `lazy(`/`Suspense`/动态 `import(` **零命中**。

**为什么没改：** 加 lazy loading 会改变首屏与面板切换的行为，需要你确认取舍。

### #24 [P1] GPU 内存 —— 基线已降，持续上涨无法判定

基线修复可验证：遮挡节流恢复（`CalculateNativeWinOcclusion` 已删）、
环境粒子 canvas 全消失、glass 滤镜从默认路径剥离。

**无法判定：** 「空闲 7 分钟涨到 1GB+」是运行时增长，静态读代码证不了也证不伪。
代码里没有任何 GPU 内存看护（无周期清理、无 `--force-gpu-mem-available-mb`）。

**值得注意的矛盾：** `index.ts:179` 仍设 `backgroundThrottling: false`，
这与「恢复遮挡节流」的修复方向相抵触 —— 合成器停了，但渲染进程的
timer/rAF 仍全速跑。**建议你评估这个值是否还需要。**

### #26(b) [P2] 丢弃空壳后疑似静默退出 —— 无法判定

`discardEmptyShell` 里没有任何 `app.quit`/`close` 路径，且该日志本来就是
正常退出流程的最后一行（`before-quit` → `shutdown()` → 丢弃空壳），
**日志顺序是果非因**。但「找不到代码路径」不等于「symptom 不存在」——
GPU/渲染进程崩溃、`shutdown()` 里的未处理拒绝、外部 kill 都会产生同样日志尾巴。

### #43 [P1] 消息时间戳 —— live 有，历史空白（有意为之）

`messageTimes.ts:11-16` 明确跳过 `isHistory` 项，注释说明 ACP 重放不带
消息级时间，选择「诚实缺省」而非编造。

**如果你的原意是「重开会话后每条消息都要有时间」，这条还没做完。**
值得一提的是 #45 面对同类问题（ACP 重放丢数据）选择了建 IndexedDB 侧存，
同样的机制也能解决时间戳 —— 两条 issue 的处理策略不一致。

### #37 [P1] 思考月亮 —— 斑纹已去，但已非「球」

见第一节的备注，需要你确认。

---

## 四、几个「已修但有残留」的提示

不足以让 issue 保持 open，但值得知道：

| 来源 | 残留 |
|---|---|
| #38 | `beginTextareaResize` 在 **pointerdown** 就锁定手动高度（`Composer.tsx:592-593`），拖拽把手是贴着输入框上沿的全宽透明条 —— 误点一下就关掉自动增高（重启自愈，且有重置按钮） |
| #39 | 子 Agent chip 自身在运行时会从 `子 Agent (N)` 变成 `子 Agent (N/M)`（v1.0.38 加的），宽度变化会推动待办 chip —— 三个 chip 不再严格像素固定 |
| #23 | `pendingPermissions` 不在后台缓冲里，且权限载荷无 sessionId → 后台会话的授权弹窗归属错乱（同 #6 的洞 2） |
| #45 | 纯图片无文字的消息**永久无法恢复**（匹配按文本，空文本直接 skip） |
| #32 | `swarmTasks` 为 null 时，chip 显示「0 运行中」而行仍渲染为运行中 —— 两处不一致（注释说明是有意的） |
| #34 | `SubagentMonitor.tsx` 是**死代码**（全仓无 import），它那套纯 ACP 事件推导状态的逻辑仍是旧的错误实现 |

---

## 五、统计

| 分类 | 数量 |
|---|---|
| 建议直接关闭 | 22 |
| 本次已修（验证后可关） | 4 |
| 建议保持 open | 8 |
| 需你确认后决定 | 3（#37 #43 #26b，已含在上面 8 条内） |

本次改动已通过 `npm run typecheck` 与 `npm run build`（详见
`docs/CODE-REVIEW-2026-07-29.md` §6）。但**运行时行为未验证** —— 应用是
Windows 专用，审查环境跑不起来。关闭 issue 前建议在你本机实际验证一遍，
尤其是 #25（看日志里 `spawning kimi server run` 是否还在每十几秒刷一次）。
