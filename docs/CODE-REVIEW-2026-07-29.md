# 代码审查报告 — 2026-07-29

审查对象：`MiracleCrane/tran` @ `ec22a2e`（v1.0.39）
审查方：Claude Code（claude-opus-4-8），六个并行子审查 + 人工复核
修复分支：`claude/software-testing-code-review-koli26`

---

## 0. 先读这一节：本次审查的可信度边界

给复审者（K3）的前置说明。**下面每条结论的证据强度不一样，请按标注区别对待。**

### 做到了什么

- 通读了 `cli/src/` 全部 28437 行 TS/TSX
- 六个子审查分区并行（agent 桥接 / IPC+主进程 / 渲染 store / 服务层 / 其余主进程 / 渲染组件）
- 重点结论由我本人重新打开对应行复核，不直接采信子审查的转述

### 没做到什么（重要）

| 项 | 状态 | 原因 |
|---|---|---|
| 实际运行应用 | ❌ 未做 | Windows 专用（`AcpClient.spawn` 对 `process.platform !== 'win32'` 直接抛错），审查环境是 Linux 容器 |
| `npm run typecheck` | ⚠️ 见文末「验证状态」 | Electron 二进制下载在审查环境受限，依赖安装反复失败 |
| `npm run build` | ❌ 未做 | 同上 |
| 端到端复现每个缺陷 | ❌ 未做 | 同「实际运行」 |

**所以：本报告是静态审查结论，不是实测报告。** 行号与代码逻辑是核对过的；「触发概率」「用户是否会遇到」这类判断是推理，未经实测。

### 一次已确认的误判（请重点看）

初版报告我把「输入法回车」列为最高优先级，措辞是「每个中文用户天天踩」。

**这个判断是错的。** 用户反馈从未遇到过。我随后用 CDP 实测（Chromium 141）：

```
[{"phase":"compositionstart"},
 {"phase":"keydown","key":"Enter","keyCode":13,"isComposing":true}]
```

这只证明**合成事件**下 `key === 'Enter'` 会命中。而真实 Windows 输入法确认候选词时，Chromium 按规范派发的是 `key: "Process"` / `keyCode: 229`，**不会命中** `e.key === 'Enter'` 分支 —— 所以在真实使用中不触发。

我的错误在于：看到「缺少 `isComposing` 判断」这个**代码模式**，就套用了「经典输入法 bug」的结论并加码断言用户影响，属于从模式推断而非验证。用户的实际使用经验是更强的证据。

修复仍然保留（见 F-14），但定性从「P0 活 bug」降为「P2 防御补齐」，注释里如实写明了实测结论。

**给 K3 的建议：本报告其余条目也请按同样标准质疑。** 凡是我标注「未实测」的，都可能存在同类的过度推断。

---

## 1. 结论摘要

| 级别 | 数量 | 说明 |
|---|---|---|
| P0（数据丢失 / 崩溃） | 3 | 一旦触发不可逆 |
| P1（泄漏 / 功能不工作 / 安全） | 9 | 长期使用可感知 |
| P2（健壮性 / 边界） | 10 | 潜伏，特定条件才显现 |

共 22 条，已全部修复。另有 **1 条开放问题**（MCP 写入路径，见 §4）未擅自改动，需要你确认。

**关于代码质量的公道话：** 28437 行找出 22 条，且大多是潜伏型边界情况，这个密度在真实项目里属于正常偏好。子审查明确「检查过、不是 bug」的清单同样长：`sessionDelete.ts` 的路径穿越防护、`kimiServerApi.ts` 的 `/^[\w-]+$/` 白名单、git porcelain `-z` 重命名解析、`getAheadBehind` 左右序、`drain` 重入保护（`session.running` 在首个 await 前同步置位）、hiddenTurn 互斥、`contextIsolation`+`sandbox` 正确开启、preload 用 contextBridge 正确封装、markdown 无 `dangerouslySetInnerHTML`/无 `rehype-raw` 因而无 XSS、`Transcript.tsx` 的 timer/observer/listener 全部正确清理。这些不是随手能蒙对的。

---

## 2. P0 缺陷

### F-01 `settings.ts` 读取失败会覆写真实设置，导致永久丢失

