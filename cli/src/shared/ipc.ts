import type { AgentBackendId, AgentBackendInfo } from './agentBackends'
export type { AgentBackendId, AgentBackendInfo } from './agentBackends'

/** 结构化的 agent 消息信封。后端（如 Kimi ACP）按 Claude Agent SDK 的消息
 *  形状构造事件，渲染进程按 `type` 字段做结构化收窄；Tran 不再直接依赖
 *  @anthropic-ai/claude-agent-sdk。 */
export type SDKMessage = Record<string, unknown> & { type: string }

/** 权限建议的不透明负载（原 SDK 的 PermissionUpdate），仅透传到 UI。 */
export type PermissionUpdate = Record<string, unknown>

export type EffortLevel = 'low' | 'high' | 'max'
/** Kimi ACP 的真实模式（session/new configOptions.mode 实测值）：
 *  default=每次询问, plan=只读计划, auto=自动批准安全操作, yolo=全部自动批准。 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'auto'
  | 'yolo'

export interface StartSessionOptions {
  cwd: string
  /** Which pluggable agent backend should own this session. */
  agentBackend?: AgentBackendId
  /** Optional API key override. If omitted, the SDK uses the logged-in profile / env. */
  apiKey?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /** Resume an existing session by id. */
  resume?: string
  /** Pre-generated bridge map key, so the renderer can send messages before the
   *  claude.exe subprocess finishes spawning. */
  bridgeSessionId?: string
}

export interface StartSessionResult {
  sessionId: string
}

/** main -> renderer: a streamed SDK message or a session-ended signal. */
export type AgentEvent =
  | { type: 'agent:message'; sessionId: string; message: SDKMessage }
  | { type: 'agent:ended'; sessionId: string; error?: string }

export interface PermissionRequestPayload {
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  decisionReason?: string
  agentID?: string
}

export interface PermissionResponsePayload {
  toolUseID: string
  behavior: 'allow' | 'deny'
  message?: string
  answers?: Record<string, unknown>
}

export interface SessionListItem {
  sessionId: string
  agentBackend?: AgentBackendId
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
  runtimeBackend?: ClaudeExecutionBackend
  /** 该会话当前有 turn 在跑（主进程内存状态合并；后台会话切走后仍在跑）。 */
  running?: boolean
}

/** main -> renderer 推送：某会话 turn 开始/结束（forge:session-running-changed）。
 *  sessionId 是桥接 id（与 forge:agent-event 一致），acpSessionId 是 agent 侧
 *  会话 id（与 SessionListItem.sessionId 一致，侧栏列表关联用）。 */
export interface SessionRunningChangedPayload {
  sessionId: string
  running: boolean
  acpSessionId?: string
  /** 本轮 turn 开始时间戳（running=true 时带上；#41 忙碌态 mm:ss 计时用）。 */
  startedAt?: number
}

export interface SessionListOptions {
  limit?: number
  offset?: number
  backend?: ClaudeExecutionBackend | 'all'
  /** 列表范围：project=仅当前项目目录；all=跨全部项目（空会话过滤两种都生效）。 */
  scope?: 'project' | 'all'
}

/** Connection state of an MCP server, as reported by the Claude Agent SDK. */
export type McpServerStatusKind = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

/** A renderer-facing view of one MCP server. Mirrors the SDK's McpServerStatus,
 *  trimmed to the serializable fields the panel needs. */
export interface McpServerEntry {
  name: string
  status: McpServerStatusKind
  /** Where it was configured: project (.mcp.json), user, local, … */
  scope?: string
  /** Reported by the server once connected. */
  serverInfo?: { name: string; version: string }
  error?: string
  tools?: { name: string; description?: string }[]
  /** 工具数（kimi /mcp 只给计数、不给明细；与 tools 数组二选一）。 */
  toolCount?: number
  config?: {
    type: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    /** Advanced/extra keys the form doesn't surface (timeout, alwaysLoad, …),
     *  carried through so the raw-JSON view/edit is faithful. */
    [key: string]: unknown
  }
}

/** Config-file scope for persisting an MCP server (matches `claude mcp -s`). */
export type McpScope = 'user' | 'project' | 'local'

/** Serializable MCP server config as written to the config files. */
export type McpServerConfigInput =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }

export interface SaveMcpServerArgs {
  cwd: string
  scope: McpScope
  name: string
  config: McpServerConfigInput
}

export interface DeleteMcpServerArgs {
  cwd: string
  scope: McpScope
  name: string
}

/** How a provider's token is sent to the API. */
export type ProviderAuthType = 'bearer' | 'apikey'

/** A saved API provider. The active one is applied at every claude.exe spawn
 *  (env injection) and also written into Claude's native settings.json on switch. */
export interface Provider {
  id: string
  /** Display label, e.g. "智谱代理" / "Anthropic 官方". */
  name: string
  /** ANTHROPIC_BASE_URL. */
  baseUrl: string
  /** Auth credential (PROXY_MANAGED / sk-ant-… / custom). */
  token: string
  /** bearer → ANTHROPIC_AUTH_TOKEN (Authorization: Bearer); apikey → ANTHROPIC_API_KEY (x-api-key). */
  authType: ProviderAuthType
  /** Default model passed to the session (options.model). */
  model: string
}

/** A saved working directory ("project"). The sidebar's top switcher lists these;
 *  each has its own session history (scoped by cwd). */
export interface Project {
  /** Absolute path — also the unique key. */
  path: string
  /** Display name (folder name by default, user-renameable). */
  name: string
  addedAt: number
}

/** A skill available to the session (returned by the SDK's supportedCommands(),
 *  which lists skills as slash commands). */
export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

/** A plugin/skill entry from a local marketplace catalog (browse-only). */
export interface MarketplacePlugin {
  name: string
  description: string
  agentBackend?: AgentBackendId
  author?: string
  category?: string
  homepage?: string
  sourceUrl?: string
  installed?: boolean
  enabled?: boolean
  /** Marketplace this came from (e.g. "claude-plugins-official"). */
  marketplace: string
}

export interface PickedDirectoryEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: number
}

/** A file the user picked to attach. Images carry base64 data; text files
 *  carry their (size-capped) content; directories carry a shallow entry list;
 *  others carry just the path reference. */
export interface PickedFile {
  path: string
  name: string
  kind: 'image' | 'text' | 'other' | 'directory'
  mimeType: string
  /** image: base64 (no data: prefix); text: utf-8 content; other/directory: '' */
  data: string
  size: number
  entries?: PickedDirectoryEntry[]
  entriesTruncated?: boolean
  /** 该文件**没能**读进来（超过图片上限、读取失败/超时…）时的用户可读原因。
   *  带 error 的条目只是"失败占位"：不含数据，渲染层不得把它并入附件列表，
   *  只用来把"跳过了哪个文件、为什么"显示给用户（否则超限图片静默消失）。 */
  error?: string
}

/** A model shown in the Composer dropdown (user-editable in Settings). */
export interface ComposerModel {
  id: string
  label: string
}

export type ClaudeExecutionBackend = 'windows' | 'wsl'
export type ProviderBackend = ClaudeExecutionBackend | 'hermes'

export interface PickDirectoryOptions {
  backend?: ClaudeExecutionBackend
}

/** Result of saveImageAs (image context menu "另存为…"). */
export interface SaveImageResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

/** Misc app preferences managed by the Settings panel. */
export interface Preferences {
  /** Which pluggable agent engine Tran should use. */
  agentBackend?: AgentBackendId
  /** Default effort for new sessions (AgentBridge fallback). */
  defaultEffort?: EffortLevel
  /** Default permission mode for new sessions. */
  defaultPermissionMode?: PermissionMode
  /** Which Claude runtime/history backend Tran should use. */
  claudeExecutionBackend?: ClaudeExecutionBackend
  /** Whether WSL-specific UI and backend capabilities are exposed. */
  wslSupportEnabled?: boolean
  /** Models shown in the Composer dropdown; empty/undefined = built-in list. */
  composerModels?: ComposerModel[]
  /** Models shown when the Codex agent backend is active. */
  codexComposerModels?: ComposerModel[]
  /** Models shown when the Hermes agent backend is active. */
  hermesComposerModels?: ComposerModel[]
  /** Experimental: route Chromium's compositing through the ANGLE Vulkan
   *  backend on Windows (default D3D11). Off by default; requires restart and
   *  is higher-variance across GPU drivers. */
  vulkanBackend?: boolean
  /** Close window → hide to system tray instead of quitting. Persisted after
   *  the user picks once on first close; editable in Settings afterwards. */
  minimizeToTray?: boolean
  /** 启动时直接最大化主窗口（默认关）。 */
  startMaximized?: boolean
  /** Show OS native notifications when a session ends while the window is
   *  inactive (default true). */
  nativeNotifications?: boolean
  /** When false, Tran re-shows the close prompt (minimize vs. quit) on every
   *  window close. Default false = always ask until the user picks. */
  closePromptDismissed?: boolean
  /** AI 自动命名（会话短标题，默认开；关闭后不做任何云端命名调用）。 */
  aiNamingEnabled?: boolean
  /** 后台任务收尾后自动催模型更新待办（**默认关**；一次完整 turn，约 88k token）。 */
  autoTodoNudge?: boolean
  /** 云端套餐额度查询（默认开）。直连 api.kimi.com 私有接口并复用 Kimi CLI 的
   *  OAuth 凭证——非官方公开接口，可能随服务端策略失效；关闭后不发任何相关请求。 */
  cloudUsageEnabled?: boolean
  /** 摘要类请求是否开启模型思考（默认关；开思考极烧额度，见 settings.ts 注释）。 */
  summaryThinkingEnabled?: boolean
  /** 总结类杂活（命名、命令说明、思考摘要…）共用的 OpenAI 兼容模型。 */
  summaryModel?: string
  /** 总结类请求使用的 OpenAI 兼容 API 根地址。 */
  summaryApiBaseUrl?: string
}

/** 提示词策略自检的一项结果（设置页「提示词自检」）。四种请求形态各打一发，
 *  用来二分定位 stop / 多轮角色这两个变量哪个被服务端拒绝。 */
export interface PromptDiagnosis {
  label: string
  ok: boolean
  /** 模型原样输出（换行已换成 ⏎）。 */
  output?: string
  /** 失败时服务端返回的原文片段——400 的真实原因只能从这里看。 */
  error?: string
  latencyMs: number
  /** 清洗后的结果；null = 这一形态的输出不可用。 */
  cleaned?: string | null
}