**位置：** `cli/src/main/settings.ts:271-287`（修复前）
**证据强度：** 逐行核对确认逻辑成立；未实测触发

```ts
try {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  cache = normalizeSettings(raw)
  ...
} catch {
  cache = normalizeSettings({})   // ← 读失败和文件损坏走同一条路
  cacheMtimeMs = mtimeMs
}
```

`readFileSync` 与 `JSON.parse` 共用一个 `try`，任一失败都退回空默认值并**写进 cache**。随后 `save()` 把这份空 cache 覆写回真实文件：

```
读取瞬时失败 → cache = {} → 用户改任意一项设置 → save() → 文件被空配置覆盖
```

丢失内容：providers、projects、apiKey、百度翻译密钥。**无备份、无原子写入，不可恢复。**

触发条件是读取瞬时失败，Windows 上由杀软/备份/索引程序占用文件（EBUSY/EPERM）产生。仓库 `AGENTS.md` 自己记录了「奇安信天擎会扫描占用文件导致 EPERM/EBUSY」，所以这不是纯理论场景。

**修复：** 新增 `readJsonSafe()` 区分 `missing` / `ok` / `failed` 三态。`failed` 时打 `loadFailed` 标记，内存里给默认值但 `save()` 拒绝落盘；`save()` 会先重试读取，成功则把本次改动合并到**磁盘上的真实设置**之上，仍失败则放弃本次持久化。

---

### F-02 `mcpConfig.ts` 解析失败时把 `~/.claude.json` 整个覆写

**位置：** `cli/src/main/mcpConfig.ts:27-33, 70`（修复前）
**证据强度：** 逐行核对确认；未实测触发

```ts
function readJson(path) {
  try { return JSON.parse(readFileSync(path,'utf8')) }
  catch { return {} }        // ← 解析失败 → 空对象
}

const root = existsSync(path) ? readJson(path) : {}
const servers = locateServers(root, cwd, scope)
servers[name] = config
writeJson(path, root)         // ← 用空对象+一个 mcpServers 覆写整个文件
```

`~/.claude.json` 与 `claude` CLI 共用，含认证、projects、历史。文件瞬时不可解析时添加一个 MCP server，会把它替换成只剩 `mcpServers` 的内容。**与模块自己的注释「leaving every other key untouched」直接矛盾。**

（`deleteMcpServer` 无此问题：key 不存在时会在写入前 `return false`。）

**修复：** `readRoot()` 在解析失败/非对象时**抛错、放弃写入**。`McpServerFormModal.tsx:182-186` 已有 try/catch 并展示错误文案，所以会变成用户可见的提示而非静默破坏。

---

### F-03 `AcpClient` 向已 kill 的进程写 stdin，且 stdin 无 error 监听 → 主进程崩溃

**位置：** `cli/src/main/agent/AcpClient.ts:135-139, 146-170, 234`（修复前）
**证据强度：** 逐行核对确认，不依赖运行时猜测

两个缺陷叠加成一条崩溃路径：

1. `close()` 只设 `closing = true`，**不设 `closed`、不置空 `child`**：
   ```ts
   close(): void {
     this.closing = true
     this.child?.kill()
     this.rejectAll(...)
   }
   ```
   而 `write()` / `request()` 的守卫是 `if (this.closed || !this.child)`。`'close'` 事件是异步到达的，在它到达前守卫**全部放行**，数据被写进刚 kill 的进程 stdin。

2. `spawn()` 给 `stdout`/`stderr`/`child` 都挂了监听，**唯独 `child.stdin` 没有 `'error'`**。往断开的管道写触发 EPIPE，Node 以 stdin 的 `'error'` 事件异步投递 —— 无监听器的流错误会**掀掉 Electron 主进程**。

**修复：** `close()` 同步置 `closed = true` 并断开 `child` 引用；`child.stdin` 补 `'error'` 监听（记录不抛）；`notify`/`respond`/`respondError` 改走 `writeQuiet()`（即发即忘路径吞掉写入异常，进程已退出是正常竞态）。

附带修复 `request()`：原本在返回 Promise 前**同步 throw**，绕过了调用方的 `.catch()`（`setModel`/`setPermissionMode` 都指望它），一路抛到 `prepareSession` 拆掉整个会话。改为返回 rejected promise。