/** 待办条目（与渲染层 PlanEntry 同形；主进程侧也要用，故放在 shared）。 */
export interface PlanEntryInfo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 从 kimi 本地 server 拉到的待办真值。null 表示"拉不到"，与"待办为空"不同。 */
export interface SessionTodosResult {
  entries: PlanEntryInfo[]
  /** 服务端记的最后更新时刻（epoch ms），用来和实时 plan 帧比新旧。 */
  updatedAt: number | null
}

/** 一个候选型号的探测结果（设置页「探测可用型号」）。 */
export interface SummaryModelProbe {
  model: string
  ok: boolean
  /** 失败原因（服务端返回片段，用来区分"不认这个型号"和"额度不足"）。 */
  error?: string
  /** 往返耗时。这活儿在 UI 上，延迟比能力重要——挑最快的。 */
  latencyMs?: number
  /**
   * 该 id 是否出现在服务端 `/models` 目录里。
   *
   * ⚠️ false 时 ok 也可能是 true——chat 端点**不校验 model 值**，随便写什么都回
   * 200 并原样回声（实测连 `gpt-4o` 和一个现编的名字都"通"）。所以「打得通」
   * 完全不能证明这个型号存在，只有目录能。
   */
  known: boolean
  /** 目录里的展示名，例如 `K2.7 Coding`。 */
  displayName?: string
  /** 目录里的上下文长度（token）。 */
  contextLength?: number
}

export interface ProviderProfile {
  backend: ProviderBackend
  providers: Provider[]
  activeProviderId: string | null
  composerModels?: ComposerModel[]
}

export interface ProviderProfiles {
  activeBackend: ProviderBackend
  profiles: ProviderProfile[]
}

export interface RuntimeStatus {
  agentBackend: AgentBackendId
  agentName: string
  agentVersion?: string
  agentPath?: string
  backend: ClaudeExecutionBackend
  provider: Provider | null
  model: string
  claudeCodeVersion?: string
  claudeCodePath?: string
  versionError?: string
  wslDistro?: string
  checkedAt: number
}

export interface RuntimeStatusOptions {
  refreshProbe?: boolean
}

export interface UpdateAssetInfo {
  name: string
  size?: number
  browserDownloadUrl: string
}

export interface UpdateCheckResult {
  checkedAt: number
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  body?: string
  asset?: UpdateAssetInfo
  error?: string
}

export interface UpdateDownloadOptions {
  assetUrl?: string
  directory?: string
  requestId?: string
  openWhenDone?: boolean
}

export interface UpdateDownloadProgress {
  requestId?: string
  fileName: string
  path: string
  receivedBytes: number
  totalBytes?: number
  percent?: number
  bytesPerSecond: number
  elapsedMs: number
  done?: boolean
}

export interface UpdateInstallResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface DiagnosticReportOptions {
  cwd?: string
  appearance?: Record<string, unknown>
}

/** Kimi Code CLI 的安装方式 —— 升级手段完全不同，认错会装出第二份。
 *  installer = 官方脚本（~/.kimi-code/bin，国内常用）；npm = 全局包。 */
export type KimiInstallMethod = 'installer' | 'npm' | 'unknown'

/** Kimi Code CLI 的版本检查结果（与 Tran 自更新分开）。 */
export interface KimiVersionInfo {
  currentVersion?: string
  latestVersion?: string
  updateAvailable: boolean
  /** 与安装方式匹配的升级命令（供复制）。 */
  upgradeCommand: string
  installMethod?: KimiInstallMethod
  /** 探测到的可执行文件路径。 */
  installPath?: string
  error?: string
  checkedAt: number
}

/** 一键升级 Kimi Code CLI 的结果。 */
export interface KimiUpgradeResult {
  ok: boolean
  error?: string
  /** 安装器/npm 输出的尾部（失败时排查用）。 */
  output?: string
}

export interface DiagnosticReportResult {
  canceled?: boolean
  path?: string
  /** 写盘失败（只读目录/权限不足）时的错误信息。 */
  error?: string
}

export type HealthCheckState = 'pass' | 'warn' | 'fail'

export interface HealthCheckItem {
  id: string
  label: string
  state: HealthCheckState
  detail: string
  fixable?: boolean
}

export interface WslHealthReport {
  checkedAt: number
  cwd: string
  cwdWsl?: string
  defaultDistro?: string
  checks: HealthCheckItem[]
  diagnostics: string
}

export interface SettingsBackup {
  version: 1
  exportedAt: string
  settings: Record<string, unknown>
  appearance?: Record<string, unknown>
}

/** Which engine translateTexts() routes to. 'llm' = active provider's
 *  /v1/messages; 'baidu' = Baidu generic-translate API (avoids model rate limits). */
/**
 * 一套摘要 / 命名 API 配置（会话命名、命令说明、思考摘要、模型翻译共用）。
 *
 * 做成**列表 + 一个激活**而不是单份配置：换服务商时旧的 baseUrl/型号/Key 会被
 * 直接覆盖，想换回去得重新找 Key 重填一遍。用户在 DeepSeek 与智谱之间来回比较
 * 时这个代价很实在。与主 Agent 的 providers 是同一个模式。
 *
 * key 不随该结构下发到渲染层——只回掩码（keyMasked），明文仅在保存时单向传入，
 * 落盘走 safeStorage 加密。与 getApiKey 的既有约定一致。
 */