---

## 3. P1 缺陷

### F-04 ACP 子进程退出时不回收（Windows 进程残留）

**位置：** `KimiBackend.ts` / `AgentBridge.ts:154-158`（修复前）
**证据强度：** 调用链核对确认 `client.close()` 只在 spawn 初始化失败路径被调用

`AcpClient.close()` 仅在 `spawn()` 的初始化失败分支被调用（`AcpClient.ts:184`）。`KimiBackend.close()` 和 `AgentBridge.shutdown()` 都只处理会话级清理并发 `session/cancel`，**没有任何路径 kill 子进程**。Windows 上子进程不随父进程退出而回收。

**用户可自行验证：** 关闭 Tran 后看任务管理器是否有残留的 kimi 进程。

**修复：** `AgentBackendAdapter` 新增可选 `dispose()`；`AgentBridge.shutdown()` 在会话清理后逐个调用；`KimiBackend.dispose()` 停掉所有 stall 定时器并 `client.close()`。

### F-05 `AcpClient.stderr` 无限增长

**位置：** `AcpClient.ts:69, 155-159`（修复前）

`this.stderr += chunk` 累积整个进程生命周期，只在 `close` 时被消费一次。长会话 + 话痨 agent → 主进程堆随 stderr 量线性增长。
**修复：** 保留尾部 64KB（`STDERR_KEEP_CHARS`）。

### F-06 多个 JSON store 非原子写入

**位置：** `mcpConfig.ts:35-37`、`goalStore.ts:46-54`、`aiTitles.ts:50-57`、`sessionTitles.ts:35-87`（3 处）、`quotaService.ts:75-88`、`usageService.ts:98`

全是裸 `writeFileSync`，无 tmp+rename。写入中崩溃/断电 → JSON 截断 → 下次 `load()` 命中 catch → 静默重置为 `{}`，goals / AI 标题 / 会话标题 / token 全部丢失。

**注：`sessionDelete.ts:80-82` 已经正确使用 tmp+rename**，正确写法本来就在代码库里。
**修复：** 新增 `cli/src/main/atomicWrite.ts`（`writeFileAtomic` / `writeJsonAtomic` / `readJsonSafe`），六处统一改用。

### F-07 `setWindowOpenHandler` 不校验协议就 `openExternal`

**位置：** `index.ts:229-232`（修复前）
**类别：** 安全

```ts
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  void shell.openExternal(url)      // ← 无任何校验
  return { action: 'deny' }
})
```

紧邻的 `will-navigate`（234-244）却限制了 `http/https/mailto`，**两处不一致**。渲染层被注入或出 bug 时，`window.open('file:///…')`、`smb:`、自定义协议处理器都会被直接交给操作系统。

**修复：** 抽出 `EXTERNAL_PROTOCOLS` 白名单与 `openExternalSafely()`，两处共用；同时统一处理 `openExternal` 的 promise 拒绝（未注册协议处理器时会 reject）。

### F-08 后台会话的流式 delta 抢占前台显示预算

**位置：** `streamBatcher.ts:40, 95-119, 160-197`（修复前）
**证据强度：** 逻辑推导确认；未实测观感影响
**⚠️ 与 v1.0.39 的调速工作直接相关，请重点复审**

`pending` 是单一全局队列，混装前台与所有后台会话的 delta，而 `applyStreamBatch`（`sessionStore.ts:3002-3023`）会把后台 delta 立即折进各自的离屏缓冲。两个后果：

- **A：** 后台会话的 delta 排在前台之前，消耗 `drainBudget` 的每帧字符预算 —— 预算被永远看不见的文字吃掉，可见文字变慢。
- **B：** 后台会话的任何非 delta 事件（`tool_progress` / `result` / `system` / `agent:ended`）进入 `pushAgentEvent` 都会触发 `flushAll()`，取消 rAF 并**把前台缓冲整块倒出**，直接破坏 v1.0.39 刚调好的匀速吐字。

**修复：** `pushAgentEvent` 按 `e.sessionId === meta?.sessionId` 分流。后台 delta 直接 `applyStreamBatch([batch])`（不排队、不计预算、不触发 rAF）；后台结构性事件不再 `flushAll()`（不同会话状态独立，顺序按会话保证）。前台路径逻辑完全不变，速率常量一个没动。