export interface SummaryProfile {
  id: string
  /** 展示名，用户可改（"DeepSeek"、"智谱免费"…）。 */
  name: string
  baseUrl: string
  /** 空 = 用该服务的默认型号。 */
  model: string
  /** 只读回显，形如 `sk-…abcd`；未配置时为空。 */
  keyMasked?: string
}

export type TranslateEngine = 'llm' | 'baidu'

/**
 * 思考翻译单独的引擎选择——**刻意不与 translateEngine 共用**。
 *
 * 两者取舍完全不同：技能/插件描述是短句、几乎没有代码，机翻足够且免费；而思考
 * 过程满篇是路径、变量名、命令与报错原文，机翻会把 `ANTHROPIC_BASE_URL` 一起译
 * 了、把 `--force-with-lease` 拆开。共用一个开关等于逼用户在「描述省钱」和
 * 「思考能读」之间二选一。
 *
 * 取值：
 * - `'follow'`（**默认**）：跟随上面那个 translateEngine，不单独配置。绝大多数
 *   人不需要两套——尤其接入 GLM-4.7-Flash 之后，它免费且两类任务都做得好，
 *   "描述省钱 vs 思考能读"的矛盾本来就不存在了。
 * - `'auto'`：配了百度密钥走百度（免费），否则回落到摘要旁路的便宜模型。
 * - `'llm'` / `'baidu'`：显式指定，不受上面那个开关影响。
 *
 * 保留可单独指定，是因为两者的取舍**可能**相反：思考过程满篇路径、变量名、命令
 * 与报错原文，通用机翻会一并译坏；而技能描述是短句，机翻足够。默认合并、需要时
 * 能拆开，比强制二选一好。
 */
export type ThinkingTranslateEngine = 'follow' | 'auto' | 'llm' | 'baidu'

/** Baidu translate credentials. appId is non-secret; secretKey is the API key
 *  (encrypted at rest via safeStorage, returned plaintext to the renderer for
 *  editing — same stance as provider tokens). */
export interface BaiduTranslateConfig {
  appId: string
  secretKey: string
}

export interface TranslateConfig {
  engine: TranslateEngine
  /** 思考翻译的引擎，独立于上面的 engine（见 ThinkingTranslateEngine）。 */
  thinkingEngine: ThinkingTranslateEngine
  baidu: BaiduTranslateConfig
}

/** Result of a translate-connection test (Baidu credentials check). */
export interface TranslateTestResult {
  ok: boolean
  /** The translated sample text on success. */
  translated?: string
  /** Human-readable failure reason on error. */
  error?: string
}

/** A user/assistant message from a past session transcript (for the sidebar resume view). */
export interface HistoryMessage {
  type: 'user' | 'assistant'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
}

/** --- Goal mode（客户端侧目标引擎；ACP 无 goal 工具，循环在 Tran 实现） --- */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete'

export interface GoalInfo {
  objective: string
  completionCriterion?: string
  status: GoalStatus
  turnCount: number
  maxTurns: number
  blockedReason?: string
  createdAt: number
}

export interface GoalStartOptions {
  objective: string
  completionCriterion?: string
  maxTurns?: number
}

export type GoalControlAction = 'pause' | 'resume' | 'stop'

/** --- Usage panel (UsageModal) --- */
export interface SessionUsageInfo {
  /** 本会话累计 token。kimi 0.26.0 的 ACP 不上报会话用量（实测），
   *  全部缺省时面板显示"暂无数据"。 */
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  /** 上下文窗口已用 token（如有上报）。 */
  contextUsed?: number
  /** 上下文窗口上限（按模型查表，未知回落 1M）。 */
  contextSize: number
  /** 当前模型 id（供展示）。 */
  model?: string
}

/** --- 套餐额度（5 小时滚动窗口 / 每周） ---
 *  数据源：`GET https://api.kimi.com/coding/v1/usages`，Bearer 用 Kimi Code
 *  CLI 自己的 OAuth access_token（见 usageService.ts）。
 *
 *  ⚠️ 这跟 v1.0.46 删掉的那条**不是一回事**：被删的是复用浏览器 Cookie 打
 *  网页内部 MembershipService RPC（quotaService / kimiWebChat），那条让 Tran
 *  变成非官方网页客户端，删得对。这条走的是官方 API + CLI 自己的凭证，与 CLI
 *  本身的行为一致，当时被一起删掉是切宽了，v1.0.49 只把这条加回来。 */
export interface UsageLimitWindow {
  /** 窗口标签，如 "每周" / "5 小时"。 */
  label: string
  limit?: number
  used?: number
  remaining?: number
  /** 重置时间（epoch ms）。 */
  resetAt?: number
}

export interface PlanUsageInfo {
  /** 会员等级原始值（如 LEVEL_INTERMEDIATE），渲染层负责映射展示。 */
  membershipLevel?: string
  weekly?: UsageLimitWindow
  rolling?: UsageLimitWindow
  parallelLimit?: number
  boosterWallet?: {
    monthlyUsedCny?: number
    monthlyLimitCny?: number
  }
}

export type PlanUsageResult =
  | { ok: true; data: PlanUsageInfo }
  | { ok: false; error: string; /** 功能被关闭（opt-in 门未开）时是正常状态，不是故障——渲染层别弹错误框。 */ disabled?: boolean }