### F-09 `Transcript` 用过滤后下标做 key，流式期间工具卡片 remount

**位置：** `Transcript.tsx:427-429`（修复前）

```tsx
item.blocks.filter((b) => !!b).map((block, i) => ... key={i})
```

`blocks` 在流式期间含 `undefined` 空洞（子代理事件交错，文件头注释自己写了）。用**过滤后**下标做 key，空洞被填上时后续 key 整体前移：

```
blocks = [text, <hole>, tool]  → 过滤后 key: 0(text), 1(tool)
hole 填入 thinking             → 过滤后 key: 0(text), 1(thinking), 2(tool)
                                          ↑ key=1 从 tool 变成 thinking
```

React 认为是不同元素 → 工具卡片在 key=2 重新挂载，`ToolCallCard`/`ThinkingBlock` 的展开状态（`userToggled`）、滚动位置丢失或错位。

**修复：** 改用**过滤前**的原始下标（先 `map` 成 `{block, index}` 再 filter），空洞填充不影响后续 key。

### F-10 附件不按会话隔离

**位置：** `Composer.tsx:287`（修复前）

草稿文本按 `draftKey` 正确隔离（`sessionStore.composerDrafts`），但 `attachments` 是常驻挂载组件的本地 state，**切会话不重置**。在 A 会话加附件不发 → 切到 B → 附件跟着 B 发出去。

`attachmentActionSeqRef` 也不重置，切换后才 resolve 的 `readFiles`/`FileReader` 会把上个会话的文件追加进来。

**修复：** `useEffect` 依赖 `draftKey`，切换时清空 attachments 并递增 seq 作废在途读取。

### F-11 `usageService.expiryMs` 对数字型 `expires_at` 返回 NaN

**位置：** `usageService.ts:50-53`（修复前）

```ts
const parsed = Date.parse(String(creds.expires_at ?? ''))
```

接口声明 `expires_at?: string | number`（`:32`）。若 CLI 写入 epoch 数字，`Date.parse("1690000000000")` → `NaN` → 记为 `0` → `expiryMs - SKEW < Date.now()` **恒为真** → 每次调用都强制刷新。因 `refresh_token` 轮换且每次写回，会**把轮换 token 转个不停**并反复写盘。

**修复：** 数字（区分秒/毫秒量级）与 ISO 字符串分别处理。

### F-12 并发 token 刷新重复消费轮换 token

**位置：** `quotaService.ts:134-156`、`usageService.ts:84-103`（修复前）

两者都无在飞去重。`fetchQuotaOverview` 与 `fetchQuotaActions` 是独立入口，`usageService.getValidAccessToken` 被 `aiTitles` 复用（`:83` 注释写明）。并发时两个调用拿**同一个** `refresh_token` 去换，服务端轮换后第二个持已作废 token → 失败 → 该调用方误报「需要重新登录」。

**修复：** 两处各加在飞 promise 合并。

### F-13 `translate.ts` / `baidu.ts` 的 fetch 无超时

**位置：** `translate.ts:61`、`baidu.ts:64`（修复前）

其余所有网络调用都用 `AbortController` + `setTimeout`（`quotaService.ts:107`、`usageService.ts:57`、`kimiServerApi.ts:127`），唯独这两处没有。连接挂起 → promise 永不落地 → 调用方（技能面板等）一直转圈。
**修复：** 补 30s 超时 + JSON 解析保护。

---

## 4. P2 缺陷（逐条从简）

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| F-14 | `Composer.tsx:760` | 回车/上下键不判断输入法组词 **（见 §0，非活 bug，防御补齐）** | 加 `isComposing \|\| keyCode===229` 早退 |
| F-15 | `ipc.ts:800-852` | swarm 轮询定时器不 `unref`，窗口销毁/退出时不停 | `unref()` + 窗口失效即停 + `before-quit` 钩子 |
| F-16 | `sessionStore.ts:871-876` | 后台会话全在跑时 `find(!running)` 返回空 → `break` → Map 无上限增长 | 超硬上限（2×）后按插入序淘汰最旧的 |
| F-17 | `sessionStore.ts:283` | `sessionHistoryCache` 的 `lastTouched` 一直写但从不用于淘汰 | 实现 LRU（上限 24，跳过在途请求） |
| F-18 | `sessionStore.ts` ×4 | 切会话四条路径漏重置 `slashCommands`（其余同级字段都重置了） | 四处补 `slashCommands: []`（**init 处理器故意不加**：斜杠命令可能早于 init 到达） |
| F-19 | `sessionStore.ts:1282-1298` | init 看门狗 60s 定时器从不取消，快速切换会攒一堆 | 单例化，排新的前先 clear |
| F-20 | `sessionStore.ts` ×2 | `answerElicitation`/`respondPermission` 乐观移除后 IPC 失败不回滚 → 卡片消失但 turn 仍在等回复 | try/catch 回滚并重抛 |
| F-21 | `updater.ts:206-209` | 下载流出错时 `createWriteStream` 未 destroy → fd 泄漏 + 残留半个 exe | 补 `file.destroy()` |
| F-22 | `updater.ts:35-45` | 版本比较把 `1.2.0-beta` 与 `1.2.0` 视为相等 | 补预发布标识比较 |
| F-23 | `KimiBackend.ts:211-223` | `error` 为 null 时取 `.data` 抛 TypeError，掩盖原始错误 | 抽 `errorHaystack()` 统一防护 |
| F-24 | `KimiBackend.ts` | `handleClientClose` 不停 stall 定时器；`session/new` 在途被关闭时 `pendingNotifications` 泄漏 | 两处补清理 |
| F-25 | `kimiServerApi.ts:204` | `/error/i` 会命中任何含 error 的输出，误杀已启动的 server | 收紧为 `fatal error\|panic:\|EADDRINUSE\|error:` 等 |
| F-26 | `git.ts` ×4 | ref 名以 `-` 开头会被 git 当选项（参数注入，非 shell 注入） | 加 `assertRef()` 校验 |
| F-27 | `ipc.ts` | 项目路径入参未校验类型；导出诊断报告 `writeFileSync` 无保护 | `requireString()`；改结构化返回 |

### 关于 F-26 的一个反面记录（请复审者注意）

我最初的修复是给这些命令加 `--` 分隔符。**实测发现这会直接改坏功能：**

```
$ git checkout -- feature
error: pathspec 'feature' did not match any file(s) known to git
```

`git checkout -- <name>` 语义是「从索引恢复该路径的文件」，**不是切换分支**。若合入，切分支功能会完全失效。

进一步实测（git 2.43）：`--end-of-options` 在 `branch`/`revert` 上可用，但 `checkout` 不支持。因各子命令语义不一致，最终改为**校验入参**（拒绝 `-` 开头），这是唯一对所有子命令都安全的做法。

**这条记录本身比修复更值得看**：它说明「看起来正确的安全加固」也可能引入功能回归，静态审查必须配实测。

---

## 5. 开放问题（未擅自修改，需你确认）

### Q-01 MCP 写入路径可能与 Kimi 后端不通 —— 疑似「加了没反应」

`mcpConfig.ts` 的模块注释写着：

> Persists MCP servers to the same config files **`claude mcp`** uses, since the **Agent SDK** has no API for writing them

这是**旧 Claude 后端的残留**。当前代码库所有路径都指向 `~/.kimi-code/`（sessions、credentials、server.token、bin），唯独这里写 `~/.claude.json`。`App.tsx` 里的 TODO 也印证迁移未完成（「providers 面板深度绑定旧 Claude 后端，kimi-only 阶段入口已隐藏」）。

**读写两端不通：**

| 方向 | 实现 |
|---|---|
| 读 | 跑隐藏 `/mcp` 轮问 Kimi CLI 要列表，缓存进 `session.mcpServers`（`KimiBackend.ts:1013`） |
| 写 | 写 `~/.claude.json`（Kimi 不读） |

**推论（未实测）：** 在 Tran 界面添加 MCP server 大概率是空转的 —— 写进了 Kimi 不读的文件，面板刷新时又去问 Kimi，自然看不到。

**为什么我没改：** 仓库里查不到 Kimi Code 从哪读 MCP 配置（`/mcp` 由 CLI 自己管）。乱改路径会比现状更糟。