/** DeepSeek 账户余额（官方 GET /user/balance；金额是接口原样返回的字符串）。 */
export interface DeepseekBalanceInfo {
  isAvailable: boolean
  /** 货币：CNY 或 USD。 */
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export type DeepseekBalanceResult =
  | { ok: true; data: DeepseekBalanceInfo }
  | { ok: false; error: string }

/** kimi 本地 server 的任务条目（tasks API，子代理/后台 Bash）。 */
export interface KimiTaskInfo {
  id: string
  kind: string
  description?: string
  status?: string
  command?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
}

/** main → renderer：swarm tasks 轮询结果（tasks=null 表示 server 不可用，降级）。 */
export interface SwarmTasksEvent {
  sessionId: string
  tasks: KimiTaskInfo[] | null
}

/** AI 命名批量补全的结果计数。 */
export interface AiTitlesBatchResult {
  generated: number
  skipped: number
  failed: number
}

/** 侧栏悬停预览（零 token，从磁盘 state.json 读）。 */
export interface SessionPreview {
  /** 首条/最近用户消息（截断 80 字）；读不到则缺省。 */
  firstPrompt?: string
}

/** --- Git integration types --- */
export interface GitBranchInfo {
  name: string
  current: boolean
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: number // ms since epoch
}

export interface GitStatus {
  staged: string[]
  unstaged: string[]
  untracked: string[]
  /** Files in a merge/rebase conflict (UU/AA/DD/…). */
  conflicts: string[]
  clean: boolean
  /** Commits local has that upstream doesn't; null when there is no upstream. */
  ahead: number | null
  /** Commits upstream has that local doesn't; null when there is no upstream. */
  behind: number | null
}

/** Changes 面板：工作区单个文件的改动摘要（相对 HEAD，暂存+未暂存合并视角）。 */
export interface GitFileChange {
  path: string
  /** 重命名前的旧路径。 */
  oldPath?: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  /** 新增/删除行数；二进制或未统计时为 null。 */
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface GitWorkingChanges {
  files: GitFileChange[]
  totalAdditions: number
  totalDeletions: number
}

/** Surface exposed on window.api via the preload contextBridge. */
export interface ForgeApi {
  startSession(opts: StartSessionOptions): Promise<StartSessionResult>
  /** Send a user message. `content` is either a text string or an array of
   *  content blocks (text + image) when attachments are present. */
  sendMessage(sessionId: string, content: string | unknown[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  /** --- Goal mode --- */
  goalStart(sessionId: string, opts: GoalStartOptions): Promise<GoalInfo | null>
  goalControl(sessionId: string, action: GoalControlAction): Promise<GoalInfo | null>
  goalGet(sessionId: string): Promise<GoalInfo | null>
  closeSession(sessionId: string): Promise<void>
  /** 显式打断/销毁会话：cancel 当前 turn 并销毁后端会话状态（区别于
   *  closeSession 的"切走=后台化"语义）。 */
  destroySession(sessionId: string): Promise<void>
  listSessions(cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]>
  getSessionMessages(
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<HistoryMessage[]>
  /** Rename a past session (appends a custom title). */
  renameSession(
    sessionId: string,
    title: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<void>
  /** 永久删除会话（移除索引行 + 删除会话目录，不可恢复）。 */
  deleteSession(
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<{ ok: boolean; error?: string }>
  /** 会话归档（Tran 侧标记，数据不动）：id → 归档时间戳（ms）。 */
  getArchivedSessions(): Promise<Record<string, number>>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  /** Read a subagent's own conversation transcript (for the monitor popover). */
  getSubagentMessages(sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]>

  /** List every MCP server the active session knows about (settings-file +
   *  dynamically added), with live connection status. Requires an active session. */
  listMcpServers(sessionId: string): Promise<McpServerEntry[]>
  /** Reload the backend's MCP configuration/status cache when supported, then return the list. */
  refreshMcpServers(sessionId: string): Promise<McpServerEntry[]>
  /** Enable/disable an MCP server by name. Persists to settings (same as `claude mcp`). */
  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void>

  /** Move a running foreground subagent/Bash (by its tool_use_id) to the
   *  background, freeing the main agent's turn. Omit id = background all. */
  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean>

  /** --- Attachments & file links --- */
  /** Open a file picker rooted at cwd, read the chosen files, and return them
   *  (images as base64, text files as content) for attaching to a message. */
  pickFiles(cwd: string): Promise<PickedFile[]>
  /** Read files that were dropped into the renderer. */
  readFiles(cwd: string, paths: string[]): Promise<PickedFile[]>
  /** Resolve an Electron-backed DOM File to its native filesystem path. */
  getPathForFile(file: File): string
  /** Reveal a file (path resolved against cwd) in the OS file manager. */
  revealInExplorer(cwd: string, pathStr: string): Promise<boolean>
  /** Copy an image to the system clipboard. `src` may be a data:/file:/http(s):
   *  URL or an absolute filesystem path (blob: URLs must be converted to data:
   *  by the renderer first). */
  copyImage(src: string): Promise<{ ok: boolean; error?: string }>
  /** Save an image via a native save dialog. Same `src` forms as copyImage. */
  saveImageAs(src: string, suggestedName?: string): Promise<SaveImageResult>

  /** Persist a server to a config file (user/project/local scope). Does NOT touch
   *  the live session — the caller restarts the session to apply. */
  saveMcpServer(args: SaveMcpServerArgs): Promise<void>
  /** Remove a server from its config file. */
  deleteMcpServer(args: DeleteMcpServerArgs): Promise<void>

  /** --- Providers (multi-operator API switching for the current Claude backend) --- */
  listProviders(): Promise<Provider[]>
  getActiveProvider(): Promise<Provider | null>
  getProviderProfiles(): Promise<ProviderProfiles>
  /** Create or update a provider (upsert by id). Returns the updated list. */
  saveProvider(provider: Provider): Promise<Provider[]>
  saveProviderForBackend(backend: ProviderBackend, provider: Provider): Promise<ProviderProfile>
  /** Remove a provider by id. Returns the updated list. */
  deleteProvider(id: string): Promise<Provider[]>
  deleteProviderForBackend(backend: ProviderBackend, id: string): Promise<ProviderProfile>
  /** Make a provider active: writes its params into the current backend's
   *  Claude settings.json + sets that backend's active provider id. Caller
   *  restarts the session to apply. */
  setActiveProvider(id: string): Promise<void>
  setActiveProviderForBackend(backend: ProviderBackend, id: string): Promise<ProviderProfile>
  saveComposerModelsForBackend(
    backend: ProviderBackend,
    models: ComposerModel[]
  ): Promise<ProviderProfile>

  /** --- Projects (saved working directories) --- */
  listProjects(): Promise<Project[]>
  /** Add a directory (idempotent) and mark it last-used. Returns the list. */
  addProject(path: string, name?: string): Promise<Project[]>
  removeProject(path: string): Promise<Project[]>
  renameProject(path: string, name: string): Promise<Project[]>
  setLastProject(path: string): Promise<void>
  /** The project to auto-enter on app start (last-used, else first, else null). */
  getStartupProject(): Promise<Project | null>

  /** --- Skills --- */
  /** Skills available to the active session (via supportedCommands). */
  listSkills(sessionId: string): Promise<SkillInfo[]>
  /** Browse plugin marketplace catalogs for the selected agent backend (read-only). */
  listMarketplacePlugins(agentBackend?: AgentBackendId, cwd?: string): Promise<MarketplacePlugin[]>

  /** Batch-translate texts EN→ZH via the active provider's /v1/messages. Returns
   *  one translation per input (empty string for any that failed). */
  translateTexts(texts: string[]): Promise<string[]>

  /** --- Translate engine config (Translate panel) --- */
  /** Read the current translation engine + Baidu credentials. */
  getTranslateConfig(): Promise<TranslateConfig>
  /** Persist the engine choice + Baidu credentials (secretKey encrypted at rest). */
  saveTranslateConfig(cfg: TranslateConfig): Promise<TranslateConfig>
  /** Test Baidu credentials by translating a sample — does not persist. */
  testTranslate(appId: string, secretKey: string): Promise<TranslateTestResult>

  /** --- Preferences (Settings panel) --- */
  listAgentBackends(): Promise<AgentBackendInfo[]>
  listAgentModels(): Promise<ComposerModel[]>
  getPreferences(): Promise<Preferences>
  savePreferences(prefs: Preferences): Promise<Preferences>
  getRuntimeStatus(cwd?: string, model?: string, options?: RuntimeStatusOptions): Promise<RuntimeStatus>
  runWslHealthCheck(cwd: string): Promise<WslHealthReport>
  repairWslEnvironment(cwd: string): Promise<WslHealthReport>
  getDiagnosticLog(): Promise<string>
  checkForUpdates(): Promise<UpdateCheckResult>
  downloadAndInstallUpdate(options?: UpdateDownloadOptions): Promise<UpdateInstallResult>
  exportDiagnosticReport(options?: DiagnosticReportOptions): Promise<DiagnosticReportResult>
  /** 查 Kimi Code CLI 版本（本机 vs npm 最新）。force 跳过 6 小时缓存。 */
  checkKimiVersion(force?: boolean): Promise<KimiVersionInfo>
  /** 一键升级 Kimi Code CLI。会先断开所有活跃会话（升级要替换正在运行的可执行文件）。 */
  upgradeKimi(): Promise<KimiUpgradeResult>
  /** 探测总结用型号：逐个打一发最小请求，报通/不通与延迟。串行，避免被限流
   *  误判成"型号不认"。传空用内置候选表。 */
  probeSummaryModels(models?: string[]): Promise<SummaryModelProbe[]>
  /** 提示词策略自检：四种请求形态各打一发（共约 400 token），带回服务端原始报错。 */
  diagnoseSummaryPrompt(): Promise<PromptDiagnosis[]>
  /** 待办真值（kimi 本地 server，零 token）。拉不到返回 null。 */
  getSessionTodos(sessionId: string): Promise<SessionTodosResult | null>
  /** 后台任务收尾后催模型更新待办。**会发一次真实 turn、消耗额度**；
   *  返回 true 表示这一轮真的发出去了（界面据此标注）。 */
  nudgeTodos(sessionId: string): Promise<boolean>
  /** 一条 bash 命令在做什么（便宜模型 + 落盘缓存）。拿不到返回 null。 */
  explainCommand(command: string): Promise<string | null>
  /** 一段思考在做什么（便宜模型 + 落盘缓存）。拿不到返回 null。 */
  summarizeThinking(text: string): Promise<string | null>
  /** 把整段思考过程译成中文（优先免费的网页通道 + 落盘缓存）。拿不到返回 null。 */
  translateThinking(text: string): Promise<string | null>
  exportSettings(appearance?: Record<string, unknown>): Promise<SettingsBackup>
  importSettings(backup: SettingsBackup): Promise<void>

  minimizeWindow(): Promise<void>
  /** 切换最大化/还原；返回切换后的最大化状态。 */
  toggleMaximizeWindow(): Promise<boolean>
  isWindowMaximized(): Promise<boolean>
  closeWindow(): Promise<void>
  /** 主进程窗口 maximize/unmaximize 事件推送（覆盖双击标题栏等原生路径）。 */
  onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void

  /** --- System tray & native notifications --- */
  /** User's answer to the first-close prompt. `minimize` = hide to tray,
   *  `remember` = persist the choice so the prompt never shows again. */
  resolveClose(decision: { minimize: boolean; remember: boolean }): Promise<void>
  /** Restore and focus the main window (e.g. from tray or a notification click). */
  showWindow(): Promise<void>
  /** Subscribe to the first-close prompt request (main → renderer). */
  onClosePrompt(cb: () => void): () => void
  onUpdateAvailable(cb: (info: UpdateCheckResult) => void): () => void
  onUpdateDownloadProgress(cb: (progress: UpdateDownloadProgress) => void): () => void
  onProvidersChanged(cb: () => void): () => void

  pickDirectory(options?: PickDirectoryOptions): Promise<string | null>
  /** 摘要 API Key 只回传掩码形态（前 4 后 4 + ***），完整明文不出主进程；
   *  configured 用于设置页判断「是否已配置」。 */
  getApiKey(): Promise<{ configured: boolean; masked: string | null }>
  listSummaryProfiles(): Promise<{ profiles: SummaryProfile[]; activeId: string | null }>
  /** 摘要 API 出现不可自愈故障（额度耗尽 / 凭证失效）时推送。返回取消订阅函数。 */
  onSummaryApiIssue(cb: (payload: { kind: string; detail: string }) => void): () => void
  /** key 传 undefined = 保留原有；传空串 = 清除。 */
  upsertSummaryProfile(
    profile: SummaryProfile,
    key?: string | null
  ): Promise<{ profiles: SummaryProfile[]; activeId: string | null }>
  deleteSummaryProfile(id: string): Promise<{ profiles: SummaryProfile[]; activeId: string | null }>
  setActiveSummaryProfile(id: string): Promise<{ profiles: SummaryProfile[]; activeId: string | null }>
  setApiKey(key: string): Promise<void>

  respondPermission(resp: PermissionResponsePayload): Promise<void>

  /** --- Usage panel --- */
  /** 本会话 token / 上下文用量（ACP 侧；kimi 暂未上报时返回缺省值）。 */
  getSessionUsage(sessionId: string): Promise<SessionUsageInfo>
  /** 触发一次隐藏 /usage 轮刷新上下文用量（悬停上下文环时调用）。 */
  refreshSessionUsage(sessionId: string): Promise<void>
  /** 套餐额度（5h 滚动窗口 / 每周）。主进程带缓存，失败返回 ok:false。 */
  getPlanUsage(): Promise<PlanUsageResult>
  /** DeepSeek 账户余额（官方 /user/balance）。主进程带 60s 缓存，失败返回 ok:false。 */
  getDeepseekBalance(): Promise<DeepseekBalanceResult>
  /** DeepSeek API key 状态：只回掩码（前 4 后 4），完整明文不出主进程。 */
  getDeepseekApiKeyStatus(): Promise<{ configured: boolean; masked: string | null }>
  /** 保存/清空 DeepSeek API key（空字符串 = 清空）；保存后余额缓存作废立即重拉。 */
  saveDeepseekApiKey(key: string): Promise<{ configured: boolean; masked: string | null }>
  /** --- Git integration --- */
  isGitRepo(cwd: string): Promise<boolean>
  gitGetCurrentBranch(cwd: string): Promise<string | null>
  gitListBranches(cwd: string): Promise<GitBranchInfo[]>
  gitCheckoutBranch(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitDeleteBranch(cwd: string, name: string, force?: boolean): Promise<void>
  gitPull(cwd: string): Promise<{ stdout: string; stderr: string }>
  gitPush(cwd: string): Promise<{ stdout: string; stderr: string }>
  gitStatus(cwd: string): Promise<GitStatus>
  gitAdd(cwd: string, paths?: string[]): Promise<void>
  gitCommit(cwd: string, message: string): Promise<void>
  gitLog(cwd: string, limit?: number): Promise<GitCommit[]>
  gitStash(cwd: string, action?: string, message?: string): Promise<string>
  gitRevert(cwd: string, commitHash: string): Promise<void>
  /** Unified diff text. staged=true → already-staged changes; paths → limit to files. */
  gitDiff(cwd: string, opts?: { staged?: boolean; paths?: string[] }): Promise<string>
  /** git fetch (update remote-tracking refs, no merge). */
  gitFetch(cwd: string): Promise<{ stdout: string; stderr: string }>
  /** Unstage paths (omit for all). */
  gitReset(cwd: string, paths?: string[]): Promise<void>
  /** Push current branch and set upstream (git push -u origin HEAD). */
  gitPushUpstream(cwd: string): Promise<{ stdout: string; stderr: string }>
  /** Changes 面板：工作区全部改动聚合（相对 HEAD）。 */
  gitWorkingChanges(cwd: string): Promise<GitWorkingChanges>
  /** Changes 面板：单文件完整 diff；untracked=true 时合成"全新增"diff；
   *  重命名要一并传 oldPath，否则 rename 检测失效会显示成整文件新增。 */
  gitFileDiff(cwd: string, path: string, opts?: { untracked?: boolean; oldPath?: string }): Promise<string>
  /** Changes 面板：还原单文件。手段随 status 而变（新增/重命名在 HEAD 里没有
   *  对应路径，不能走 checkout），所以要把 status 与 oldPath 一起传下去。 */
  gitRevertFile(
    cwd: string,
    path: string,
    untracked: boolean,
    opts?: { status?: GitFileChange['status']; oldPath?: string }
  ): Promise<void>

  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  onPermissionRequest(cb: (r: PermissionRequestPayload) => void): () => void
  /** 历史会话列表外部变化（空壳删除等）——订阅后应刷新侧栏列表。 */
  onSessionsChanged(cb: () => void): () => void
  /** turn 开始/结束推送（侧栏运行标识）：sessionId 是桥接 id，acpSessionId
   *  对应 SessionListItem.sessionId。 */
  onSessionRunningChanged(cb: (p: SessionRunningChangedPayload) => void): () => void
  /** 应用版本号（app.getVersion()），设置页/侧栏展示用。 */
  getAppVersion(): Promise<string>

  /** --- AI 会话命名 --- */
  /** 已有 AI 标题的会话映射（sessionId → 标题），侧栏"一键补全"用。 */
  getAiTitles(): Promise<Record<string, string>>
  /** 为给定会话批量生成 AI 标题（串行 ~300ms 间隔，有缓存/手动命名跳过）。 */
  generateAiTitles(sessionIds: string[]): Promise<AiTitlesBatchResult>
  /** 侧栏条目悬停预览（零 token，读磁盘 state.json）。 */
  getSessionPreview(sessionId: string): Promise<SessionPreview>

  /** --- Swarm tasks 轮询（kimi 本地 server；server 不可用静默降级） --- */
  /** 订阅某 ACP 会话（session_<uuid>）的 tasks 推送：有 running 子代理 2s 一次，
   *  空闲 15s 降频。 */
  subscribeSwarmTasks(sessionId: string): Promise<void>
  /** 退订。带 sessionId = 「这个会话不再是前台」：它若还有任务在跑会继续被
   *  观察（后台会话的任务状态不能因为切走就停更），任务收尾后主进程自动回收。
   *  不带参数 = 全停（窗口卸载用）。 */
  unsubscribeSwarmTasks(sessionId?: string): Promise<void>
  onSwarmTasks(cb: (e: SwarmTasksEvent) => void): () => void

  /** --- 浏览器控制（Chrome 扩展桥） --- */
  getBrowserBridgeStatus(): Promise<BrowserBridgeStatus>
  onBrowserBridgeStatus(cb: (status: BrowserBridgeStatus) => void): () => void
  /** 直调一个浏览器工具（tabs_list / navigate / read_page …），经桥转发给扩展。 */
  browserToolCall(tool: string, args?: unknown): Promise<BrowserToolResult>
  /** --- 控制类插件开关（浏览器控制 / 桌面控制） --- */
  getControlPlugins(): Promise<ControlPluginsState>
  setControlPlugin(plugin: 'browser' | 'desktop', enabled: boolean): Promise<ControlPluginsState>
  /** 分屏控制：列出显示器 / 指定划给 AI 的那块（null = 不限制）。 */
  listDisplays(): Promise<DisplayInfo[]>
  setDesktopDisplay(displayIndex: number | null): Promise<void>
}

/** 一块显示器（分屏控制的选择项）。width/height 是**物理**分辨率。 */
export interface DisplayInfo {
  index: number
  label: string
  width: number
  height: number
  x: number
  y: number
  primary: boolean
  /** 系统缩放百分比（125 / 200 …）。混合 DPI 下用来解释物理尺寸。 */
  scalePercent: number
}

/** 控制类插件的开关状态。开关本体 = kimi mcp.json 的注册/反注册（+ 浏览器
 *  侧的桥启停）；kimi 重开会话后生效。 */
export interface ControlPluginsState {
  browserEnabled: boolean
  desktopEnabled: boolean
  /** 分屏控制划给 AI 的显示器序号；null = 不限制（整个桌面）。 */
  desktopDisplayIndex: number | null
}

/** 浏览器工具调用结果（错误不抛异常，以 ok:false 携带原因）。 */
export type BrowserToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

/** 浏览器桥状态：Tran 侧 WS 服务 + Chrome 扩展连接情况。 */
export interface BrowserBridgeStatus {
  /** WS 服务是否在监听（端口全被占/启动失败时为 false）。 */
  running: boolean
  port: number | null
  /** 用户粘进扩展 options 的配对码，形如 tran1:<端口>:<token>。 */
  pairingCode: string | null
  extensionConnected: boolean
  extensionVersion: string | null
  /** 随 Tran 分发的扩展版本；与已连扩展版本不同时 UI 提示重新加载。 */
  bundledExtensionVersion: string | null
}

declare global {
  interface Window {
    api: ForgeApi
  }
}