**建议你验证（几分钟）：**
1. 在 Tran 里添加一个 MCP server，看面板刷新后是否出现
2. 看你机器上是否被凭空创建了 `~/.claude.json`

确认后再决定：改写 Kimi 的配置路径，还是暂时把入口禁用并给出说明。

---

## 6. 验证状态

**诚实结论：以下改动未经编译验证。**

审查环境无法完成依赖安装（Electron 二进制下载受限，多次 `npm install` 因并发/网络失败），因此 `npm run typecheck` 与 `npm run build` **均未执行**。

已做的替代验证：

| 项 | 方式 | 结果 |
|---|---|---|
| git `--` 分隔符语义 | git 2.43 真实仓库实测 | ✅ 证伪了原方案，已改 |
| 输入法组词事件 | Chromium 141 + CDP `Input.imeSetComposition` | ✅ 证伪了原判断，已降级 |
| 引用一致性 | 逐文件 grep 残留的 `writeFileSync`/`mkdirSync`/`dirname` | ✅ 无残留 |
| 新增类型字段 | `DiagnosticReportResult.error` 已在 `shared/ipc.ts` 补充 | ✅ |

**合入前必须在你的 Windows 环境执行：**

```bash
npm run typecheck    # 主进程 + 渲染进程
npm run build
```

重点复查项（我改动了但无法验证的）：

1. **`streamBatcher.ts` 的分流**（F-08）—— 与 v1.0.39 的调速工作直接相关，建议对照 `__streamProbe.dump()` 确认前台吐字节奏无变化
2. **`Transcript.tsx` 的 key 改动**（F-09）—— 需确认长会话流式期间工具卡片展开状态正常
3. **`settings.ts` 的 `loadFailed` 分支**（F-01）—— 建议手工造一次读取失败（占用文件）验证不会覆写
4. **`AcpClient.close()` 的同步置位**（F-03）—— 确认正常关闭会话/退出应用无回归

---

## 7. 变更清单

新增：
- `cli/src/main/atomicWrite.ts`（`writeFileAtomic` / `writeJsonAtomic` / `readJsonSafe`）

修改（主进程 17 个 + 渲染 4 个 + 共享 1 个）：

```
cli/src/main/agent/AcpClient.ts      F-03 F-05
cli/src/main/agent/AgentBridge.ts    F-04
cli/src/main/agent/KimiBackend.ts    F-04 F-23 F-24
cli/src/main/aiTitles.ts             F-06
cli/src/main/baidu.ts                F-13
cli/src/main/git.ts                  F-26
cli/src/main/goalStore.ts            F-06
cli/src/main/index.ts                F-07
cli/src/main/ipc.ts                  F-15 F-27
cli/src/main/kimiServerApi.ts        F-25
cli/src/main/mcpConfig.ts            F-02 F-06
cli/src/main/quotaService.ts         F-06 F-12
cli/src/main/sessionTitles.ts        F-06
cli/src/main/settings.ts             F-01
cli/src/main/translate.ts            F-13
cli/src/main/updater.ts              F-21 F-22
cli/src/main/usageService.ts         F-06 F-11 F-12
cli/src/renderer/components/Composer.tsx    F-10 F-14
cli/src/renderer/components/Transcript.tsx  F-09
cli/src/renderer/store/sessionStore.ts      F-16 F-17 F-18 F-19 F-20
cli/src/renderer/store/streamBatcher.ts     F-08
cli/src/shared/ipc.ts                       F-27
```

---

## 8. 给复审者（K3）的几个具体请求

1. **§0 的误判记录请先看**。本报告其余「未实测」条目可能存在同类过度推断，欢迎直接推翻。
2. **F-08 是风险最高的改动**，它落在你刚做完四轮调优的 `streamBatcher` 上。我尽量做到前台路径逻辑与速率常量零改动，但仍需你确认观感。
3. **F-18 我故意留了一处不改**（init 处理器不清 `slashCommands`），理由是斜杠命令可能早于 init 到达。若你确认顺序有保证，可以补上。
4. **F-16 的硬上限 2× 是我拍的**，没有依据。若你有更合理的策略（比如按内存占用而非条数）请替换。
5. **Q-01 需要产品决策**，不是纯技术问题。
