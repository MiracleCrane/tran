import { create } from 'zustand'
import type {
  AgentEvent,
  StartSessionOptions,
  PermissionResponsePayload,
  SessionListItem,
  HistoryMessage,
  McpServerEntry,
  PickedFile,
  EffortLevel,
  PermissionMode,
  AgentBackendId,
  ClaudeExecutionBackend,
  SkillInfo,
  GoalInfo,
  KimiTaskInfo,
  SessionRunningChangedPayload
} from '../../shared/ipc'
import type {
  TranscriptItem,
  AssistantBlock,
  ToolBlock,
  SessionMeta,
  SessionStatus,
  PermissionRequestPayload,
  StartArgs,
  SubagentTask,
  SubagentStatus,
  UserAttachment,
  PendingMessage,
  PlanEntry,
  ContextUsage,
  ElicitationRequest
} from '../types'
import { pickedFileToUserAttachment, userAttachmentToPickedFile } from '../utils/attachments'
import { DEFAULT_KIMI_MODEL_ID } from '../../shared/models'
import { normalizeCwdForCompare } from '../../shared/paths'
import { emitForgeEvent } from '../events'
import { backgroundTaskInfo, taskTerminalFromEnvelope } from '../utils/toolStats'
import {
  clearTodoOverrides,
  pruneVanishedTodoOverrides,
  readTodoOverrides,
  storeTodoOverrides,
  todoKeyOf
} from '../lib/todoOverrides'

/** 每个会话（按 sdkSessionId）最近使用的权限模式。kimi CLI 的 session/load
 *  不会恢复会话模式（init 恒报 default），Tran 侧持久化并在 resume 时重放，
 *  否则切走再切回来 chip 会被 init 覆盖回 default。 */
const PERMISSION_MODE_KEY_PREFIX = 'forge.permissionMode.'

/**
 * 上次用过的模型，按 agent 后端各记一个。
 *
 * 此前只有"当前会话的 model"这一处状态：会话内切换记得住，`newChat` 也沿用，
 * 但**冷启动就丢**——每次开 Tran 都得重新选一遍（2026-08 用户反馈）。
 * 两个后端分开记：Kimi 与 Claude Code 的模型 id 互不通用，串了必然启动失败。
 */
const LAST_MODEL_KEY_PREFIX = 'forge.lastModel.'

function lastModelKey(agentBackend: AgentBackendId | undefined): string {
  return LAST_MODEL_KEY_PREFIX + (agentBackend ?? 'kimi')
}

function readLastModel(agentBackend: AgentBackendId | undefined): string | undefined {
  try {
    return window.localStorage.getItem(lastModelKey(agentBackend)) ?? undefined
  } catch {
    return undefined
  }
}

function storeLastModel(agentBackend: AgentBackendId | undefined, model: string | undefined): void {
  try {
    if (model) window.localStorage.setItem(lastModelKey(agentBackend), model)
    else window.localStorage.removeItem(lastModelKey(agentBackend))
  } catch {
    /* ignore */
  }
}

/** localStorage 里的值是历史遗留，不能直接 as。取值集变过（也还会再变），
 *  老版本写下的字符串会被原样重放给后端——后端拿到不认识的档位，行为不可预期。
 *  校验一次，认不出就当没存过（回落到调用方给的默认档）。 */
const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'plan', 'auto', 'yolo']

function readStoredPermissionMode(sdkSessionId: string | undefined): PermissionMode | null {
  if (!sdkSessionId) return null
  try {
    const v = window.localStorage.getItem(PERMISSION_MODE_KEY_PREFIX + sdkSessionId)
    return v && (PERMISSION_MODES as readonly string[]).includes(v) ? (v as PermissionMode) : null
  } catch {
    return null
  }
}

/**
 * 删会话时把该会话在 localStorage 里的残留一并清掉：权限档 + 草稿。
 *
 * 不清的话这两样**永不过期**——权限档一个会话一个键，删了会话键还在；草稿在
 * 那个 JSON blob 里同样留着。日积月累就是一堆指向已删会话的死键，而 localStorage
 * 是有配额的，写满之后 setItem 开始抛异常（这里到处 catch 掉了，表现是"草稿
 * 静默存不上"这种极难查的故障）。
 */
function forgetSessionLocalState(sdkSessionId: string): void {
  try {
    window.localStorage.removeItem(PERMISSION_MODE_KEY_PREFIX + sdkSessionId)
  } catch {
    /* ignore */
  }
  // 手动待办覆盖也在那个 JSON blob 里，同样按会话清（2026-08-26）。
  clearTodoOverrides(sdkSessionId)
}

function storePermissionMode(sdkSessionId: string | undefined, mode: string): void {
  if (!sdkSessionId) return
  try {
    window.localStorage.setItem(PERMISSION_MODE_KEY_PREFIX + sdkSessionId, mode)
  } catch {
    /* ignore */
  }
}

/** #31 Composer 草稿按会话持久化（对齐 Kimi Web：草稿跟会话走）。键优先
 *  sdkSessionId（重启 resume 后稳定）；新会话 init 前暂无 sdk id，先挂 bridge
 *  sessionId，init 到达后由 Composer 迁移。空文本即删除条目。 */
const COMPOSER_DRAFTS_STORAGE_KEY = 'forge.composerDrafts.v1'

function readStoredComposerDrafts(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function storeComposerDrafts(drafts: Record<string, string>): void {
  try {
    window.localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    /* ignore */
  }
}

/** 未读回复计数（2026-08-25 用户：「后台会话回复完了我都不知道」）：侧栏会话行
 *  的气泡数字。键与侧栏行键一致（Sidebar.sessionKey：`${runtimeBackend ?? 'windows'}:${sdkSessionId}`），
 *  只记本运行期间新完成的 turn，不做历史回填；重启保留（localStorage），上限 99。 */
const UNREAD_REPLIES_STORAGE_KEY = 'forge.unreadReplies.v1'
const UNREAD_REPLIES_MAX = 99

function unreadSessionKey(sdkSessionId: string, backend?: ClaudeExecutionBackend): string {
  return `${backend ?? 'windows'}:${sdkSessionId}`
}

function readStoredUnreadReplies(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(UNREAD_REPLIES_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // 持久化的值不能信：只收正整数，顺带压回上限（老版本/手改的值原样重放
    // 会把气泡撑爆）。
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.min(Math.floor(v), UNREAD_REPLIES_MAX)
    }
    return out
  } catch {
    return {}
  }
}

function storeUnreadReplies(counts: Record<string, number>): void {
  try {
    window.localStorage.setItem(UNREAD_REPLIES_STORAGE_KEY, JSON.stringify(counts))
  } catch {
    /* ignore */
  }
}

/** A buffered `content_block_delta` waiting to be folded into the store in a
 *  single batched update (one per animation frame). See streamBatcher.ts. */
export interface StreamDeltaBatch {
  sessionId: string
  fallbackId: string
  parent: string | null
  event: Record<string, unknown>
}

interface SessionStore {
  starting: boolean
  /** True once the startup check (auto-enter last project) has finished. The App
   *  waits on this before showing Onboarding vs the main UI, to avoid a flash. */
  bootstrapped: boolean
  meta: SessionMeta | null
  items: TranscriptItem[]
  /** 历史渐进注水（头部 prepend）事件号：每实际前置一批旧条目 +1。
   *  Transcript 的 firstItemIndex 滚动补偿以此为触发信号——不再靠「上一帧
   *  首行 key 反推行数」（折叠段向前延伸时组行 id 会变，findIndex 落空，
   *  补偿被跳过、视口被拽下去，2026-08-25 实证）。 */
  historyPrependSeq: number
  /** 最近一批实际前置的条目数（条目级，非显示行；行数由 Transcript 自测，
   *  见 buildDisplayRows 补偿段注释）。仅供排查/断言，补偿不直接消费它。 */
  historyPrependCount: number
  status: SessionStatus
  pendingPermissions: PermissionRequestPayload[]
  /** The Anthropic message id currently streaming (shared by every token event
   *  for that one message). One item per message, not one per token. */
  currentStreamingMsgId: string | null
  /** Past sessions for the sidebar (same cwd). */
  sessions: SessionListItem[]
  sessionsLoading: boolean
  sessionsHasMore: boolean
  /** Task-tool subagents for the StatusBar monitor (kept out of the transcript). */
  tasks: SubagentTask[]
  /** Messages sent while the agent was busy — hover above the Composer and drop
   *  into the transcript one-per-turn-end (result). */
  pendingQueue: PendingMessage[]
  /** UI-selected model/effort differs from the live bridge process. Apply it
   *  lazily right before the next user message so changing controls is inert. */
  sessionConfigDirty: boolean
  /** Selected model has not been applied to the live agent process yet. */
  sessionModelDirty: boolean
  /** The bridge process has ended and its session id can no longer accept input. */
  bridgeEnded: boolean
  /** Kimi ACP 推送的可用斜杠命令（available_commands_update → system/slash_commands）。 */
  slashCommands: SkillInfo[]
  /** ACP plan 事件推送的待办清单（system/plan，全量替换；空数组表示无）。 */
  planEntries: PlanEntry[]
  /** 待办最后一次被 agent 更新的时刻（ms）。plan 是纯推送、无补拉，
   *  卡片需要据此显示陈旧度，否则旧快照看起来永远像当前状态。 */
  planUpdatedAt: number | null
  /** 手动勾掉的待办（2026-08-26）：纯本地覆盖层，ACP 写不回去。键为
   *  todoKeyOf(content)，存储/合并/清理语义见 lib/todoOverrides.ts。
   *  当前会话一份，sdkSessionId 变化时换载（见文件尾部 subscribe）。 */
  todoOverrides: Record<string, true>
  /** 手动勾掉/取消勾掉一条待办。服务端已完成的条目不调它——ACP 只读，
   *  「取消完成」没有真值可回退，手动层只负责把未完成勾成完成（及撤销）。 */
  toggleTodoComplete: (entry: PlanEntry) => void
  /** kimi 本地 server 轮询到的会话 tasks（Swarm 可视化；null = server 不可用降级）。 */
  swarmTasks: KimiTaskInfo[] | null
  /** 隐藏 /usage 轮解析出的上下文用量（system/context_usage；null 表示无数据）。 */
  contextUsage: ContextUsage | null
  /** 隐藏 /mcp 轮解析出的 MCP server 状态（system/mcp_servers；null = 未查询到）。 */
  mcpServers: McpServerEntry[] | null
  /** 模式面板状态（计划/权限互斥恢复 + Swarm/目标开关），per session。 */
  modePanel: ModePanelState
  /** goal 循环状态（system/goal 推送；null 表示无目标），per session。 */
  goal: GoalInfo | null
  /** AskUserQuestion 队列（system/elicitation；逐条处理，多问题顺序到达）。 */
  elicitationQueue: ElicitationRequest[]
  /** #5（对外契约，字段名不可改）正在跑 turn 的会话 sdkSessionId 去重数组：
   *  任何会话（前台/后台）turn 开始加入、结束（result/error/close）移除，
   *  sdkSessionId 未知（init 未到）的会话忽略。侧栏用
   *  useSessionStore((s) => s.runningSdkSessionIds) 显示运行中标识。 */
  runningSdkSessionIds: string[]
  /** #31 Composer 未发送草稿（按会话；键见 COMPOSER_DRAFTS_STORAGE_KEY 注释），
   *  切视图/切会话/重启不丢，发送成功后清空。 */
  composerDrafts: Record<string, string>
  setComposerDraft: (sessionKey: string, text: string) => void
  /** 未读回复计数（键见 UNREAD_REPLIES_STORAGE_KEY 注释）：后台/未打开会话
   *  turn 完成 +1，打开即清；侧栏行右缘气泡用。 */
  unreadReplies: Record<string, number>
  noteReplyCompleted: (sessionKey: string) => void
  clearUnread: (sessionKey: string) => void

  startSession: (args: StartArgs) => Promise<void>
  sendMessage: (text: string, attachments?: PickedFile[], opts?: { cutIn?: boolean }) => Promise<void>
  interrupt: () => Promise<void>
  /** Current thinking-depth (effort). Composer changes stay local until the
   *  next user message, when the bridge is silently resumed with new options. */
  effort: EffortLevel
  setEffort: (effort: EffortLevel) => Promise<void>
  setModel: (model: string) => Promise<void>
  /** Live-switch the current session's permission mode — calls Claude Code's
   *  query.setPermissionMode immediately so it takes effect mid-session, no
   *  resume needed (unlike model/effort which apply lazily next message). */
  setPermissionMode: (mode: PermissionMode) => Promise<void>
  /** 计划开关：开 → mode='plan'（本地记住当前权限档）；关 → 恢复之前的权限档。 */
  setPlanEnabled: (on: boolean) => Promise<void>
  /** Swarm 开关（本地 per-session 偏好，sendMessage 时注入指令前缀）。 */
  setSwarmEnabled: (on: boolean) => Promise<void>
  /** 目标开关（占位，下一版本提供）。 */
  setGoalEnabled: (on: boolean) => Promise<void>
  reset: () => void

  /** On app start: auto-enter the last-used project if any, else leave meta null
   *  so Onboarding shows. Sets bootstrapped regardless. */
  bootstrap: () => Promise<void>
  /** 启动时进入上次的项目：只切界面，后端推迟到第一条消息（懒创建，
   *  与 newChat 同机制）。bootstrap 内部使用，不给 UI 直接调。 */
  openStartupProject: (cwd: string, model?: string) => Promise<void>
  /** Switch the active working directory (project): close the current session and
   *  start a fresh one in the new cwd (history is per-cwd in the sidebar). */
  switchProject: (path: string) => Promise<void>

  /**
   * 从 kimi 本地 server 补拉待办真值（零 token）。
   *
   * 待办原先**只有** ACP `plan` 帧一个来源，而 plan 帧只在模型跑 turn 且恰好
   * 调了 todo_list 时才推。于是切走再切回、或重启之后待办面板就是空的——
   * 用户反复提的「待办一直不更新」有一半是这么来的。这条补拉把真值接上。
   */
  refreshTodos: () => Promise<void>

  /** Sidebar actions */
  refreshSessions: () => Promise<void>
  /** 侧栏历史列表范围：当前项目 / 全部（跨项目，按 cwd 分组）。 */
  sessionScope: 'project' | 'all'
  setSessionScope: (scope: 'project' | 'all') => Promise<void>
  /** 「全部」视图点其他项目的会话：先切到该会话的 cwd 再 resume。 */
  openSessionCrossProject: (
    sdkSessionId: string,
    cwd: string | undefined,
    backend?: ClaudeExecutionBackend,
    targetAgentBackend?: AgentBackendId
  ) => Promise<void>
  /** 排队消息：从队列删除（×）/ 取出并返回（点击卡片取回编辑）。 */
  removePendingMessage: (id: string) => void
  takePendingMessage: (id: string) => PendingMessage | null
  /** 清空排队消息（#20：turn 出错悬置时的"丢弃"出路）。 */
  clearPendingQueue: () => void
  /** 依次重发全部排队消息（#20：turn 出错悬置时的"重发"出路；
   *  首条直达并顺带清掉 error，其余按原 busy 语义重新排队）。 */
  resendPendingQueue: () => Promise<void>
  /** 清除当前会话的错误展示（#13：报错可手动关闭）。 */
  clearError: () => void
  /** forge:session-running-changed 推送：同步后台缓冲与侧栏列表的 running 标记。 */
  applySessionRunningChanged: (p: SessionRunningChangedPayload) => void
  /** #41 "继续等待"：撤掉疑似无响应提示（后端会在下一个静默周期再推）。 */
  dismissTurnStall: () => void
  /** AskUserQuestion 回答：原样回传 optionId 并从队列移除。 */
  answerElicitation: (toolUseID: string, optionId: string) => Promise<void>
  loadMoreSessions: () => Promise<void>
  newChat: () => Promise<void>
  openSession: (
    sdkSessionId: string,
    backend?: ClaudeExecutionBackend,
    targetCwd?: string,
    /** 这条会话所属的 agent 后端（kimi / claude）。缺省沿用当前会话的。 */
    targetAgentBackend?: AgentBackendId
  ) => Promise<void>
  prefetchSessionHistory: (sdkSessionId: string, backend?: ClaudeExecutionBackend) => Promise<void>
  pruneSessionHistoryCache: (visibleSessionIds: string[]) => void
  setTranscriptScrolling: (scrolling: boolean) => void
  /** 注水龙头（2026-08-26「所滚即所得」）：渲染层上报视口相对已加载历史的
   *  位置——'bottom' 钉底（followOutput 兜底，前置扰动不可见）、'edge' 逼近
   *  已加载顶部（需要续注，放慢节奏等测量收敛）、'mid' 停留阅读区（暂停注水：
   *  每批 50 条前置都靠 Virtuoso 估计行高调整，估计误差就是停手后持续漂移
   *  的来源）。 */
  setHistoryPreloadZone: (zone: HistoryPreloadZone) => void
  renameSession: (sessionId: string, title: string, backend?: ClaudeExecutionBackend) => Promise<void>
  /** 永久删除。成功返回 null；失败返回错误文案（调用方必须显式提示——
   *  2026-08-14 用户反馈"删了没反应"：只塞 status.error 的小字没人看得见）。 */
  deleteSession: (sessionId: string, backend?: ClaudeExecutionBackend) => Promise<string | null>
  /** 批量永久删除（侧栏多选）：串行逐个 IPC，个别失败不中断整批，
   *  完成后统一刷新；返回成功/失败计数。 */
  deleteSessions: (
    targets: Array<{ sessionId: string; backend?: ClaudeExecutionBackend }>
  ) => Promise<{ deleted: number; failed: number }>
  /** Move a running subagent to the background (frees the main agent's turn). */
  backgroundTask: (taskId: string) => Promise<void>
  /** Close the current session and re-spawn it (resuming when possible) so that
   *  config-file changes — e.g. MCP servers — get reloaded. History is restored
   *  from the transcript JSONL, so the conversation is preserved. */
  restartSession: () => Promise<void>
  /** Switch the active API provider: writes Claude's settings.json + restarts
   *  the session (resume) so the new provider's env/model take effect. */
  switchProvider: (id: string) => Promise<void>
  /** Re-open the current project after changing the Claude execution backend. */
  reloadForBackendSwitch: () => Promise<void>

  ingestAgentEvent: (e: AgentEvent) => void
  /** Fold a batch of buffered `content_block_delta` events into the store in a
   *  SINGLE update — the hot path for streaming, invoked ≤1× per animation frame
   *  by streamBatcher. Only the streaming assistant item gets a new reference;
   *  every other item keeps its reference so memoized rows skip re-rendering. */
  applyStreamBatch: (batch: StreamDeltaBatch[]) => void
  addPermissionRequest: (r: PermissionRequestPayload) => void
  respondPermission: (
    toolUseID: string,
    behavior: 'allow' | 'deny',
    message?: string,
    answers?: Record<string, unknown>
  ) => Promise<void>
}

const emptyStatus: SessionStatus = { running: false }

/** Swarm 模式注入前缀（本地 per-session 偏好，发送时隐藏拼在用户文本前）。 */
export const SWARM_PROMPT_PREFIX =
  '[Swarm 模式] 请优先使用 AgentSwarm 并行子代理拆分独立子任务。原始消息：'

/** 模式面板状态（per session；新会话落默认，#23 后台会话 attach 时从缓冲恢复）。 */
export interface ModePanelState {
  swarmEnabled: boolean
  /** 目标模式：占位开关（下一版本提供），状态先留口。 */
  goalEnabled: boolean
  /** 开启计划前的权限档（关闭计划时恢复；ACP 单 mode 配置，计划与权限互斥）。 */
  modeBeforePlan: PermissionMode | null
}
function defaultModePanel(): ModePanelState {
  return { swarmEnabled: false, goalEnabled: false, modeBeforePlan: null }
}

/** 用户消息回显去重：Swarm 注入后 SDK 回显的是带前缀文本，剥掉前缀再比。 */
function isOwnMessageEcho(last: TranscriptItem | undefined, echoText: string): boolean {
  if (!last || last.kind !== 'user') return false
  if (last.text === echoText) return true
  return !!last.swarm && echoText === SWARM_PROMPT_PREFIX + last.text
}

/** #9 回显匹配窗口：乐观用户消息之后、回显到达之前可能已插入 query_result
 *  卡、compaction 分界线甚至流式回复的首个 assistant 条目——只比对末项会漏配
 *  → 同一条消息双份。改为向后扫最近几条，跳过非用户条目，与最近一条用户
 *  消息比对。 */
const OWN_ECHO_SCAN_LIMIT = 6

function hasRecentOwnMessageEcho(items: TranscriptItem[], echoText: string): boolean {
  const from = items.length - 1
  for (let i = from; i >= 0 && i > from - OWN_ECHO_SCAN_LIMIT; i--) {
    const it = items[i]
    // 窗口内**任意**一条用户消息命中即算回显。原先是"最近一条用户消息定胜负"：
    // 连发两条直达（A、B）后 A 的回显先到，与最近的 B 比对不中，A 被再插一份
    // ——多在途直达必现双份。
    if (it?.kind === 'user' && isOwnMessageEcho(it, echoText)) return true
  }
  return false
}
const SESSION_PAGE_SIZE = 24
/** 「全部」视图一次拉取的上限（跨项目不做分页）。 */
const ALL_SESSIONS_LIMIT = 200
const HISTORY_PRELOAD_CHUNK_SIZE = 50
const HISTORY_HYDRATION_IDLE_TIMEOUT_MS = 700
const HISTORY_HYDRATION_SCROLL_PAUSE_MS = 140
/** 逼近已加载顶部（edge）时的注水节奏：放慢到 160ms，让新前置的行在视口上方
 *  overscan 里完成真实测高、估计误差收敛后再注下一批（2026-08-26 漂移修复）。 */
const HISTORY_HYDRATION_EDGE_INTERVAL_MS = 160
const HISTORY_HYDRATION_RELEASE_MS = 2_000
let startupBootstrapPromise: Promise<void> | null = null
let sessionNavigationSeq = 0
let sessionListRequestSeq = 0
let loadMoreSessionsRequestSeq = 0

/** #1 会话导航前同步冲刷 streamBatcher 的待释放 delta 队列（前台 pending +
 *  后台聚合队列）。不冲的话：旧会话结构性事件折入后台缓冲后，积压里迟到的
 *  delta 会以 fallbackId 新建一个永远"打字中"的幽灵气泡；旧积压还会继续占用
 *  前台每帧字符预算，拖慢新前台会话的首字。直接 import streamBatcher 会成环
 *  （它已 import 本模块），改由 streamBatcher 模块加载时注册回调。 */
let navigationStreamFlush: (() => void) | null = null
export function registerNavigationStreamFlush(fn: () => void): void {
  navigationStreamFlush = fn
}
function flushPendingStreamDeltas(): void {
  navigationStreamFlush?.()
}

interface SessionHistoryCacheEntry {
  items?: TranscriptItem[]
  promise?: Promise<TranscriptItem[]>
  lastTouched: number
}

const sessionHistoryCache = new Map<string, SessionHistoryCacheEntry>()
const sessionStartPromises = new Map<string, Promise<void>>()

/** 每条缓存都存着一份完整的会话记录副本（cloneTranscriptItems）。
 *  lastTouched 一直在写但从没被用于淘汰，缓存只能靠外部调用
 *  pruneSessionHistoryCache 收缩——跨项目翻会话时会一路涨上去。 */
const SESSION_HISTORY_CACHE_MAX = 24

/** LRU 淘汰：按 lastTouched 最旧的先丢。在途请求（只有 promise 没有 items）
 *  不动，丢掉会让等待方拿不到结果。 */
function evictSessionHistoryCache(): void {
  if (sessionHistoryCache.size <= SESSION_HISTORY_CACHE_MAX) return
  const evictable = [...sessionHistoryCache.entries()]
    .filter(([, entry]) => entry.items !== undefined)
    .sort((a, b) => a[1].lastTouched - b[1].lastTouched)
  let excess = sessionHistoryCache.size - SESSION_HISTORY_CACHE_MAX
  for (const [key] of evictable) {
    if (excess <= 0) break
    sessionHistoryCache.delete(key)
    excess -= 1
  }
}

/** #29/#5 直达发送（非排队）后尚未被 agent 确认收到的用户消息台账（按发送
 *  顺序）。原先只有一个槽位：连发多条直达消息（如后台子代理待命时 busy=false）
 *  会互相覆盖，错误回收只救得回最后一条。改成数组台账，各占一席：turn 以
 *  错误收尾（典型：僵尸 turn "another turn is active"）时该会话的条目**全部**
 *  回收进 pendingQueue，走 #20 的重发/清空出路。agent 回显（user echo）逐条
 *  出账、成功 result 整会话出账；用户主动停止的 suppressed result 不动账
 *  （该 turn 的消息可能根本没被处理，留着等后续 result 定论）。 */
type UnackedDirectMessage = Omit<PendingMessage, 'id'> & { sessionId: string }
let unackedDirectMessages: UnackedDirectMessage[] = []

/** kimi 侧已确认不存在的会话 id：待办轮询遇到一次 40401 就拉黑，不再重试。 */
const deadTodoSessions = new Set<string>()

/** 文本行数（空串 0；按 \n 计数，无尾换行按一段算）。 */
function lineCountOf(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') n++
  return n
}

/**
 * 从本轮（上一条用户发言之后）的写/改工具调用统计「已编辑 N 个文件 +X -Y」。
 * 输入全部本地可取：Write 的 content 全是新增；Edit/patch 的 old_string/new_string
 * 差即增删（edits 数组按段累加）。不再依赖 git 快照对——2026-08-18 实测大脏仓库
 * （200+ 改动文件）里快照 IPC 会被轮内流量饿死约 1 分钟，卡片落地太晚位置全错。
 * 撤销仍走 gitRevertFile（checkout 失败自动退到撤索引+删除，未跟踪文件同样安全）。
 */
function computeTurnChangesFromItems(
  items: TranscriptItem[]
): { files: Array<{ path: string; added: number; removed: number }>; addedTotal: number; removedTotal: number } | null {
  const perFile = new Map<string, { added: number; removed: number }>()
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'user' && it.text) break // 本轮只到上一条用户发言为止
    if (it.kind !== 'assistant') continue
    for (const b of it.blocks) {
      if (!b || b.kind !== 'tool') continue
      const inp = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
      const path =
        typeof inp.file_path === 'string' ? inp.file_path : typeof inp.path === 'string' ? inp.path : ''
      if (!path) continue
      let added = 0
      let removed = 0
      if (b.name === 'Write' || b.name === 'write_file') {
        added = lineCountOf(inp.content)
      } else if (b.name === 'Edit' || b.name === 'edit_file' || b.name === 'patch') {
        if (Array.isArray(inp.edits)) {
          for (const e of inp.edits as Array<Record<string, unknown>>) {
            removed += lineCountOf(e?.old_string)
            added += lineCountOf(e?.new_string)
          }
        } else if (typeof inp.old_string === 'string' || typeof inp.new_string === 'string') {
          removed = lineCountOf(inp.old_string)
          added = lineCountOf(inp.new_string)
        } else if (typeof inp.content === 'string') {
          // kimi 的 Write 在会话事件里同样名为 patch（没有 old/new，content 是整份
          // 文件内容，2026-08-18 实测）：整份计为新增。
          added = lineCountOf(inp.content)
        }
      } else {
        continue
      }
      if (added === 0 && removed === 0) continue
      const cur = perFile.get(path) ?? { added: 0, removed: 0 }
      cur.added += added
      cur.removed += removed
      perFile.set(path, cur)
    }
  }
  if (perFile.size === 0) return null
  const files = [...perFile.entries()].map(([path, v]) => ({ path, added: v.added, removed: v.removed }))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    files,
    addedTotal: files.reduce((n, f) => n + f.added, 0),
    removedTotal: files.reduce((n, f) => n + f.removed, 0)
  }
}

/** 取出（并移除）该会话的全部未确认直达消息（保持发送顺序）。 */
function takeUnackedDirectMessages(sessionId: string): UnackedDirectMessage[] {
  const taken = unackedDirectMessages.filter((m) => m.sessionId === sessionId)
  if (taken.length) unackedDirectMessages = unackedDirectMessages.filter((m) => m.sessionId !== sessionId)
  return taken
}

/** 回显确认：按内容匹配出账该会话最早的一条（FIFO；Swarm 注入后回显的是
 *  带前缀文本，剥前缀再比，与 isOwnMessageEcho 同一语义）。 */
function ackUnackedDirectMessage(sessionId: string, echoText: string): void {
  const idx = unackedDirectMessages.findIndex(
    (m) =>
      m.sessionId === sessionId &&
      (m.text === echoText || (!!m.swarm && echoText === SWARM_PROMPT_PREFIX + m.text))
  )
  if (idx >= 0) unackedDirectMessages = unackedDirectMessages.filter((_, i) => i !== idx)
}

interface SessionHistoryHydrationTask {
  bridgeSessionId: string
  sourceItems: TranscriptItem[]
  loadedFrom: number
  timeoutId: number | ReturnType<typeof setTimeout> | null
  idleId: number | null
  cancelled: boolean
}

let activeHistoryHydrationTask: SessionHistoryHydrationTask | null = null
let transcriptScrolling = false
/** 视口位置三态（含义见 setHistoryPreloadZone 注释）。默认 'bottom'：会话打开
 *  即钉底，与 Transcript 的 atBottomRef 初值一致。 */
export type HistoryPreloadZone = 'bottom' | 'edge' | 'mid'
let historyPreloadZone: HistoryPreloadZone = 'bottom'

/** turn 结束后刷新侧栏会话列表（防抖）：kimi 在会话产生内容后才持久化/更新
 *  session/list 条目，只在 startSession 时刷新会漏掉"刚聊完"的会话。 */
let sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSessionsRefresh(get: () => SessionStore): void {
  if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer)
  sessionsRefreshTimer = setTimeout(() => {
    sessionsRefreshTimer = null
    void get().refreshSessions()
  }, 1500)
}

function sessionHistoryCacheKey(
  cwd: string,
  sdkSessionId: string,
  backend: ClaudeExecutionBackend | 'current' = 'current'
): string {
  return `${backend}\n${cwd}\n${sdkSessionId}`
}

function cloneTranscriptItems(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => {
    if (item.kind === 'user') {
      return {
        ...item,
        ...(item.attachments ? { attachments: item.attachments.map((a) => ({ ...a })) } : {})
      }
    }
    // compaction 分界线 item 没有 blocks，浅拷贝即可。
    if (item.kind !== 'assistant') return { ...item }
    return {
      ...item,
      blocks: item.blocks.map((block) => ({ ...block }))
    }
  })
}

function getCachedSessionHistory(
  cwd: string,
  sdkSessionId: string,
  backend?: ClaudeExecutionBackend
): TranscriptItem[] | null {
  const entry = sessionHistoryCache.get(sessionHistoryCacheKey(cwd, sdkSessionId, backend ?? 'current'))
  // 空数组不当有效缓存：它只会来自加载失败/真空历史的兜底（见 loadSessionHistory），
  // 一旦命中就再也拿不到后续真实内容。
  if (!entry?.items?.length) return null
  entry.lastTouched = Date.now()
  return cloneTranscriptItems(entry.items)
}

function loadSessionHistory(
  cwd: string,
  sdkSessionId: string,
  backend?: ClaudeExecutionBackend
): Promise<TranscriptItem[]> {
  const key = sessionHistoryCacheKey(cwd, sdkSessionId, backend ?? 'current')
  const cached = sessionHistoryCache.get(key)
  if (cached?.items?.length) {
    cached.lastTouched = Date.now()
    return Promise.resolve(cloneTranscriptItems(cached.items))
  }
  if (cached?.promise) {
    cached.lastTouched = Date.now()
    return cached.promise.then(cloneTranscriptItems)
  }

  let promise: Promise<TranscriptItem[]>
  promise = window.api
    .getSessionMessages(sdkSessionId, cwd, backend)
    .then(historyToItems)
    .catch(() => [] as TranscriptItem[])
    .then((items) => {
      const current = sessionHistoryCache.get(key)
      if (current?.promise === promise) {
        if (items.length === 0) {
          // 空结果（加载失败兜底或真空历史）不落缓存——否则会话产生内容后
          // 仍命中空缓存，切回时历史永远空白。
          sessionHistoryCache.delete(key)
        } else {
          sessionHistoryCache.set(key, {
            items: cloneTranscriptItems(items),
            lastTouched: Date.now()
          })
          evictSessionHistoryCache()
        }
      }
      return items
    })

  sessionHistoryCache.set(key, { promise, lastTouched: Date.now() })
  return promise.then(cloneTranscriptItems)
}

function visibleHistoryTail(items: TranscriptItem[]): TranscriptItem[] {
  return cloneTranscriptItems(items.slice(Math.max(0, items.length - HISTORY_PRELOAD_CHUNK_SIZE)))
}

function clearHistoryHydrationTimers(task: SessionHistoryHydrationTask): void {
  if (task.timeoutId !== null) {
    clearTimeout(task.timeoutId)
    task.timeoutId = null
  }
  if (task.idleId !== null && 'cancelIdleCallback' in window) {
    window.cancelIdleCallback(task.idleId)
    task.idleId = null
  }
}

function releaseHistoryHydrationTask(task: SessionHistoryHydrationTask): void {
  task.cancelled = true
  clearHistoryHydrationTimers(task)
  task.sourceItems = []
}

function cancelActiveHistoryHydration(delayMs = HISTORY_HYDRATION_RELEASE_MS): void {
  const task = activeHistoryHydrationTask
  if (!task) return
  activeHistoryHydrationTask = null
  task.cancelled = true
  clearHistoryHydrationTimers(task)
  window.setTimeout(() => releaseHistoryHydrationTask(task), delayMs)
}

function scheduleHistoryHydrationStep(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  task: SessionHistoryHydrationTask
): void {
  clearHistoryHydrationTimers(task)
  if (task.cancelled || task.loadedFrom <= 0) return

  const run = (): void => {
    task.timeoutId = null
    task.idleId = null
    if (task.cancelled || activeHistoryHydrationTask !== task) return
    if (get().meta?.sessionId !== task.bridgeSessionId) {
      cancelActiveHistoryHydration()
      return
    }
    if (transcriptScrolling || historyPreloadZone === 'mid') {
      // 滚动中 / 停留阅读区：暂停注水（阅读区前置 = 估计行高调校 = 停手后
      // 持续漂移，2026-08-26）。靠同一颗定时器轮询，解除条件满足即续注。
      task.timeoutId = window.setTimeout(
        () => scheduleHistoryHydrationStep(get, set, task),
        HISTORY_HYDRATION_SCROLL_PAUSE_MS
      )
      return
    }

    const nextFrom = Math.max(0, task.loadedFrom - HISTORY_PRELOAD_CHUNK_SIZE)
    const chunk = cloneTranscriptItems(task.sourceItems.slice(nextFrom, task.loadedFrom))
    task.loadedFrom = nextFrom
    if (chunk.length > 0) {
      set((s) => {
        if (s.meta?.sessionId !== task.bridgeSessionId) return {}
        // #7 去重用 Set：原先 chunk × items 双重扫描，长会话渐进注水是 O(n²)。
        const existing = new Set(s.items.map((item) => item.id))
        const fresh = chunk.filter((item) => !existing.has(item.id))
        // 全部被去重吃掉 = 这一批没有实际前置，不动 seq（补偿以 seq 为触发，
        // 空批触发会把同帧的其它行数变化误当头部插入）。
        if (fresh.length === 0) return {}
        return {
          items: [...fresh, ...s.items],
          historyPrependSeq: s.historyPrependSeq + 1,
          historyPrependCount: fresh.length
        }
      })
    }

    if (task.loadedFrom > 0) {
      scheduleHistoryHydrationStep(get, set, task)
    }
  }

  if (historyPreloadZone === 'edge') {
    // edge 模式固定节奏慢注（不走 requestIdleCallback——用户停手阅读时 idle
    // 立刻就绪，等于全速连注，测高误差来不及收敛）。
    task.timeoutId = setTimeout(run, HISTORY_HYDRATION_EDGE_INTERVAL_MS)
  } else if ('requestIdleCallback' in window) {
    task.idleId = window.requestIdleCallback(run, { timeout: HISTORY_HYDRATION_IDLE_TIMEOUT_MS })
  } else {
    task.timeoutId = setTimeout(run, 48)
  }
}

/** #2 历史合并去重的内容指纹：live 乐观条目的 id 是随机 uid()，磁盘历史是
 *  JSONL uuid，按 id 永远对不上（restartSession/switchProvider 后同一条消息
 *  在历史 tail 之后再排一遍 → 对话重复）。退化到 kind + 内容前缀做指纹：
 *  user 用文本；assistant 用各块文本/toolUseId（tool id 在流式与磁盘间稳定）。
 *  user/assistant 之外的本地条目（query/compaction 等）不参与（返回 null，
 *  一律保留）。 */
/** 后台任务完成通知信封（kimi 宿主注入对话的 <notification id="task:…">）到达：
 *  把对应后台工具块补登终态。server/磁盘校正只覆盖宿主最近保留的两条任务记录
 *  （2026-08-20 实证：本会话 132 个后台任务磁盘只剩 2 条 json），老任务的
 *  「运行中」假象全靠这个信封纠正。 */
function applyTaskTerminalEnvelope(items: TranscriptItem[], text: string): TranscriptItem[] {
  const hit = taskTerminalFromEnvelope(text)
  if (!hit) return items
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'assistant') return item
    let touched = false
    const blocks = item.blocks.map((b) => {
      if (!b || b.kind !== 'tool' || b.bgTerminal) return b
      const bg = backgroundTaskInfo(b)
      if (!bg.isBackground || bg.taskId !== hit.taskId) return b
      touched = true
      return { ...b, bgTerminal: hit.terminal }
    })
    if (!touched) return item
    changed = true
    return { ...item, blocks }
  })
  return changed ? next : items
}

/** 历史重建的批量补登：先攒终态表再一次改完（逐封扫是 O(通知数×块数)）。 */
function applyAllTaskTerminalEnvelopes(items: TranscriptItem[]): TranscriptItem[] {
  const terminalByTask = new Map<string, 'completed' | 'failed' | 'stopped'>()
  for (const item of items) {
    if (item.kind !== 'user' || !item.text) continue
    const hit = taskTerminalFromEnvelope(item.text)
    if (hit) terminalByTask.set(hit.taskId, hit.terminal)
  }
  if (terminalByTask.size === 0) return items
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'assistant') return item
    let touched = false
    const blocks = item.blocks.map((b) => {
      if (!b || b.kind !== 'tool' || b.bgTerminal) return b
      const bg = backgroundTaskInfo(b)
      const terminal = bg.taskId ? terminalByTask.get(bg.taskId) : undefined
      if (!bg.isBackground || !terminal) return b
      touched = true
      return { ...b, bgTerminal: terminal }
    })
    if (!touched) return item
    changed = true
    return { ...item, blocks }
  })
  return changed ? next : items
}

function transcriptFingerprint(item: TranscriptItem): string | null {
  if (item.kind === 'user') return `user\n${item.text.slice(0, 200)}`
  if (item.kind === 'assistant') {
    const text = item.blocks
      .map((b) =>
        b && (b.kind === 'text' || b.kind === 'thinking')
          ? b.text
          : b && b.kind === 'tool'
            ? b.toolUseId
            : ''
      )
      .join('\n')
    return text ? `assistant\n${text.slice(0, 200)}` : null
  }
  return null
}

function startProgressiveSessionHistory(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  bridgeSessionId: string,
  sourceItems: TranscriptItem[]
): void {
  cancelActiveHistoryHydration()
  if (get().meta?.sessionId !== bridgeSessionId) return

  const loadedFrom = Math.max(0, sourceItems.length - HISTORY_PRELOAD_CHUNK_SIZE)
  const task: SessionHistoryHydrationTask = {
    bridgeSessionId,
    sourceItems,
    loadedFrom,
    timeoutId: null,
    idleId: null,
    cancelled: false
  }
  activeHistoryHydrationTask = task

  set((s) => (
    s.meta?.sessionId === bridgeSessionId
      ? {
          items: (() => {
            const visible = cloneTranscriptItems(sourceItems.slice(loadedFrom))
            const sourceIds = new Set(sourceItems.map((item) => item.id))
            // #2 以磁盘历史为准：id 或内容指纹（多重集，带出现次数，保持相对
            // 顺序消耗）命中即视为已落盘，只保留真正未落盘的 live 条目，
            // 顺序维持在历史之后（它们必然是最新的）。
            const sourceFingerprints = new Map<string, number>()
            for (const item of sourceItems) {
              const fp = transcriptFingerprint(item)
              if (fp) sourceFingerprints.set(fp, (sourceFingerprints.get(fp) ?? 0) + 1)
            }
            // 压缩分界线的对账键是摘要正文（live 条 id=uid()、at=complete；
            // 磁盘条 id=w*-compaction、at=begin）——指纹对 compaction 返回 null
            // 不参与，得单独按摘要去重，否则同一次压缩两条分界线。
            const sourceCompactionSummaries = new Set(
              sourceItems.flatMap((i) => (i.kind === 'compaction' && i.summary ? [i.summary] : []))
            )
            const liveItems = s.items.filter((item) => {
              if (item.kind === 'compaction' && item.summary && sourceCompactionSummaries.has(item.summary)) {
                return false
              }
              const fp = transcriptFingerprint(item)
              const remaining = fp ? (sourceFingerprints.get(fp) ?? 0) : 0
              // id 命中说明这条**就是**磁盘里的那条，因此必须一并消耗掉它自己的
              // 指纹计数——否则同内容的下一条（刚发出、还没落盘的乐观条目）会被
              // 这份没减掉的剩余计数误判成"已落盘"而丢弃，表现为刚发的消息从
              // 对话里消失（打开旧会话 → 重发一条历史里出现过的短消息 →
              // restartSession/切配置）。
              if (sourceIds.has(item.id) || remaining > 0) {
                if (fp && remaining > 0) sourceFingerprints.set(fp, remaining - 1)
                return false
              }
              return true
            })
            return [...visible, ...liveItems]
          })()
        }
      : {}
  ))

  scheduleHistoryHydrationStep(get, set, task)
}

function deleteSessionHistoryCache(
  cwd: string,
  sdkSessionId: string,
  backend?: ClaudeExecutionBackend
): void {
  sessionHistoryCache.delete(sessionHistoryCacheKey(cwd, sdkSessionId, backend ?? 'current'))
}

function pruneSessionHistoryCacheForCwd(cwd: string, retainedSessionIds: Set<string>): void {
  for (const key of sessionHistoryCache.keys()) {
    const [, cacheCwd, sdkSessionId] = key.split('\n')
    if (cacheCwd === cwd && !retainedSessionIds.has(sdkSessionId)) {
      sessionHistoryCache.delete(key)
    }
  }
}

function uid(): string {
  return crypto.randomUUID()
}

function modelForAgent(
  _agentBackend: AgentBackendId | undefined,
  model: string | undefined
): string | undefined {
  // 'kimi-default' 表示交给 Kimi CLI 自己选模型，不下发显式 model。
  if (!model || model === DEFAULT_KIMI_MODEL_ID) return undefined
  return model
}

function displayModelForAgent(
  agentBackend: AgentBackendId | undefined,
  model: string | undefined
): string {
  return modelForAgent(agentBackend, model) ?? DEFAULT_KIMI_MODEL_ID
}

function isUserStopDiagnostic(error: string | undefined): boolean {
  if (!error) return false
  const text = error.toLowerCase()
  return text.includes('[ede_diagnostic]') && text.includes('result_type=user')
}

function isModelSwitchControlOutput(text: string | undefined): boolean {
  if (!text) return false
  return /<local-command-stdout>\s*Set model to [\s\S]*?<\/local-command-stdout>/i.test(text.trim())
}

/** True if the Task tool_use that spawned a task was called with
 *  run_in_background: true — i.e. the model launched it directly in the
 *  background (distinct from a user backgrounding a foreground task later). */
function launchedInBackground(items: TranscriptItem[], toolUseId?: string): boolean {
  if (!toolUseId) return false
  for (const it of items) {
    if (!it || it.kind !== 'assistant') continue
    for (const b of it.blocks) {
      if (b && b.kind === 'tool' && b.toolUseId === toolUseId) {
        const input = b.input as { run_in_background?: unknown } | undefined
        return !!input?.run_in_background
      }
    }
  }
  return false
}

/** Immutably update the ToolBlock whose toolUseId matches, wherever it lives. */
function mapTool(
  items: TranscriptItem[],
  toolUseId: string,
  fn: (b: ToolBlock) => ToolBlock
): TranscriptItem[] {
  return items.map((item) => {
    if (!item || item.kind !== 'assistant') return item
    let changed = false
    const blocks = item.blocks.map((b) => {
      // `b` may be undefined when streamed indices left holes in the blocks
      // array (interleaved subagent events) — skip those safely.
      if (b && b.kind === 'tool' && b.toolUseId === toolUseId) {
        changed = true
        return fn(b)
      }
      return b
    })
    return changed ? { ...item, blocks } : item
  })
}

/** #32 悬挂工具块封口：终态 tool_result 丢失（子代理被杀/Session closed/中断）
 *  的块不能永远挂 running/pending——翻成 stopped。withTimestamp 打终态时间戳
 *  （live turn 结束兜底）；历史重放无时间戳，诚实缺省。后台 agent 的块
 *  status 已是 done（launch ack），不受影响。 */
function sealHungToolBlocks(items: TranscriptItem[], withTimestamp: boolean): TranscriptItem[] {
  return items.map((item) => {
    if (!item || item.kind !== 'assistant') return item
    let changed = false
    const blocks = item.blocks.map((b) => {
      if (b && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')) {
        changed = true
        return { ...b, status: 'stopped' as const, ...(withTimestamp ? { endedAt: Date.now() } : {}) }
      }
      return b
    })
    return changed ? { ...item, blocks } : item
  })
}

/**
 * Fold a streaming delta into the assistant item for the message currently
 * streaming. The key is the Anthropic message id (from `message_start`), which
 * is shared by every token event in that one message and also matches the final
 * `assistant` message — so we build exactly ONE item per message, not one per
 * token.
 */
function applyStreamEvent(
  state: { items: TranscriptItem[]; currentStreamingMsgId: string | null },
  fallbackId: string,
  parent: string | null,
  event: Record<string, unknown>
): { items: TranscriptItem[]; currentStreamingMsgId: string | null } {
  const type = event.type as string
  let items = state.items
  let msgId = state.currentStreamingMsgId

  if (type === 'message_start') {
    const messageField = event.message as { id?: string } | undefined
    msgId = messageField?.id ?? fallbackId
    if (!items.some((i) => i.id === msgId)) {
      items = [
        ...items,
        { id: msgId, kind: 'assistant', blocks: [], parentToolUseId: parent, streaming: true }
      ]
      // NOTE: do NOT clear `queued` here — a single turn emits many
      // message_starts (one per tool-call round-trip). The queued badge is
      // cleared on `result` (the real end of the turn) instead.
    }
    return { items, currentStreamingMsgId: msgId }
  }

  // content_block_* events have no message id — reuse the one message_start set.
  if (!msgId) msgId = fallbackId
  if (!items.some((i) => i.id === msgId)) {
    items = [
      ...items,
      { id: msgId, kind: 'assistant', blocks: [], parentToolUseId: parent, streaming: true }
    ]
  }
  const index = event.index as number

  if (type === 'content_block_start') {
    const cb = event.content_block as {
      type: string
      id?: string
      name?: string
      text?: string
      thinking?: string
    }
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      if (cb.type === 'text') blocks[index] = { kind: 'text', text: cb.text ?? '' }
      else if (cb.type === 'thinking') blocks[index] = { kind: 'thinking', text: cb.thinking ?? '' }
      else if (cb.type === 'tool_use')
        blocks[index] = {
          kind: 'tool',
          toolUseId: cb.id ?? '',
          name: cb.name ?? 'tool',
          input: {},
          status: 'pending',
          inputRaw: '',
          startedAt: Date.now()
        }
      return { ...item, blocks }
    })
  } else if (type === 'content_block_delta') {
    const delta = event.delta as {
      type: string
      text?: string
      thinking?: string
      partial_json?: string
    }
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      const b = blocks[index]
      if (!b) return item
      if (delta.type === 'text_delta' && b.kind === 'text')
        blocks[index] = { ...b, text: b.text + (delta.text ?? '') }
      else if (delta.type === 'thinking_delta' && b.kind === 'thinking')
        blocks[index] = { ...b, text: b.text + (delta.thinking ?? '') }
      else if (delta.type === 'input_json_delta' && b.kind === 'tool')
        blocks[index] = { ...b, inputRaw: (b.inputRaw ?? '') + (delta.partial_json ?? '') }
      return { ...item, blocks }
    })
  } else if (type === 'content_block_stop') {
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      const b = blocks[index]
      if (b && b.kind === 'tool' && b.inputRaw) {
        try {
          blocks[index] = { ...b, input: JSON.parse(b.inputRaw) }
        } catch {
          /* keep accumulated raw JSON */
        }
      }
      return { ...item, blocks }
    })
  }

  // 历史里的完成通知信封批量补登：重开老会话时后台命令状态同样纠偏。
  return { items: applyAllTaskTerminalEnvelopes(items), currentStreamingMsgId: msgId }
}

/** user-slash 技能信封还原成用户原始输入（2026-08-21 修复：重开会话后 SkillCard 消失）。
 *  kimi CLI 展开斜杠命令后才记录，历史里的 user 消息是注入信封：
 *    `User activated the skill "X". Follow the loaded skill instructions.`
 *    `<kimi-skill-loaded name="X" trigger="user-slash" source="user" dir="…" args="…">`
 *    + 整篇 skill markdown
 *  原样渲染会被 Transcript 的 HIDDEN_ENVELOPE_RE 整条隐藏（用户那一轮变空白）。
 *  这里把 trigger="user-slash" 的信封改回 `/name args`（args 空则只有 `/name`），
 *  让 SkillCard 的 matchSkillInvocation 分支照常命中；其余 trigger（如模型自己调
 *  Skill 工具的 model-tool 信封）原样返回、照旧隐藏。解析保守：格式不符就原样返回。 */
export function rewriteSkillEnvelope(text: string): string {
  const m =
    /^(?:User activated the skill "[^"]*"\. Follow the loaded skill instructions\.\s*)?<kimi-skill-loaded\s+([^>]*)>/.exec(
      text.trimStart()
    )
  if (!m) return text
  const attrs = m[1]
  const attr = (key: string): string | null =>
    new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1] ?? null
  const name = attr('name')
  if (!name || attr('trigger') !== 'user-slash') return text
  const args = attr('args') ?? ''
  return args ? `/${name} ${args}` : `/${name}`
}

/** Convert a past session's transcript messages into renderable items, pairing
 *  each tool_use with its tool_result by id. */
export function historyToItems(messages: HistoryMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  // #7 tool_use → 块索引：tool_result 配对从全量双重扫描 O(n²) 降为 Map 查找。
  const toolBlocksById = new Map<string, ToolBlock>()
  for (const m of messages) {
    // wire 重建的压缩分界线消息（parseWireHistory）：位置 = 历史压缩点，
    // 带摘要正文（live 通道分界线同样带摘要——都源自 apply_compaction）。
    if ((m as { type?: string }).type === 'compaction') {
      const mc = m as unknown as { uuid?: string; summary?: string; at?: number }
      items.push({
        id: mc.uuid ?? uid(),
        kind: 'compaction',
        parentToolUseId: null,
        ...(mc.summary ? { summary: mc.summary } : {}),
        at: typeof mc.at === 'number' ? mc.at : Date.now()
      })
      continue
    }
    if (m.type === 'assistant') {
      const beta = m.message as { content?: Array<Record<string, unknown>> }
      const blocks: AssistantBlock[] = []
      for (const c of beta.content ?? []) {
        if (c.type === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
        else if (c.type === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
        else if (c.type === 'tool_use') {
          const block: ToolBlock = {
            kind: 'tool',
            toolUseId: String(c.id ?? ''),
            name: String(c.name ?? 'tool'),
            input: c.input,
            status: 'pending'
          }
          blocks.push(block)
          // tool id 唯一；防御性地只记首个，与原"仅配 pending 块"语义一致。
          if (block.toolUseId && !toolBlocksById.has(block.toolUseId)) {
            toolBlocksById.set(block.toolUseId, block)
          }
        }
      }
      items.push({ id: m.uuid, kind: 'assistant', blocks, parentToolUseId: m.parent_tool_use_id })
    } else {
      const mp = m.message as { content?: unknown }
      const content = mp.content
      if (typeof content === 'string') {
        items.push({ id: m.uuid, kind: 'user', text: rewriteSkillEnvelope(content), parentToolUseId: m.parent_tool_use_id })
      } else if (Array.isArray(content)) {
        const toolResults = content.filter(
          (c) => !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
        )
        if (toolResults.length) {
          for (const tr of toolResults) {
            const tid = (tr as { tool_use_id?: string }).tool_use_id
            const b = tid ? toolBlocksById.get(tid) : undefined
            if (b && b.status === 'pending') {
              b.status = (tr as { is_error?: boolean }).is_error ? 'error' : 'done'
              b.result = (tr as { content?: unknown }).content
              b.resultIsError = !!(tr as { is_error?: boolean }).is_error
            }
          }
        } else {
          const text = content
            .map((c) =>
              c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''
            )
            .join('')
          if (text)
            items.push({ id: m.uuid, kind: 'user', text: rewriteSkillEnvelope(text), parentToolUseId: m.parent_tool_use_id })
        }
      }
    }
  }
  // #32 历史里无终态 result 的 tool_use（被杀/中断的子代理）不能重放成
  //  永久"运行中"：封口 stopped（无时间戳，计时诚实显示 —）。
  return sealHungToolBlocks(items, false)
}

/**
 * #6 后台会话（切走但未销毁）的事件缓冲。closeSession 现在是后台化语义——
 * turn 继续跑、事件继续推（带桥接 sessionId）。每个后台会话把自己的事件累积
 * 到一份独立状态里：运行标记实时（驱动侧栏呼吸点），且切回时内容连续完整，
 * 若后端会话还活着就直接 attach 这份状态，不走 session/load 全量重放（会重复）。
 *
 * 缓冲是 store 外的普通 Map：后台会话不可见，不需要响应式；attach 时一次性
 * set 进 store。折叠逻辑与 ingestAgentEvent 的主会话分支同构（有意的重复：
 * 主分支 deeply 耦合 zustand set()，抽出共享 view 的改动面远大于收益）。
 */
interface BackgroundSessionState {
  bridgeSessionId: string
  sdkSessionId?: string
  cwd: string
  agentBackend?: AgentBackendId
  model: string
  permissionMode: PermissionMode
  tools: string[]
  items: TranscriptItem[]
  currentStreamingMsgId: string | null
  running: boolean
  /** #41 本轮 turn 开始时间戳与"疑似无响应"提示：随缓冲走，attach 切回后
   *  忙碌态计时连续、提示不丢。 */
  startedAt?: number
  stall?: { elapsedMs: number; silentMs: number; at: number }
  /** 桥接进程已结束（agent:ended）：后端会话死了，attach 无意义，走原重放路径。 */
  ended: boolean
  error?: string
  tasks: SubagentTask[]
  planEntries: PlanEntry[]
  /** #23 待办最后更新时刻：不随快照走的话，切回后 plan 卡的陈旧度显示全错
   *  （旧快照看起来永远像刚更新）。 */
  planUpdatedAt: number | null
  /** #23 待授权弹窗队列：payload 不带会话 id（后台期间**新**到达的请求无法
   *  路由，仍会落在当时的前台会话），但切走时已在队里的必须随快照走、切回
   *  恢复——丢了的话那一轮 turn 永远等不到用户回应。 */
  pendingPermissions: PermissionRequestPayload[]
  goal: GoalInfo | null
  slashCommands: SkillInfo[]
  contextUsage: ContextUsage | null
  mcpServers: McpServerEntry[] | null
  /** AskUserQuestion 队列：后台期间到达的问题必须带着走——它阻塞 turn，
   *  丢弃的话切回后这轮永远等不到回答。 */
  elicitationQueue: ElicitationRequest[]
  /** #23 kimi server 轮询的 Swarm tasks（Swarm 面板数据源）：切走时的最后一帧
   *  随缓冲带走，后台期间的推送继续折叠进来；否则切回后面板降级成静态卡，
   *  运行中的子代理误显示完成态。 */
  swarmTasks: KimiTaskInfo[] | null
  /** #23 模式面板状态（Swarm/目标开关、计划前权限档）：低成本，随快照带走，
   *  切回不落回默认。 */
  modePanel: ModePanelState
  /** #29 后台 turn 出错时回收的未确认直达消息：attach 时落入 pendingQueue，
   *  走 #20 的重发/清空出路（与前台错误收尾同款语义）。 */
  recycledQueue?: PendingMessage[]
  /** 切走时的 pendingQueue 镜像。排队消息早已送达后端（SDK 内部排队，见
   *  sendMessage 注释 "Always push to the SDK"），这里存的只是 renderer 侧的
   *  显示镜像：原先切走直接清空，用户排了一半的队从界面上凭空消失。后台
   *  每收尾一个 turn 弹掉队首（对齐前台 result 的 slice(1)），attach 时把
   *  剩余队列接回 pendingQueue。与 recycledQueue 分开存：那边是没送到后端、
   *  等待重发的，这边是后端已知、只等消费的，弹队首绝不能弹错那一边。 */
  queuedMirror?: PendingMessage[]
}

const backgroundSessions = new Map<string, BackgroundSessionState>()
/** 缓冲上限：超限时淘汰最旧的空闲缓冲（连后端会话一起销毁，防内存/进程泄漏）。 */
const BACKGROUND_SESSION_CAP = 12

/** 导航离开当前会话前调用：把当前会话状态快照进后台缓冲，配合主进程的
 *  后台化语义，事件流由 foldBackgroundAgentEvent 继续往里累积。 */
function snapshotActiveSessionIntoBackground(get: () => SessionStore): void {
  // #1 快照前同步冲刷 streamBatcher 积压：pending 里的 delta 属于当前（即将
  // 后台化的）会话，必须先折进 items 再拍快照，否则内容进不了缓冲。
  flushPendingStreamDeltas()
  const s = get()
  const meta = s.meta
  // bridgeEnded 的后端会话已死，缓冲无意义（历史在磁盘上，走原重放路径）。
  if (!meta || s.bridgeEnded) return
  // #23 任何后续导航都使未消费的 swarmTasks 交接失效（防陈旧交接误配同 id 会话）。
  attachedSwarmTasks = null
  backgroundSessions.set(meta.sessionId, {
    bridgeSessionId: meta.sessionId,
    ...(meta.sdkSessionId ? { sdkSessionId: meta.sdkSessionId } : {}),
    cwd: meta.cwd,
    ...(meta.agentBackend ? { agentBackend: meta.agentBackend } : {}),
    model: meta.model,
    permissionMode: meta.permissionMode as PermissionMode,
    tools: meta.tools,
    items: s.items,
    currentStreamingMsgId: s.currentStreamingMsgId,
    running: s.status.running,
    ...(s.status.startedAt ? { startedAt: s.status.startedAt } : {}),
    ...(s.status.stall ? { stall: s.status.stall } : {}),
    ended: false,
    ...(s.status.error ? { error: s.status.error } : {}),
    tasks: s.tasks,
    planEntries: s.planEntries,
    planUpdatedAt: s.planUpdatedAt,
    pendingPermissions: s.pendingPermissions,
    goal: s.goal,
    slashCommands: s.slashCommands,
    contextUsage: s.contextUsage,
    mcpServers: s.mcpServers,
    elicitationQueue: s.elicitationQueue,
    swarmTasks: s.swarmTasks,
    modePanel: s.modePanel,
    // 排队消息随快照走（显示镜像，详见 queuedMirror 注释）。
    ...(s.pendingQueue.length > 0 ? { queuedMirror: s.pendingQueue } : {})
  })
  // 优先淘汰空闲会话；全都在跑时（长 turn 叠着开）此前直接 break，Map 会
  // 无上限增长——每个缓冲还在持续累积 items，底下的 bridge 会话也不释放。
  // 超出硬上限后按插入序淘汰最旧的，哪怕它还在跑。
  const HARD_CAP = BACKGROUND_SESSION_CAP * 2
  while (backgroundSessions.size > BACKGROUND_SESSION_CAP) {
    const idle = [...backgroundSessions.values()].find((bg) => !bg.running)
    const victim = idle ?? (backgroundSessions.size > HARD_CAP
      ? backgroundSessions.values().next().value
      : undefined)
    if (!victim) break
    backgroundSessions.delete(victim.bridgeSessionId)
    void window.api.destroySession(victim.bridgeSessionId).catch(() => {})
    // #5 连后端一起销毁的会话不再运行。
    markSdkSessionRunning(victim.sdkSessionId, false)
  }
}

/** 切回目标：还活着（未 agent:ended）的后台会话，按 agent 侧会话 id 查找。 */
function findLiveBackgroundSession(sdkSessionId: string): BackgroundSessionState | null {
  for (const bg of backgroundSessions.values()) {
    if (bg.sdkSessionId === sdkSessionId && !bg.ended) return bg
  }
  return null
}

/** 删除会话时用：取出（并移除）该 agent 会话对应的后台缓冲，无论是否已 ended。 */
function takeBackgroundSession(sdkSessionId: string): BackgroundSessionState | null {
  for (const bg of backgroundSessions.values()) {
    if (bg.sdkSessionId === sdkSessionId) {
      backgroundSessions.delete(bg.bridgeSessionId)
      return bg
    }
  }
  return null
}

/** 后台会话内容变了：失效它的历史缓存。否则 ended 后走 session/load 重放路径
 *  时会命中切走前 prefetch 的旧缓存，丢掉后台期间产生的内容。kimi-only 下
 *  openSession 的读取键 backend 恒为 'windows'，'current' 是防御性覆盖。 */
function invalidateBackgroundHistoryCache(bg: BackgroundSessionState): void {
  if (!bg.sdkSessionId) return
  deleteSessionHistoryCache(bg.cwd, bg.sdkSessionId)
  deleteSessionHistoryCache(bg.cwd, bg.sdkSessionId, 'windows')
}

/** #23 Swarm tasks 轮询推给非当前会话（后台）：折叠进它的缓冲，attach 时随
 *  bg.swarmTasks 一起恢复（与 foldBackgroundAgentEvent 同机制，只是数据源是
 *  window.api.onSwarmTasks 而非 agent 事件流）。 */
export function foldBackgroundSwarmTasks(sdkSessionId: string, tasks: KimiTaskInfo[] | null): void {
  for (const bg of backgroundSessions.values()) {
    if (bg.sdkSessionId === sdkSessionId) {
      bg.swarmTasks = tasks
      return
    }
  }
}

/** #23 attach 恢复的 swarmTasks 一次性交接：openSession 的 attach 分支写入，
 *  App 的 Swarm 订阅 effect 按 sdkSessionId 取走——否则 effect 的"切会话清空"
 *  会把刚恢复的状态抹回 null。undefined = 无交接；null = 有交接但当时就无数据。 */
let attachedSwarmTasks: { sdkSessionId: string; tasks: KimiTaskInfo[] | null } | null = null

export function takeAttachedSwarmTasks(sdkSessionId: string): KimiTaskInfo[] | null | undefined {
  const handoff = attachedSwarmTasks
  attachedSwarmTasks = null
  return handoff && handoff.sdkSessionId === sdkSessionId ? handoff.tasks : undefined
}

/** #5（对外契约）维护 runningSdkSessionIds：任何会话（前台/后台）turn 开始
 *  加入、结束（result/error/close）移除；sdkSessionId 未知（init 未到）的
 *  会话忽略。去重数组，未变化时不触发 set。 */
function markSdkSessionRunning(sdkSessionId: string | undefined, running: boolean): void {
  if (!sdkSessionId) return
  useSessionStore.setState((s) => {
    const has = s.runningSdkSessionIds.includes(sdkSessionId)
    if (running === has) return {}
    return {
      runningSdkSessionIds: running
        ? [...s.runningSdkSessionIds, sdkSessionId]
        : s.runningSdkSessionIds.filter((id) => id !== sdkSessionId)
    }
  })
}

/** #6（性能）后台缓冲是 store 外的普通对象（无渲染订阅；attach 时整体克隆进
 *  store，见 openSession），流式 delta 直接**原地**折叠，避免逐 token 全量拷贝
 *  items。语义与 applyStreamEvent 的 content_block_delta 分支一致（含目标条目
 *  缺失时的兜底新建）；streamBatcher 只把 content_block_delta 路由到这里，
 *  结构性 stream 事件仍走 foldBackgroundAgentEvent 的不可变路径。 */
function foldBackgroundDeltaInPlace(bg: BackgroundSessionState, b: StreamDeltaBatch): void {
  const msgId = bg.currentStreamingMsgId ?? b.fallbackId
  bg.currentStreamingMsgId = msgId
  // 流式目标几乎总在末位：先看末项，未命中再向前扫（防御）。
  let item: TranscriptItem | undefined = bg.items[bg.items.length - 1]
  if (!item || item.id !== msgId) {
    item = undefined
    for (let i = bg.items.length - 2; i >= 0; i--) {
      if (bg.items[i].id === msgId) {
        item = bg.items[i]
        break
      }
    }
  }
  if (!item) {
    const created: TranscriptItem = {
      id: msgId,
      kind: 'assistant',
      blocks: [],
      parentToolUseId: b.parent,
      streaming: true
    }
    bg.items = [...bg.items, created]
    item = created
  }
  if (item.kind !== 'assistant') return
  const index = b.event.index as number
  const delta = b.event.delta as
    | { type?: string; text?: string; thinking?: string; partial_json?: string }
    | undefined
  const blk = item.blocks[index]
  if (!delta || !blk) return
  if (delta.type === 'text_delta' && blk.kind === 'text') blk.text += delta.text ?? ''
  else if (delta.type === 'thinking_delta' && blk.kind === 'thinking') blk.text += delta.thinking ?? ''
  else if (delta.type === 'input_json_delta' && blk.kind === 'tool')
    blk.inputRaw = (blk.inputRaw ?? '') + (delta.partial_json ?? '')
}

/** 后台会话的事件折叠：与 ingestAgentEvent 主会话分支同构，直接改缓冲对象。 */
function foldBackgroundAgentEvent(get: () => SessionStore, e: AgentEvent): void {
  const bg = backgroundSessions.get(e.sessionId)
  if (!bg) return // 未快照过的会话（防御）：保持原丢弃行为
  if (e.type === 'agent:ended') {
    bg.ended = true
    bg.running = false
    delete bg.startedAt
    delete bg.stall
    const userStopped = isUserStopDiagnostic(e.error)
    bg.error = userStopped ? bg.error : (e.error ?? bg.error)
    // #29 台账终局结算（与前台 ended 同语义）：这个 bridge id 不会再有 result，
    // 出账防死条目滞留；异常收场把未确认消息回收进缓冲队列，attach 时落回
    // pendingQueue。
    const taken = takeUnackedDirectMessages(bg.bridgeSessionId)
    if (!userStopped && e.error !== undefined && taken.length) {
      bg.recycledQueue = [
        ...(bg.recycledQueue ?? []),
        ...taken.map((m) => ({
          id: uid(),
          text: m.text,
          ...(m.attachments ? { attachments: m.attachments } : {}),
          ...(m.swarm ? { swarm: true } : {}),
          ...(m.cutIn ? { cutIn: true } : {})
        }))
      ]
    }
    // #5 会话关闭：移出运行中列表。
    markSdkSessionRunning(bg.sdkSessionId, false)
    invalidateBackgroundHistoryCache(bg)
    scheduleSessionsRefresh(get)
    return
  }
  const msg = e.message as Record<string, unknown> & { type: string }
  switch (msg.type) {
    case 'system': {
      const subtype = msg.subtype as string
      if (subtype === 'init') {
        const m = msg as unknown as {
          session_id: string
          model: string
          permissionMode: string
          tools: string[]
        }
        bg.sdkSessionId = m.session_id
        bg.model = m.model
        bg.permissionMode = m.permissionMode as PermissionMode
        bg.tools = m.tools
      } else if (subtype === 'history') {
        const msgs = (msg as unknown as { messages?: HistoryMessage[] }).messages
        if (Array.isArray(msgs) && msgs.length) {
          const historyItems = historyToItems(msgs).map((it) => ({ ...it, isHistory: true }))
          const existing = new Set(bg.items.map((i) => i.id))
          const fresh = historyItems.filter((i) => !existing.has(i.id))
          // 压缩分界线去重：live 条（id=uid()、at=complete 时刻）与 wire 历史条
          // （id=w*-compaction、at=begin 时刻）对不上 id/时间，对账键是摘要正文。
          // 留历史那条（在历史中的位置正确），丢 live 那条。
          const historySummaries = new Set(
            fresh.flatMap((i) => (i.kind === 'compaction' && i.summary ? [i.summary] : []))
          )
          bg.items = [
            ...fresh,
            ...bg.items.filter(
              (i) => !(i.kind === 'compaction' && i.summary && historySummaries.has(i.summary))
            )
          ]
        }
      } else if (subtype === 'plan') {
        const entries = (msg as unknown as { entries?: PlanEntry[] }).entries
        bg.planEntries = Array.isArray(entries) ? entries : []
        // #23 陈旧度时钟随缓冲走，attach 后 plan 卡才知道这份快照有多新。
        bg.planUpdatedAt = Date.now()
      } else if (subtype === 'steered_turn') {
        // kimi 自发唤醒轮（后台任务完成 steer）的起止。收尾时把缓冲里的流式
        // 条目封口——steered 轮没有 result 事件,不封的话 attach 回来那条
        // 消息会永远挂着流式态。running 本身由 running-changed 推送管。
        if ((msg as unknown as { running?: boolean }).running !== true) {
          bg.items = bg.items.map((i) =>
            i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i
          )
        }
      } else if (subtype === 'goal') {
        const g = (msg as unknown as { goal?: GoalInfo | null }).goal
        bg.goal = g ?? null
      } else if (subtype === 'context_usage') {
        const usage = (msg as unknown as { contextUsage?: ContextUsage }).contextUsage
        bg.contextUsage = usage ? { ...usage, at: Date.now() } : null
      } else if (subtype === 'mcp_servers') {
        const servers = (msg as unknown as { servers?: McpServerEntry[] }).servers
        bg.mcpServers = Array.isArray(servers) ? servers : []
      } else if (subtype === 'query_result') {
        const q = (msg as unknown as { query?: { command?: string; text?: string; at?: number } }).query
        if (q) {
          bg.items = [
            ...bg.items,
            {
              id: uid(),
              kind: 'query' as const,
              parentToolUseId: null,
              command: q.command ?? '/status',
              text: q.text ?? '',
              at: q.at ?? Date.now()
            }
          ]
        }
      } else if (subtype === 'slash_commands') {
        const c = (msg as unknown as { commands?: SkillInfo[] }).commands
        bg.slashCommands = Array.isArray(c) ? c : []
      } else if (subtype === 'compaction') {
        // 压缩完成分界线：main 从 wire.jsonl 的 full_compaction.complete 推送
        // （宿主压缩全程零 ACP 文本输出，2026-08-20 wire 实证），摘要正文来自
        // apply_compaction。不再按文本标记过滤流式条目——那会把引用了标记
        // 文本的正常回复整条误删（同日实证）。
        const c = (msg as unknown as { compaction?: { summary?: string; at?: number } }).compaction
        if (c) {
          bg.items = [
            ...bg.items,
            {
              id: uid(),
              kind: 'compaction' as const,
              parentToolUseId: null,
              ...(c.summary ? { summary: c.summary } : {}),
              at: c.at ?? Date.now()
            }
          ]
        }
      } else if (subtype === 'permission_denied') {
        const d = msg as unknown as { tool_use_id: string; message: string }
        bg.items = mapTool(bg.items, d.tool_use_id, (b) => ({
          ...b,
          status: 'denied',
          errorMessage: d.message,
          endedAt: Date.now()
        }))
      } else if (subtype === 'task_started') {
        const t = msg as unknown as {
          task_id: string
          tool_use_id?: string
          description: string
          subagent_type?: string
        }
        const task: SubagentTask = {
          taskId: t.task_id,
          description: t.description,
          subagentType: t.subagent_type,
          toolUseId: t.tool_use_id,
          status: 'running',
          isBackgrounded: launchedInBackground(bg.items, t.tool_use_id)
        }
        bg.tasks = bg.tasks.some((x) => x.taskId === t.task_id)
          ? bg.tasks.map((x) => (x.taskId === t.task_id ? { ...x, ...task } : x))
          : [...bg.tasks, task]
      } else if (subtype === 'task_progress') {
        const t = msg as unknown as {
          task_id: string
          description?: string
          subagent_type?: string
          usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
          last_tool_name?: string
          summary?: string
        }
        bg.tasks = bg.tasks.map((x) =>
          x.taskId === t.task_id
            ? {
                ...x,
                description: t.description ?? x.description,
                subagentType: t.subagent_type ?? x.subagentType,
                tokens: t.usage?.total_tokens ?? x.tokens,
                toolUses: t.usage?.tool_uses ?? x.toolUses,
                durationMs: t.usage?.duration_ms ?? x.durationMs,
                lastToolName: t.last_tool_name ?? x.lastToolName,
                summary: t.summary ?? x.summary
              }
            : x
        )
      } else if (subtype === 'task_updated') {
        const t = msg as unknown as {
          task_id: string
          patch: { status?: string; description?: string; error?: string; is_backgrounded?: boolean }
        }
        const mappedStatus: SubagentStatus | undefined = t.patch.status
          ? t.patch.status === 'completed' || t.patch.status === 'failed'
            ? t.patch.status
            : t.patch.status === 'killed'
              ? 'stopped'
              : undefined
          : undefined
        bg.tasks = bg.tasks.map((x) =>
          x.taskId === t.task_id
            ? {
                ...x,
                description: t.patch.description ?? x.description,
                error: t.patch.error ?? x.error,
                status: mappedStatus ?? x.status,
                isBackgrounded: t.patch.is_backgrounded ?? x.isBackgrounded
              }
            : x
        )
      } else if (subtype === 'task_notification') {
        const t = msg as unknown as {
          task_id: string
          status: 'completed' | 'failed' | 'stopped'
          summary?: string
          usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
        }
        bg.tasks = bg.tasks.map((x) =>
          x.taskId === t.task_id
            ? {
                ...x,
                status: t.status,
                summary: t.summary ?? x.summary,
                tokens: t.usage?.total_tokens ?? x.tokens,
                toolUses: t.usage?.tool_uses ?? x.toolUses,
                durationMs: t.usage?.duration_ms ?? x.durationMs
              }
            : x
        )
      } else if (subtype === 'elicitation') {
        // AskUserQuestion 阻塞 turn：问题随缓冲带走，attach 后照常逐条回答。
        const req = (msg as unknown as { elicitation?: ElicitationRequest }).elicitation
        if (req?.toolUseID && !bg.elicitationQueue.some((q) => q.toolUseID === req.toolUseID)) {
          bg.elicitationQueue = [...bg.elicitationQueue, req]
        }
      } else if (subtype === 'turn_stall') {
        // #41 疑似无响应：提示随缓冲走，attach 切回后照常显示；recovered 撤掉。
        const stall = (msg as unknown as {
          stall?: { recovered?: boolean; elapsedMs?: number; silentMs?: number; at?: number }
        }).stall
        if (stall && !stall.recovered) {
          bg.stall = {
            elapsedMs: stall.elapsedMs ?? 0,
            silentMs: stall.silentMs ?? 0,
            at: stall.at ?? Date.now()
          }
        } else {
          delete bg.stall
        }
      }
      // status 等只影响瞬时 UI 的子类型，后台不需要。
      break
    }
    case 'user': {
      const parent = (msg.parent_tool_use_id as string | null) ?? null
      const content = (msg as unknown as { message: { content: unknown } }).message.content
      if (typeof content === 'string') {
        if (isModelSwitchControlOutput(content)) break
        // #9 向后扫描窗口内最近一条用户消息（跳过 query/compaction 等条目）。
        if (hasRecentOwnMessageEcho(bg.items, content)) {
          // #29 回显 = agent 已收到该条直达消息，出台账。
          ackUnackedDirectMessage(bg.bridgeSessionId, content)
        } else {
          bg.items = [...bg.items, { id: uid(), kind: 'user', text: content, parentToolUseId: parent }]
        }
        // 后台任务完成通知信封：补登对应工具块终态（后台命令面板纠错）。
        bg.items = applyTaskTerminalEnvelope(bg.items, content)
        bg.running = true
        markSdkSessionRunning(bg.sdkSessionId, true)
      } else if (Array.isArray(content)) {
        const toolResults = content.filter(
          (c): c is { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; partial?: boolean } =>
            !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
        )
        if (toolResults.length) {
          for (const tr of toolResults) {
            bg.items = mapTool(bg.items, tr.tool_use_id, (b) => ({
              ...b,
              status: tr.partial ? 'running' : tr.is_error ? 'error' : 'done',
              result: tr.content,
              resultIsError: tr.partial ? b.resultIsError : !!tr.is_error,
              ...(tr.partial ? {} : { endedAt: Date.now() }),
              ...((tr as { input?: unknown }).input && typeof (tr as { input?: unknown }).input === 'object'
                ? {
                    input: {
                      ...((b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>),
                      ...((tr as { input?: Record<string, unknown> }).input ?? {})
                    }
                  }
                : {})
            }))
          }
        } else {
          const text = content
            .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
            .join('')
          if (isModelSwitchControlOutput(text)) break
          if (text) {
            // #9 同上：窗口内找最近一条用户消息比对，而不是只看末项。
            if (hasRecentOwnMessageEcho(bg.items, text)) {
              ackUnackedDirectMessage(bg.bridgeSessionId, text)
            } else {
              bg.items = [...bg.items, { id: uid(), kind: 'user', text, parentToolUseId: parent }]
            }
          }
        }
      }
      break
    }
    case 'stream_event': {
      const su = msg as unknown as { uuid: string; parent_tool_use_id: string | null; event: Record<string, unknown> }
      const res = applyStreamEvent(
        { items: bg.items, currentStreamingMsgId: bg.currentStreamingMsgId },
        su.uuid,
        su.parent_tool_use_id ?? null,
        su.event
      )
      bg.items = res.items
      bg.currentStreamingMsgId = res.currentStreamingMsgId
      break
    }
    case 'assistant': {
      const parent = (msg.parent_tool_use_id as string | null) ?? null
      const m = msg as unknown as {
        uuid: string
        error?: string
        message: { id?: string; content: Array<Record<string, unknown>> }
      }
      const blocks: AssistantBlock[] = []
      for (const c of m.message?.content ?? []) {
        const t = c.type
        if (t === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
        else if (t === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
        else if (t === 'tool_use') {
          blocks.push({
            kind: 'tool',
            toolUseId: String(c.id ?? ''),
            name: String(c.name ?? 'tool'),
            input: c.input,
            status: 'pending',
            startedAt: Date.now()
          })
        }
      }
      if (blocks.length > 0 && blocks.every((b) => b.kind === 'text' && isModelSwitchControlOutput(b.text))) {
        bg.currentStreamingMsgId = null
        break
      }
      let targetId: string | null = null
      if (bg.currentStreamingMsgId && bg.items.some((i) => i.id === bg.currentStreamingMsgId)) {
        targetId = bg.currentStreamingMsgId
      } else if (m.message?.id && bg.items.some((i) => i.id === m.message.id)) {
        targetId = m.message.id
      }
      const finalId = targetId ?? (m.uuid ?? uid())
      bg.items =
        targetId !== null
          ? bg.items.map((i) =>
              i.id === finalId
                ? { id: finalId, kind: 'assistant' as const, blocks, parentToolUseId: parent, error: m.error }
                : i
            )
          : [...bg.items, { id: finalId, kind: 'assistant' as const, blocks, parentToolUseId: parent, error: m.error }]
      bg.running = true
      markSdkSessionRunning(bg.sdkSessionId, true)
      bg.currentStreamingMsgId = null
      invalidateBackgroundHistoryCache(bg)
      break
    }
    case 'tool_progress': {
      const p = msg as unknown as { tool_use_id: string; elapsed_time_seconds: number }
      bg.items = mapTool(bg.items, p.tool_use_id, (b) => ({
        ...b,
        status: 'running',
        elapsed: p.elapsed_time_seconds
      }))
      break
    }
    case 'result': {
      const r = msg as unknown as { subtype: string; errors?: string[] }
      // turn 结束：清流式标记。队列镜像每个收尾弹一次队首（对齐前台 result
      // 的 slice(1)）：后端收下一条排队消息继续跑，running 保持 true；队列
      // 已空才是真的闲下来。
      const queuedBefore = bg.queuedMirror?.length ?? 0
      if (queuedBefore > 0) {
        // 队首被后端消费成新的一轮：镜像弹出 + **补登用户气泡**（原先后台路径只弹
        // 不登——排队消息在后台被处理完，转录里永远没有它的气泡：回复悬空、队列
        // 也没了，用户看到的就是「排队消息丢了」。2026-08-19 用户：「切换会话，
        // 之前会话排队的消息会丢失」。与前台 result 分支的 pendingQueue[0] 同款）。
        const popped = bg.queuedMirror![0]!
        bg.queuedMirror = bg.queuedMirror!.slice(1)
        bg.items = [
          ...bg.items,
          {
            id: popped.id,
            kind: 'user' as const,
            text: popped.text,
            parentToolUseId: null,
            ...(popped.attachments ? { attachments: popped.attachments } : {}),
            ...(popped.swarm ? { swarm: true } : {}),
            ...(popped.cutIn ? { cutIn: true } : {})
          }
        ]
      }
      bg.running = queuedBefore > 0
      if (queuedBefore === 0) markSdkSessionRunning(bg.sdkSessionId, false)
      delete bg.startedAt
      delete bg.stall
      bg.items = sealHungToolBlocks(
        bg.items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i)),
        true
      )
      bg.currentStreamingMsgId = null
      const resultError = r.errors?.length ? r.errors.join('; ') : r.subtype
      if (r.subtype === 'success') {
        // #29 后台会话成功收尾：该会话的未确认直达消息出台账（防台账滞留）。
        takeUnackedDirectMessages(bg.bridgeSessionId)
      } else if (!isUserStopDiagnostic(resultError)) {
        bg.error = resultError
        // #29 后台 turn 出错：未确认直达消息回收进缓冲队列（原先只出账不回收，
        // 后台错误的消息等于被吞），attach 时落回 pendingQueue。
        const taken = takeUnackedDirectMessages(bg.bridgeSessionId)
        if (taken.length) {
          bg.recycledQueue = [
            ...(bg.recycledQueue ?? []),
            ...taken.map((m) => ({
              id: uid(),
              text: m.text,
              ...(m.attachments ? { attachments: m.attachments } : {}),
              ...(m.swarm ? { swarm: true } : {}),
              ...(m.cutIn ? { cutIn: true } : {})
            }))
          ]
        }
      }
      invalidateBackgroundHistoryCache(bg)
      scheduleSessionsRefresh(get)
      break
    }
    default:
      break
  }
}

/** 上一个在飞的 init 看门狗。每次导航都会排一个 60s 定时器，此前从不取消，
 *  快速切会话时会攒下一堆（虽有 starting/sessionId 守卫不会误触发，但闭包
 *  会被白留 60 秒）。同一时刻只需要一个。 */
let initWatchdogTimer: ReturnType<typeof setTimeout> | null = null

function cancelInitWatchdog(): void {
  if (initWatchdogTimer !== null) {
    clearTimeout(initWatchdogTimer)
    initWatchdogTimer = null
  }
}

/** If the SDK never sends system/init (e.g. the API backend hangs), unblock the
 *  UI after a timeout so the user can retry via New chat. */
function scheduleInitWatchdog(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  sessionId?: string
): void {
  cancelInitWatchdog()
  initWatchdogTimer = setTimeout(() => {
    initWatchdogTimer = null
    if (get().starting && (!sessionId || get().meta?.sessionId === sessionId)) {
      set((s) => ({
        starting: false,
        status: {
          ...s.status,
          error: '会话初始化超时 — 后端可能响应较慢或不可用。请尝试新建对话。'
        }
      }))
    }
  }, 60000)
}

/**
 * 待创建的会话（懒起）。
 *
 * 「+ 新建对话」原先立刻 startSession —— 后端当场落一个会话到磁盘，kimi 给它
 * 的 title 恒为 "New Session"，于是每点一次、每开一次窗口，侧栏就多一条你从
 * 没说过话的空会话。改成：点击只切界面，把「怎么起」记在这里，等真的发第一
 * 条消息时才起后端。没说话就没有会话，也就没有空壳可清理。
 *
 * 只留一个槽位：任何一次会话导航（nextSessionNavigationSeq）都会作废它——
 * 用户点了新建又转头去开历史会话，那个从没起过的会话就该消失得干干净净。
 */
let pendingSessionStart: { sessionId: string; start: () => Promise<void> } | null = null

/** 取走并清空该会话的待起任务（没有则返回 null）。 */
function takePendingSessionStart(sessionId: string): (() => Promise<void>) | null {
  if (!pendingSessionStart || pendingSessionStart.sessionId !== sessionId) return null
  const { start } = pendingSessionStart
  pendingSessionStart = null
  return start
}

function nextSessionNavigationSeq(): number {
  // #1 任何会话导航入口（openSession/newChat/switchProject/restartSession/
  // openSessionCrossProject…）都经过这里：先同步冲刷 streamBatcher 积压，
  // 再推进导航序号。此刻 meta 还指向旧会话，冲出的 delta 落进正确的一侧。
  flushPendingStreamDeltas()
  sessionNavigationSeq += 1
  pendingSessionStart = null
  return sessionNavigationSeq
}

function isCurrentSessionNavigation(
  get: () => SessionStore,
  requestSeq: number,
  bridgeSessionId: string
): boolean {
  return sessionNavigationSeq === requestSeq && get().meta?.sessionId === bridgeSessionId
}

function createSessionStartGate(sessionId: string): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolveGate!: () => void
  let rejectGate!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve
    rejectGate = reject
  })
  sessionStartPromises.set(sessionId, promise)
  promise.catch(() => {})
  const cleanup = (): void => {
    if (sessionStartPromises.get(sessionId) === promise) {
      sessionStartPromises.delete(sessionId)
    }
  }
  promise.then(cleanup, cleanup)
  return {
    promise,
    resolve: resolveGate,
    reject: rejectGate
  }
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  starting: false,
  bootstrapped: false,
  meta: null,
  effort: 'high',
  items: [],
  historyPrependSeq: 0,
  historyPrependCount: 0,
  status: emptyStatus,
  pendingPermissions: [],
  currentStreamingMsgId: null,
  sessions: [],
  sessionsLoading: false,
  sessionsHasMore: false,
  // 2026-08-12 用户定稿：侧栏不再分「当前项目/全部」，一律跨项目全部会话
  //（Codex 同款）。scope 机制保留（切换 API 还在），只是 UI 不再暴露。
  sessionScope: 'all',
  tasks: [], pendingQueue: [],
  sessionConfigDirty: false,
  sessionModelDirty: false,
  bridgeEnded: false,
  slashCommands: [],
  planEntries: [],
  planUpdatedAt: null,
  swarmTasks: null,
  contextUsage: null,
  mcpServers: null,
  modePanel: defaultModePanel(),
  goal: null,
  elicitationQueue: [],
  runningSdkSessionIds: [],
  composerDrafts: readStoredComposerDrafts(),
  unreadReplies: readStoredUnreadReplies(),
  todoOverrides: {},

  async refreshTodos() {
    const sdkSessionId = get().meta?.sdkSessionId
    if (!sdkSessionId) return
    // 这个会话已经确认没了（40401）：不再浪费请求。之前没有这道闸，实测日志里
    // `session not found` 每 10 秒刷一条、无限刷下去。
    if (deadTodoSessions.has(sdkSessionId)) return
    const result = await window.api.getSessionTodos(sdkSessionId).catch(() => null)
    // #3 await 期间可能已切会话：A 的待办不能写进 B 的面板，身份不符直接丢弃。
    if (get().meta?.sdkSessionId !== sdkSessionId) return
    if (result === 'session-gone') {
      deadTodoSessions.add(sdkSessionId)
      return
    }
    // null = 拉不到（server 没起/网络错）。**不能当成"待办为空"**——那会把
    // 界面上刚推来的待办清掉。
    if (!result) return

    const localAt = get().planUpdatedAt
    if (result.updatedAt === null) {
      // 服务端没有待办记录。本地也没有就无事发生；本地有则以本地为准
      // （实时 plan 帧刚推来、服务端还没落盘的情况）。
      return
    }
    // 实时 plan 帧比服务端记录新就不覆盖：ACP 那条是推送，永远更及时。
    if (localAt !== null && localAt >= result.updatedAt) return
    // 手动勾掉的覆盖懒清理（2026-08-26）：条目从服务端列表消失就丢弃对应
    // override——kimi 全量重写列表，消失的条目基本不会原文回归。空列表不清
    // （可能是没落盘的瞬时态），见 pruneVanishedTodoOverrides 注释。
    const prunedOverrides = pruneVanishedTodoOverrides(get().todoOverrides, result.entries)
    if (prunedOverrides) storeTodoOverrides(sdkSessionId, prunedOverrides)
    set({
      planEntries: result.entries,
      planUpdatedAt: result.updatedAt,
      ...(prunedOverrides ? { todoOverrides: prunedOverrides } : {})
    })
  },

  toggleTodoComplete(entry) {
    const sdkSessionId = get().meta?.sdkSessionId
    if (!sdkSessionId) return
    const key = todoKeyOf(entry.content)
    const current = get().todoOverrides
    // 服务端已完成且无 override：不动。ACP 只读，「取消完成」没有真值可回退；
    // 手动层只负责把未完成勾成完成，以及撤销这个手动勾。
    if (entry.status === 'completed' && !current[key]) return
    const next = { ...current }
    if (next[key]) delete next[key]
    else next[key] = true
    storeTodoOverrides(sdkSessionId, next)
    set({ todoOverrides: next })
  },

  setComposerDraft(sessionKey, text) {
    const drafts = { ...get().composerDrafts }
    if (text) drafts[sessionKey] = text
    else delete drafts[sessionKey]
    storeComposerDrafts(drafts)
    set({ composerDrafts: drafts })
  },

  noteReplyCompleted(sessionKey) {
    const counts = { ...get().unreadReplies }
    counts[sessionKey] = Math.min((counts[sessionKey] ?? 0) + 1, UNREAD_REPLIES_MAX)
    storeUnreadReplies(counts)
    set({ unreadReplies: counts })
  },

  clearUnread(sessionKey) {
    // 没有条目时连 set 都省掉（openSession 是热路径，每次切会话都会调）。
    if (!(sessionKey in get().unreadReplies)) return
    const counts = { ...get().unreadReplies }
    delete counts[sessionKey]
    storeUnreadReplies(counts)
    set({ unreadReplies: counts })
  },

  async startSession(args) {
    if (get().starting) return
    cancelActiveHistoryHydration()
    set({ starting: true })
    // Pre-register synchronously: bridgeSessionId is added to the bridge's map
    // before claude.exe finishes spawning, so the UI never locks on init.
    try {
      const newId = uid()
      const prefs = await window.api.getPreferences().catch(() => null)
      const agentBackend = prefs?.agentBackend
      // 冷启动没人传 model（Onboarding 只给 cwd）：用上次选过的那个，而不是
      // 每次都掉回默认——这正是"每次开 Tran 都要重新选模型"的根因。
      const requestedModel = args.model ?? readLastModel(agentBackend)
      const model = modelForAgent(agentBackend, requestedModel)
      const permissionMode = prefs?.defaultPermissionMode ?? 'default'
      const effort = prefs?.defaultEffort ?? 'high'
      const opts: StartSessionOptions = {
        cwd: args.cwd,
        ...(agentBackend ? { agentBackend } : {}),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        ...(model ? { model } : {}),
        effort,
        permissionMode,
        bridgeSessionId: newId
      }
      await window.api.startSession(opts)
      set({
        starting: false,
        effort,
        meta: {
          sessionId: newId,
          ...(agentBackend ? { agentBackend } : {}),
          cwd: args.cwd,
          model: displayModelForAgent(agentBackend, requestedModel),
          permissionMode,
          tools: []
        },
        items: [],
        tasks: [], pendingQueue: [],
        sessionConfigDirty: false,
        sessionModelDirty: false,
        bridgeEnded: false,
        slashCommands: [],
        planEntries: [],
        planUpdatedAt: null,
        contextUsage: null,
        mcpServers: null,
        modePanel: defaultModePanel(),
        goal: null,
        elicitationQueue: [],
        // #23 上一会话残留的授权弹窗不属于新会话。
        pendingPermissions: [],
        status: { running: false },
        currentStreamingMsgId: null
      })
      void get().refreshSessions()
      scheduleInitWatchdog(get, set, newId)
    } catch (err) {
      set({ starting: false })
      throw err
    }
  },

  async sendMessage(text, attachments, opts) {
    let meta = get().meta
    if (!meta) return
    const value = text.trim()
    const atts = attachments ?? []
    if (!value && atts.length === 0) return
    // Ctrl+S 插队标记（气泡显示"插队"徽章）。
    const cutInProps = opts?.cutIn ? { cutIn: true } : {}
    // 发送那一刻的模式面板快照：下面可能有 await（会话重建/懒起落地），期间
    // 用户切了会话的话 get() 读到的是**别的会话**的面板状态。
    const modePanelAtSend = get().modePanel
    // 重建 await 期间用户切走了：全局 state 已属于别的会话，消息改走后台
    // 缓冲直达（见下）。
    let backgroundedDuringRebuild = false

    const needsSessionRefresh =
      (get().sessionConfigDirty || get().sessionModelDirty || get().bridgeEnded) &&
      !get().starting &&
      !get().status.running
    if (needsSessionRefresh) {
      const oldMeta = meta
      const oldSessionId = oldMeta.sessionId
      const newId = uid()
      const nextMeta: SessionMeta = { ...oldMeta, sessionId: newId, tools: [] }
      const refreshingModel = get().sessionModelDirty
      const shouldResume = !!oldMeta.sdkSessionId && !refreshingModel
      if (!shouldResume) delete nextMeta.sdkSessionId

      // #1 桥接 id 即将更换：先冲掉 streamBatcher 里挂在旧 id 上的积压 delta，
      // 否则换 id 后它们会被当成后台会话路由、落进不存在的缓冲而丢失。
      flushPendingStreamDeltas()
      set({
        meta: nextMeta,
        currentStreamingMsgId: null,
        pendingPermissions: []
      })

      try {
        await window.api.startSession({
          cwd: oldMeta.cwd,
          ...(modelForAgent(oldMeta.agentBackend, oldMeta.model) ? { model: modelForAgent(oldMeta.agentBackend, oldMeta.model) } : {}),
          ...(oldMeta.agentBackend ? { agentBackend: oldMeta.agentBackend } : {}),
          effort: get().effort,
          permissionMode: oldMeta.permissionMode as PermissionMode,
          ...(shouldResume ? { resume: oldMeta.sdkSessionId } : {}),
          bridgeSessionId: newId
        })
        // 旧桥接已被新 resume 会话取代（同一 acpSessionId 不能双注册）：显式销毁，
        // 不用后台化语义的 closeSession。
        await window.api.destroySession(oldSessionId).catch(() => {})
        if (get().meta?.sessionId === newId) {
          set({ sessionConfigDirty: false, sessionModelDirty: refreshingModel, bridgeEnded: false })
          meta = get().meta
          if (!meta) return
        } else {
          // await 期间用户切走了：现在的全局 state 属于**另一个**会话，一个
          // 字段都不能动（原实现在这里无条件 set + 重读 meta，会把本条消息
          // 发进切到的那个会话）。消息仍属于原会话——重建出的新桥接就是它
          // 的，继续用 nextMeta 走后台直达路径。
          backgroundedDuringRebuild = true
          meta = nextMeta
        }
      } catch (error: unknown) {
        if (get().meta?.sessionId === newId) {
          set((s) => ({
            meta: oldMeta,
            status: {
              ...s.status,
              error: error instanceof Error ? error.message : String(error)
            }
          }))
        } else {
          // 切走后才失败：旧桥接还活着（失败路径没销毁），把已折进后台缓冲
          // 的快照改挂回旧桥接并记下错误；当前会话的 state 不碰。
          const bg = backgroundSessions.get(newId)
          if (bg) {
            backgroundSessions.delete(newId)
            bg.bridgeSessionId = oldSessionId
            bg.error = error instanceof Error ? error.message : String(error)
            backgroundSessions.set(oldSessionId, bg)
          }
        }
        return
      }
    }

    if (meta.sdkSessionId) deleteSessionHistoryCache(meta.cwd, meta.sdkSessionId)
    // 目标模式：goalEnabled 且无进行中的目标时，用本条消息文本创建目标（本条即第 1 轮）。
    if (!backgroundedDuringRebuild && modePanelAtSend.goalEnabled && value) {
      const currentGoal = get().goal
      if (!currentGoal || (currentGoal.status !== 'active' && currentGoal.status !== 'paused')) {
        void window.api.goalStart(meta.sessionId, { objective: value }).catch(() => {})
      }
    }
    // Swarm 模式：发送时在用户文本前隐藏拼接指令前缀（气泡显示原文 + Swarm 徽章）。
    const swarmOn = modePanelAtSend.swarmEnabled
    const wireValue = swarmOn ? SWARM_PROMPT_PREFIX + value : value
    const swarmProps = swarmOn ? { swarm: true } : {}
    // Build the wire content: plain text, or content blocks when there are
    // attachments (image → image block, text → inlined, other → path ref).
    let content: string | unknown[]
    if (atts.length) {
      const blocks: unknown[] = []
      if (wireValue) blocks.push({ type: 'text', text: wireValue })
      for (const a of atts) {
        if (a.kind === 'image') {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mimeType, data: a.data }
          })
        } else if (a.kind === 'text') {
          blocks.push({
            type: 'text',
            text: `\n\n📎 ${a.name}:\n\`\`\`\n${a.data}\n\`\`\``
          })
        } else {
          blocks.push({ type: 'text', text: `\n\n📎 ${a.path}` })
        }
      }
      content = blocks
    } else {
      content = wireValue
    }
    const displayAttachments: UserAttachment[] | undefined = atts.length
      ? atts.map(pickedFileToUserAttachment)
      : undefined
    const attProps = displayAttachments ? { attachments: displayAttachments } : {}

    if (backgroundedDuringRebuild) {
      // 条目折进原会话的后台缓冲（切回就能看到），发送走桥接 id 直达——
      // 后续事件流由 ingestAgentEvent 的后台分流继续折进同一个缓冲。
      const bg = backgroundSessions.get(meta.sessionId)
      if (bg) {
        bg.items = [
          ...bg.items,
          { id: uid(), kind: 'user', text: value, parentToolUseId: null, ...attProps, ...swarmProps, ...cutInProps }
        ]
        bg.running = true
        invalidateBackgroundHistoryCache(bg)
      }
      markSdkSessionRunning(meta.sdkSessionId, true)
      const bridgeId = meta.sessionId
      await window.api.sendMessage(bridgeId, content).catch(() => {
        const bgNow = backgroundSessions.get(bridgeId)
        if (bgNow) {
          bgNow.running = false
          bgNow.error = '消息发送失败'
        }
        markSdkSessionRunning(meta?.sdkSessionId, false)
      })
      return
    }

    // Always push to the SDK (it queues internally); the UI placement differs.
    // Queue (hover) only when the MAIN agent is genuinely busy — not when it's
    // merely waiting on a backgrounded subagent (then it's free for new input).
    const hasBackgroundSubagent = get().tasks.some(
      (t) => t.isBackgrounded && t.status === 'running'
    )
    const busy = get().status.running && !hasBackgroundSubagent
    // #29：直达消息入未确认台账（数组：连发多条各占一席，互不覆盖）——turn
    // 错误收尾时靠它全部回收（见 result 分支）；本条 IPC 失败只回收本条。
    let unackedEntry: UnackedDirectMessage | null = null
    if (busy) {
      set((s) => ({ pendingQueue: [...s.pendingQueue, { id: uid(), text: value, ...attProps, ...swarmProps, ...cutInProps }] }))
    } else {
      unackedEntry = { sessionId: meta.sessionId, text: value, ...attProps, ...swarmProps, ...cutInProps }
      unackedDirectMessages = [...unackedDirectMessages, unackedEntry]
      set((s) => ({
        items: [...s.items, { id: uid(), kind: 'user', text: value, parentToolUseId: null, ...attProps, ...swarmProps, ...cutInProps }],
        status: { ...s.status, running: true, error: undefined }
      }))
      // #5 turn 开始：加入运行中列表（sdkSessionId 未知则忽略）。
      markSdkSessionRunning(meta.sdkSessionId, true)
    }
    try {
      // 懒起的会话在这里才真正落地：「+ 新建对话」只切了界面，后端要等到
      // 第一条消息（见 pendingSessionStart）。没有待起任务时这就是个空操作。
      const deferredStart = takePendingSessionStart(meta.sessionId)
      if (deferredStart) await deferredStart()
      await sessionStartPromises.get(meta.sessionId)
      // 懒起 await 期间切走会话：消息已进转录（随快照进了后台缓冲），这里
      // 照发——桥接 id 明确指向原会话，不发才是把消息吞掉（原实现在此直接
      // return，转录里躺着一条从未送达的消息）。
      await window.api.sendMessage(meta.sessionId, content)
    } catch (error: unknown) {
      if (get().meta?.sessionId !== meta.sessionId) return
      // #29：直达发送在 IPC 层就失败（消息没到后端）：立即回收到 pendingQueue
      // 队首，与 turn 错误收尾的回收同一条出路。busy 路径本就在队列里，不重收。
      // 只回收**本条**——台账里更早的直达消息可能已经送达。
      const unacked = unackedEntry && unackedDirectMessages.includes(unackedEntry) ? unackedEntry : null
      if (unacked) unackedDirectMessages = unackedDirectMessages.filter((m) => m !== unacked)
      markSdkSessionRunning(get().meta?.sdkSessionId, false)
      set((s) => ({
        pendingQueue: unacked
          ? [
              {
                id: uid(),
                text: unacked.text,
                ...(unacked.attachments ? { attachments: unacked.attachments } : {}),
                ...(unacked.swarm ? { swarm: true } : {}),
                ...(unacked.cutIn ? { cutIn: true } : {})
              },
              ...s.pendingQueue
            ]
          : s.pendingQueue,
        status: {
          ...s.status,
          running: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
    }
  },

  async interrupt() {
    const meta = get().meta
    if (!meta) return
    // 手动停止态：被中断轮次里仍 running/pending 的工具块标记 stopped（区别于"出错"）。
    // 同时乐观清空 running——Ctrl+S 插队依赖它让紧随的 sendMessage 直达（不排队）。
    const now = Date.now()
    set((s) => ({
      items: s.items.map((it) =>
        it.kind !== 'assistant'
          ? it
          : {
              ...it,
              blocks: it.blocks.map((b) =>
                b && b.kind === 'tool' && (b.status === 'running' || b.status === 'pending')
                  ? { ...b, status: 'stopped' as const, endedAt: now }
                  : b
              )
            }
      ),
      status: { ...s.status, running: false, stall: undefined }
    }))
    // #5 乐观移出运行中列表（真实定论仍由 result/running-changed 推送校正）。
    markSdkSessionRunning(meta.sdkSessionId, false)
    await window.api.interrupt(meta.sessionId)
  },

  async setModel(model) {
    const meta = get().meta
    if (!meta) return
    if (meta.model === model) return
    // Kimi ACP 支持会话内实时切换模型（session/set_config_option），无需重启
    // 会话；切换失败时后端只记录日志，本地状态保持新值即可。
    set({ meta: { ...meta, model } })
    // 记住这个选择：否则下次开 Tran 又回到默认模型，得重新选一遍。
    storeLastModel(meta.agentBackend, model)
    await window.api.setModel(meta.sessionId, model).catch(() => {})
  },

  async setPermissionMode(mode) {
    const meta = get().meta
    if (!meta) return
    if (meta.permissionMode === mode) return
    // Permission mode switches LIVE via the bridge (query.setPermissionMode),
    // so it takes effect immediately rather than on the next message. Keep meta
    // in sync optimistically; the next init event confirms the SDK's real mode.
    set({ meta: { ...meta, permissionMode: mode } })
    storePermissionMode(meta.sdkSessionId, mode)
    await window.api.setPermissionMode(meta.sessionId, mode).catch(() => {})
  },

  async setPlanEnabled(on) {
    const meta = get().meta
    if (!meta) return
    const current = meta.permissionMode
    if (on) {
      if (current === 'plan') return
      // 记住当前权限档，关计划时恢复（ACP 单 mode 配置，计划与权限互斥）。
      set((s) => ({
        modePanel: { ...s.modePanel, modeBeforePlan: (current as PermissionMode) ?? 'default' }
      }))
      await get().setPermissionMode('plan')
    } else {
      if (current !== 'plan') return
      const restore = get().modePanel.modeBeforePlan ?? 'default'
      set((s) => ({ modePanel: { ...s.modePanel, modeBeforePlan: null } }))
      await get().setPermissionMode(restore)
    }
  },

  async setSwarmEnabled(on) {
    set((s) => ({ modePanel: { ...s.modePanel, swarmEnabled: on } }))
  },

  async setGoalEnabled(on) {
    set((s) => ({ modePanel: { ...s.modePanel, goalEnabled: on } }))
  },

  reset() {
    cancelActiveHistoryHydration(0)
    // #1 丢会话前冲掉 streamBatcher 积压，别让迟到 delta 在清空后的 store 里复活。
    flushPendingStreamDeltas()
    unackedDirectMessages = []
    set({ starting: false, meta: null, items: [], tasks: [], pendingQueue: [], sessionConfigDirty: false, sessionModelDirty: false, bridgeEnded: false, status: emptyStatus, pendingPermissions: [], currentStreamingMsgId: null, sessions: [], sessionsHasMore: false, slashCommands: [], planEntries: [], planUpdatedAt: null, contextUsage: null, mcpServers: null, modePanel: defaultModePanel(), goal: null, elicitationQueue: [], runningSdkSessionIds: [] })
  },

  async bootstrap() {
    if (get().bootstrapped || get().meta) return
    if (startupBootstrapPromise) return startupBootstrapPromise

    // 2026-08-26 回退：v1.1.48 曾按误解决策改为启动停首页（用户原意是"在不
    // 注册为项目的目录里工作"，不是"不进项目"），这里恢复自动进入上次项目
    // （懒创建，见 openStartupProject 注释）。
    startupBootstrapPromise = (async () => {
      try {
        const proj = await window.api.getStartupProject()
        if (proj) {
          const provider = await window.api.getActiveProvider()
          await get().openStartupProject(proj.path, provider?.model)
        }
      } finally {
        set({ bootstrapped: true })
        startupBootstrapPromise = null
      }
    })()

    return startupBootstrapPromise
  },

  /**
   * 启动时进入上次的项目 —— **懒创建**，与 newChat 同一套机制。
   *
   *
   * 此前这里直接调 startSession()，也就是每开一次 Tran 就真的 `session/new`
   * 一个空会话落盘；用户进来还没说话就切去历史会话，那条 "New Session" 就
   * 永远留在列表里了（2026-08-05 实测：仅启动一次，磁盘会话目录 104 → 105）。
   *
   * 「新建对话改为懒创建」当初只覆盖了侧栏的新建按钮，**漏了这条启动路径** ——
   * 同一个毛病换个入口又冒出来。现在两条路一致：先只把界面切成空会话，把
   * 「怎么起」记进 pendingSessionStart，等真的发第一条消息再起后端。没说话
   * 就没有会话，也就没有空壳要清理。
   */
  async openStartupProject(cwd: string, requestedModel?: string) {
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)
    const prefs = await window.api.getPreferences().catch(() => null)
    const agentBackend = prefs?.agentBackend
    // 冷启动这条路径最要紧：调用方不传 model，掉回默认就等于"每次开 Tran
    // 都要重新选模型"。改为优先用上次选过的那个。
    const model = requestedModel ?? readLastModel(agentBackend)
    const permissionMode = prefs?.defaultPermissionMode ?? 'default'
    const effort = prefs?.defaultEffort ?? 'high'
    // 启动路径没有"上一个会话"要快照，判导航序号即可（用户可能在偏好还没
    // 读回来时就点了侧栏的历史会话）。
    if (sessionNavigationSeq !== requestSeq) return
    // starting 保持 false：没有任何东西在启动，不该显示"正在进入会话"骨架。
    set({
      starting: false,
      effort,
      items: [],
      tasks: [], pendingQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      planEntries: [],
      planUpdatedAt: null,
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
      pendingPermissions: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: {
        sessionId: newId,
        ...(agentBackend ? { agentBackend } : {}),
        cwd,
        model: displayModelForAgent(agentBackend, model),
        permissionMode,
        tools: []
      }
    })
    // 侧栏历史列表要立刻可用：用户很可能一进来就去点历史会话。
    void get().refreshSessions()
    // 后端推迟到第一条消息（与 newChat 同形态，见 pendingSessionStart）。
    pendingSessionStart = {
      sessionId: newId,
      start: async () => {
        const startGate = createSessionStartGate(newId)
        try {
          await window.api.startSession({
            cwd,
            ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
            ...(agentBackend ? { agentBackend } : {}),
            effort: get().effort,
            permissionMode,
            bridgeSessionId: newId
          })
          startGate.resolve()
        } catch (error: unknown) {
          startGate.reject(error)
          if (!isLatestRequest()) return
          set((s) => ({
            starting: false,
            status: { ...s.status, error: error instanceof Error ? error.message : String(error) }
          }))
          return
        }
        if (!isLatestRequest()) {
          await window.api.destroySession(newId).catch(() => {})
          return
        }
        set({ starting: false })
        void get().refreshSessions()
        scheduleInitWatchdog(get, set, newId)
      }
    }
  },

  async switchProject(path: string) {
    cancelActiveHistoryHydration()
    const oldMeta = get().meta
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const startGate = createSessionStartGate(newId)
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)
    // #6 切走=后台化：快照当前会话进事件缓冲（事件继续累积，切回可 attach）。
    snapshotActiveSessionIntoBackground(get)
    // Flip the UI to the new project BEFORE any IPC: the main view clears and
    // enters its starting state immediately, so the click never stalls on the
    // setLastProject / getActiveProvider round-trips. Model & permission mode
    // are carried over from the current session as a transient — the session
    // init event overwrites them with the real values once the bridge is up.
    set({
      starting: true,
      items: [],
      tasks: [], pendingQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      // 2026-08-26 切项目不再清空 sessions/sessionsHasMore：清空的瞬间侧栏
      // 整列闪空 → 骨架/空态 → startSession 后 refreshSessions 再填回，表现
      // 就是"切个项目，左边目录整个收缩重载一次"。与 openSessionCrossProject
      // 同款修复（见该处注释）：旧列表留到 refreshSessions 拿新数据原地替换
      //（它连 sessionsHasMore 一起覆盖），只有真正变化的行走进出动画。
      slashCommands: [],
      planEntries: [],
      planUpdatedAt: null,
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
      // #23 授权弹窗随旧会话进了后台缓冲快照，前台清空防串会话。
      pendingPermissions: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: {
        sessionId: newId,
        ...(oldMeta?.agentBackend ? { agentBackend: oldMeta.agentBackend } : {}),
        cwd: path,
        model: oldMeta?.model ?? DEFAULT_KIMI_MODEL_ID,
        permissionMode: oldMeta?.permissionMode ?? 'default',
        tools: []
      }
    })
    // Persist last-project + read the active provider concurrently; neither
    // blocks the view switch (already done above), they only feed the spawn.
    const [, provider, prefs] = await Promise.all([
      window.api.setLastProject(path),
      window.api.getActiveProvider(),
      window.api.getPreferences().catch(() => null)
    ])
    if (!isLatestRequest()) {
      startGate.resolve()
      return
    }
    const agentBackend = prefs?.agentBackend ?? oldMeta?.agentBackend
    const model = displayModelForAgent(agentBackend, provider?.model ?? oldMeta?.model)
    set((s) => (
      s.meta?.sessionId === newId
        ? {
            meta: {
              ...s.meta,
              model,
              ...(agentBackend ? { agentBackend } : {})
            },
            sessionConfigDirty: false,
            sessionModelDirty: false,
            bridgeEnded: false
          }
        : {}
    ))
    if (oldMeta?.sessionId) void window.api.closeSession(oldMeta.sessionId).catch(() => {})
    try {
      await window.api.startSession({
        cwd: path,
        ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
        ...(agentBackend ? { agentBackend } : {}),
        effort: get().effort,
        // 新项目 = 全新会话：同样应用设置里的默认权限模式（此前漏传，chip 被
        // init 覆盖回 default）。
        permissionMode: prefs?.defaultPermissionMode ?? 'default',
        bridgeSessionId: newId
      })
      startGate.resolve()
    } catch (error: unknown) {
      startGate.reject(error)
      if (!isLatestRequest()) return
      set((s) => ({
        starting: false,
        status: {
          ...s.status,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
      return
    }
    if (!isLatestRequest()) {
      await window.api.destroySession(newId).catch(() => {})
      return
    }
    set({ starting: false })
    void get().refreshSessions()
    scheduleInitWatchdog(get, set, newId)
  },

  removePendingMessage(id) {
    set((s) => ({ pendingQueue: s.pendingQueue.filter((p) => p.id !== id) }))
  },

  takePendingMessage(id) {
    const msg = get().pendingQueue.find((p) => p.id === id) ?? null
    if (msg) set((s) => ({ pendingQueue: s.pendingQueue.filter((p) => p.id !== id) }))
    return msg
  },

  clearPendingQueue() {
    set((s) => (s.pendingQueue.length ? { pendingQueue: [] } : {}))
  },

  async resendPendingQueue() {
    const meta = get().meta
    if (!meta || get().status.running) return
    const queued = get().pendingQueue
    if (queued.length === 0) return
    set({ pendingQueue: [] })
    // 逐条重发：首条直达（sendMessage 会顺带清掉 error，bridgeEnded 时先重建
    // 会话），后续消息按原 busy 语义重新进入队列。
    for (const p of queued) {
      await get().sendMessage(
        p.text,
        p.attachments?.length ? p.attachments.map(userAttachmentToPickedFile) : undefined,
        p.cutIn ? { cutIn: true } : undefined
      )
    }
  },

  clearError() {
    set((s) => (s.status.error ? { status: { ...s.status, error: undefined } } : {}))
  },

  applySessionRunningChanged(p) {
    // 未读气泡用的「这轮真的跑过」判定：必须在本函数任何状态改动之前取样
    //（markSdkSessionRunning 与下面的列表 set 都会把 running 写成新值）。
    // 渲染层重载（刷新窗口）时 running=true 推送发生在重载前、
    // runningSdkSessionIds 是空的——sessions 列表的 running 是主进程轮询合并的，
    // 能接住这种半边生命周期。
    const wasRunning = p.acpSessionId
      ? get().runningSdkSessionIds.includes(p.acpSessionId) ||
        get().sessions.some((it) => it.sessionId === p.acpSessionId && !!it.running)
      : false
    // 后台缓冲的 running（attach 时恢复忙碌态用）+ #41 计时/提示随 turn 结束清掉。
    const bg = backgroundSessions.get(p.sessionId)
    if (bg) {
      bg.running = p.running
      if (p.running && p.startedAt) bg.startedAt = p.startedAt
      if (!p.running) {
        delete bg.startedAt
        delete bg.stall
      }
    }
    // 当前会话：turn 开始时间戳（忙碌态 mm:ss 计时）从主进程带来的为准；
    // turn 结束时清掉计时与无响应提示。running 本身以事件流为准，这里不动。
    if (get().meta?.sessionId === p.sessionId) {
      set((s) => ({
        status: {
          ...s.status,
          ...(p.running && p.startedAt ? { startedAt: p.startedAt } : {}),
          ...(!p.running ? { startedAt: undefined, stall: undefined } : {})
        }
      }))
    }
    // #5 主进程推送是最权威的 turn 起止信号：同步运行中列表（前台/后台通吃）。
    markSdkSessionRunning(p.acpSessionId, p.running)
    // 侧栏列表项的 running 标记（按 acpSessionId 匹配）。
    if (!p.acpSessionId) return
    set((s) => {
      let changed = false
      const sessions = s.sessions.map((it) => {
        if (it.sessionId !== p.acpSessionId || !!it.running === p.running) return it
        changed = true
        return { ...it, running: p.running }
      })
      return changed ? { sessions } : {}
    })
    // 未读气泡（2026-08-25）：turn 结束（running=true→false）且不是当前打开的
    // 会话 → 该行未读 +1。当前会话用户正看着，永远不计；渲染层重载后到达的
    // 孤立 running=false（wasRunning=false）不计，防启动期假未读。
    if (!p.running && wasRunning && p.acpSessionId && get().meta?.sdkSessionId !== p.acpSessionId) {
      const backend = get().sessions.find((it) => it.sessionId === p.acpSessionId)?.runtimeBackend
      get().noteReplyCompleted(unreadSessionKey(p.acpSessionId, backend))
    }
  },

  dismissTurnStall() {
    set((s) => (s.status.stall ? { status: { ...s.status, stall: undefined } } : {}))
  },

  async answerElicitation(toolUseID, optionId) {
    // elicitation：原样回传用户点选的 optionId（answers 通道），从队列移除。
    const sessionIdAtSend = get().meta?.sessionId
    const removed = get().elicitationQueue.filter((q) => q.toolUseID === toolUseID)
    set((s) => ({ elicitationQueue: s.elicitationQueue.filter((q) => q.toolUseID !== toolUseID) }))
    try {
      await window.api.respondPermission({
        toolUseID,
        behavior: 'allow',
        answers: { optionId }
      })
    } catch (error) {
      // IPC 失败（桥接忙/已关闭）时把卡片放回去：先移除是为了界面即时反馈，
      // 但不回滚的话卡片消失、agent 那一轮还在等一个用户再也给不了的回复。
      // #10 await 期间可能已切会话：A 的卡片不能回滚进 B 的队列，身份不符丢弃。
      if (removed.length && get().meta?.sessionId === sessionIdAtSend) {
        set((s) => ({ elicitationQueue: [...removed, ...s.elicitationQueue] }))
      }
      throw error
    }
  },

  async refreshSessions() {
    const meta = get().meta
    if (!meta) return
    const requestSeq = ++sessionListRequestSeq
    // #8 作废在途的 loadMore：整表即将替换，旧偏移的分页结果再并进来只会
    // 产生错位/重复行（两个序号原先互不知晓）。
    loadMoreSessionsRequestSeq += 1
    const cwd = meta.cwd
    const scope = get().sessionScope
    set({ sessionsLoading: true })
    try {
      // kimi-only：不再有 windows/wsl 之分，后端忽略 backend 参数。
      // 「全部」视图跨项目一次拉 200 条（不做分页）；「当前项目」按页加载。
      const sessions = await window.api.listSessions(cwd, {
        limit: scope === 'all' ? ALL_SESSIONS_LIMIT : SESSION_PAGE_SIZE,
        offset: 0,
        scope
      })
      if (sessionListRequestSeq !== requestSeq || get().meta?.cwd !== cwd) return
      set({
        sessions,
        sessionsHasMore: scope === 'all' ? false : sessions.length === SESSION_PAGE_SIZE
      })
    } catch (e) {
      // 所有调用点都是 `void refreshSessions()`：不吞掉异常会变成未处理
      // rejection（IPC 超时/主进程忙一次就触发）。列表静默停在旧数据即可，
      // finally 会复位 loading，不会卡转圈。
      console.warn('[sessionStore] refreshSessions failed:', e)
    } finally {
      if (sessionListRequestSeq === requestSeq) set({ sessionsLoading: false })
    }
  },

  async setSessionScope(scope) {
    if (get().sessionScope === scope) return
    set({ sessionScope: scope, sessions: [], sessionsHasMore: false })
    await get().refreshSessions()
  },

  async openSessionCrossProject(sdkSessionId, cwd, backend, targetAgentBackend) {
    const meta = get().meta
    if (!meta) return
    // 先切到该会话所属项目，再 resume（不在原项目里跨 cwd load）。
    // #42 打开会话只切换 cwd（setLastProject），绝不 addProject：项目列表只收录
    // 用户显式添加的目录，脏会话的 cwd 不会混进工作区列表。
    // #47 只换 cwd，绝不走 switchProject：它会 startSession 一个全新空壳，而
    // 随后的 openSession 只把它后台化（closeSession=background，不置 closed），
    // discardEmptyShell 在 session/new 在途时拿不到 acpSessionId 直接跳过——
    // 空壳就此落盘残留在目标项目（侧栏多出 "New Session"）。cwd 以 targetCwd
    // 参数传给 openSession 而不提前改 meta：openSession 进去第一件事就是把当前
    // 会话快照进后台缓冲，缓冲的 cwd 必须还是旧项目的，否则跨项目切回时
    // attach 的 cwd 比对永远失配、历史缓存失效键也指错目录。
    if (cwd && normalizeCwdForCompare(cwd) !== normalizeCwdForCompare(meta.cwd)) {
      await window.api.setLastProject(cwd)
      // 这里原先 set({ sessions: [] })：侧栏当场清空 → 骨架/空态 → 新列表填回，
      // 表现就是"切个会话，左边目录整个收缩重载一次"。而「全部」视图本来就是
      // 跨项目的,清掉的多半还是同一批会话。改成留着旧列表,等下面
      // refreshSessions 拿到新数据再原地替换,只有真正变了的行会走进出动画。
      await get().openSession(sdkSessionId, backend, cwd, targetAgentBackend)
    } else {
      await get().openSession(sdkSessionId, backend, undefined, targetAgentBackend)
    }
    // 侧栏列表还停在原项目：按新 cwd 重拉（openSession 仅 attach 分支会刷新）。
    void get().refreshSessions()
  },

  async loadMoreSessions() {
    const meta = get().meta
    const state = get()
    if (!meta || state.sessionsLoading || !state.sessionsHasMore) return
    const requestSeq = ++loadMoreSessionsRequestSeq
    const cwd = meta.cwd
    const offset = state.sessions.length
    set({ sessionsLoading: true })
    try {
      const page = await window.api.listSessions(cwd, {
        limit: SESSION_PAGE_SIZE,
        offset
      })
      if (loadMoreSessionsRequestSeq !== requestSeq || get().meta?.cwd !== cwd) return
      set((s) => {
        const seen = new Set(s.sessions.map((session) => session.sessionId))
        const next = page.filter((session) => !seen.has(session.sessionId))
        return {
          sessions: [...s.sessions, ...next],
          sessionsHasMore: page.length === SESSION_PAGE_SIZE
        }
      })
    } catch (e) {
      // 同 refreshSessions：调用点多为 `void`，吞掉异常避免未处理 rejection。
      console.warn('[sessionStore] loadMoreSessions failed:', e)
    } finally {
      if (loadMoreSessionsRequestSeq === requestSeq) set({ sessionsLoading: false })
    }
  },

  async prefetchSessionHistory(sdkSessionId: string, backend?: ClaudeExecutionBackend) {
    const meta = get().meta
    if (!meta || meta.sdkSessionId === sdkSessionId) return
    await loadSessionHistory(meta.cwd, sdkSessionId, backend)
  },

  pruneSessionHistoryCache(visibleSessionIds: string[]) {
    const meta = get().meta
    if (!meta) return
    const retained = new Set(visibleSessionIds)
    if (meta.sdkSessionId) retained.add(meta.sdkSessionId)
    pruneSessionHistoryCacheForCwd(meta.cwd, retained)
  },

  setTranscriptScrolling(scrolling: boolean) {
    transcriptScrolling = scrolling
    if (!scrolling && activeHistoryHydrationTask) {
      scheduleHistoryHydrationStep(get, set, activeHistoryHydrationTask)
    }
  },

  setHistoryPreloadZone(zone: HistoryPreloadZone) {
    if (historyPreloadZone === zone) return
    historyPreloadZone = zone
    // 解除暂停（离开阅读区）时立刻续注，不等下一颗轮询定时器。
    if (zone !== 'mid' && activeHistoryHydrationTask) {
      scheduleHistoryHydrationStep(get, set, activeHistoryHydrationTask)
    }
  },

  async newChat() {
    const meta = get().meta
    if (!meta) return
    cancelActiveHistoryHydration()
    const { cwd, model, agentBackend } = meta
    const oldSessionId = meta.sessionId
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)
    // 根因修复：此前 newChat 沿用旧会话的 permissionMode 做乐观值、且不传给
    // 后端（opts 里根本没有 permissionMode），ACP 侧停留在 CLI default，init
    // 事件随后把 chip 覆盖回 default —— 设置里的默认权限模式就此丢失。
    // 全新会话应用设置里的默认档；resume 历史会话仍走原模式（见 openSession）。
    //
    // #4 取偏好的 await 必须在快照**之前**：快照与下面清空 items 的 set 若隔着
    // await，窗口期到达的流式内容既不在快照里、又被清空——永久丢失（对齐
    // switchProject 的写法：快照紧贴同步 set）。
    const prefs = await window.api.getPreferences().catch(() => null)
    const permissionMode = prefs?.defaultPermissionMode ?? 'default'
    // 此刻 meta 还指向旧会话，只能校验导航序号（isLatestRequest 要等下面的
    // set 把新 meta 放好才有意义——原先在这儿调它必假，newChat 恒空转）。
    if (sessionNavigationSeq !== requestSeq) return
    // #6 切走=后台化：快照当前会话进事件缓冲（turn 继续跑，切回可 attach）。
    // 快照与清空 set 之间保持同步（无 await）。
    snapshotActiveSessionIntoBackground(get)
    // 界面立刻切到空会话；后端不起（见 pendingSessionStart）。
    // starting 保持 false：没有任何东西在启动，不该显示"正在进入会话"骨架。
    // slashCommands / mcpServers 故意不清空：它们是 agent 级的、跟具体会话
    // 无关，清掉的话新会话在发出第一条消息之前 "/" 菜单是空的。
    set({
      starting: false,
      items: [],
      tasks: [], pendingQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      planEntries: [],
      planUpdatedAt: null,
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
      // #23 授权弹窗随旧会话进了后台缓冲快照，前台清空防串会话。
      pendingPermissions: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: {
        sessionId: newId,
        ...(agentBackend ? { agentBackend } : {}),
        cwd,
        model,
        permissionMode,
        tools: []
      }
    })
    void window.api.closeSession(oldSessionId).catch(() => {})
    // 后端推迟到第一条消息：send() 会先取走这个任务跑完，再走原本的
    // sessionStartPromises 等待。gate 也在这里面才创建——若这个会话最终没
    // 被使用，就不会在 sessionStartPromises 里留下一个永不落定的 promise。
    pendingSessionStart = {
      sessionId: newId,
      start: async () => {
        const startGate = createSessionStartGate(newId)
        try {
          await window.api.startSession({
            cwd,
            ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
            ...(agentBackend ? { agentBackend } : {}),
            effort: get().effort,
            permissionMode,
            bridgeSessionId: newId
          })
          startGate.resolve()
        } catch (error: unknown) {
          startGate.reject(error)
          if (!isLatestRequest()) return
          set((s) => ({
            starting: false,
            status: {
              ...s.status,
              error: error instanceof Error ? error.message : String(error)
            }
          }))
          return
        }
        if (!isLatestRequest()) {
          await window.api.destroySession(newId).catch(() => {})
          return
        }
        set({ starting: false })
        void get().refreshSessions()
        scheduleInitWatchdog(get, set, newId)
      }
    }
  },

  async openSession(
    sdkSessionId: string,
    backend?: ClaudeExecutionBackend,
    targetCwd?: string,
    targetAgentBackend?: AgentBackendId
  ) {
    const meta = get().meta
    if (!meta) return
    if (meta.sdkSessionId === sdkSessionId) return
    // 打开即已读：attach / resume 两条分支共用这一个入口（2026-08-25 未读气泡）。
    get().clearUnread(unreadSessionKey(sdkSessionId, backend))
    cancelActiveHistoryHydration()
    const { model, permissionMode } = meta
    // 会话归哪个 agent 后端由**这条会话**决定，不是当前会话、更不是全局偏好：
    // 侧栏现在同时列 kimi 与 Claude Code 的历史，拿当前会话的后端去 resume
    // 另一个后端的会话必然失败（#71）。
    const agentBackend = targetAgentBackend ?? meta.agentBackend
    // #47 跨项目打开时目标 cwd 由 openSessionCrossProject 以参数传入：meta.cwd
    // 保持旧项目直到快照完成（后台缓冲的 cwd 用于切回 attach 比对与缓存失效）。
    const cwd = targetCwd ?? meta.cwd
    // resume 不会带回会话模式（init 恒报 default）：优先用本地记住的该会话
    // 模式，其次沿用当前会话的模式，并在 startSession 时显式下发。
    const restoredMode: PermissionMode = readStoredPermissionMode(sdkSessionId) ?? (permissionMode as PermissionMode)
    const oldSessionId = meta.sessionId

    // #6 后台会话 attach：目标会话切走时后端未被 cancel，事件已累积进它自己的
    // 缓冲——直接接管其桥接 id 和缓冲内容继续渲染，不走 session/load 全量重放
    // （重放会重复，且空壳已被磁盘删除时 load 直接失败）。
    const bg = findLiveBackgroundSession(sdkSessionId)
    if (bg && normalizeCwdForCompare(bg.cwd) === normalizeCwdForCompare(cwd)) {
      // #1/#6 先冲刷（nextSessionNavigationSeq 内部会冲 streamBatcher 的前台
      // pending 与后台聚合队列），**再**把目标缓冲摘出 Map：顺序反了的话，
      // 该会话仍在聚合队列里的 delta 会因缓冲已摘除而路由落空、内容丢失。
      nextSessionNavigationSeq()
      backgroundSessions.delete(bg.bridgeSessionId)
      snapshotActiveSessionIntoBackground(get)
      void window.api.closeSession(oldSessionId).catch(() => {})
      // 桥接早已就绪：sendMessage 的启动门闩直接放行。
      createSessionStartGate(bg.bridgeSessionId).resolve()
      // #23 swarmTasks 交接给 App 的订阅 effect（防它的切会话清空抹掉恢复值）。
      attachedSwarmTasks = { sdkSessionId, tasks: bg.swarmTasks }
      set({
        starting: false,
        // #6 后台期间 delta 是原地折叠的（条目/块对象被 mutate，数组引用可能
        // 没变）：整体克隆一份再入 store，保证 memo 化的行组件拿到新引用。
        items: cloneTranscriptItems(bg.items),
        tasks: bg.tasks,
        // 队列恢复：#29 回收的未送达消息在前，切走时带走的排队镜像在后。
        pendingQueue: [...(bg.recycledQueue ?? []), ...(bg.queuedMirror ?? [])],
        sessionConfigDirty: false,
        sessionModelDirty: false,
        bridgeEnded: false,
        planEntries: bg.planEntries,
        // #23 待办陈旧度时钟与待授权弹窗一并恢复（快照链路见
        // snapshotActiveSessionIntoBackground）。
        planUpdatedAt: bg.planUpdatedAt,
        pendingPermissions: bg.pendingPermissions,
        contextUsage: bg.contextUsage,
        mcpServers: bg.mcpServers,
        modePanel: bg.modePanel,
        goal: bg.goal,
        elicitationQueue: bg.elicitationQueue,
        slashCommands: bg.slashCommands,
        swarmTasks: bg.swarmTasks,
        status: {
          running: bg.running,
          ...(bg.startedAt ? { startedAt: bg.startedAt } : {}),
          ...(bg.stall ? { stall: bg.stall } : {}),
          ...(bg.error ? { error: bg.error } : {})
        },
        currentStreamingMsgId: bg.currentStreamingMsgId,
        meta: {
          sessionId: bg.bridgeSessionId,
          ...(agentBackend ? { agentBackend } : {}),
          sdkSessionId,
          cwd,
          model: bg.model || model,
          permissionMode: readStoredPermissionMode(sdkSessionId) ?? bg.permissionMode ?? restoredMode,
          tools: bg.tools
        }
      })
      void get().refreshSessions()
      return
    }

    // #6 切走=后台化：快照当前会话进事件缓冲（turn 继续跑，切回可 attach）。
    snapshotActiveSessionIntoBackground(get)
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const startGate = createSessionStartGate(newId)
    const targetBackend: ClaudeExecutionBackend = backend ?? 'windows'
    const cachedItems = getCachedSessionHistory(cwd, sdkSessionId, targetBackend)
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)

    // Switch the selected session immediately; history and bridge resume happen
    // below and stale requests are ignored if the user clicks another session.
    set({
      starting: true,
      items: cachedItems ? visibleHistoryTail(cachedItems) : [],
      tasks: [], pendingQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      slashCommands: [],
      planEntries: [],
      planUpdatedAt: null,
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
      // #23 授权弹窗随旧会话进了后台缓冲快照，前台清空防串会话。
      pendingPermissions: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: {
        sessionId: newId,
        ...(agentBackend ? { agentBackend } : {}),
        sdkSessionId,
        cwd,
        model,
        permissionMode: restoredMode,
        tools: []
      }
    })

    const historyPromise = cachedItems
      ? Promise.resolve(cachedItems)
      : loadSessionHistory(cwd, sdkSessionId, targetBackend)

    if (cachedItems) {
      startProgressiveSessionHistory(get, set, newId, cachedItems)
    }

    const runtimePromise = (async (): Promise<{ model: string; canStart: boolean; error?: string }> => {
      const prefs = await window.api.getPreferences().catch(() => null)
      const currentBackend: ClaudeExecutionBackend =
        prefs?.claudeExecutionBackend === 'wsl' ? 'wsl' : 'windows'
      if (targetBackend === 'wsl' && !prefs?.wslSupportEnabled) {
        return {
          model,
          canStart: false,
          error: 'WSL support is disabled. Enable WSL support in Settings first.'
        }
      }
      if (targetBackend !== currentBackend) {
        await window.api.savePreferences({ claudeExecutionBackend: targetBackend })
        emitForgeEvent('providerChanged')
        emitForgeEvent('modelOptionsChanged')
      }
      const provider = await window.api.getActiveProvider().catch(() => null)
      return { model: provider?.model ?? model, canStart: true }
    })()

    const startPromise = (async (): Promise<{ started: boolean; error?: unknown }> => {
      try {
        void window.api.closeSession(oldSessionId).catch(() => {})
        const runtime = await runtimePromise
        if (!isLatestRequest()) {
          startGate.resolve()
          return { started: false }
        }
        if (!runtime.canStart) {
          startGate.reject(runtime.error)
          return { started: false, error: runtime.error }
        }
        set((s) => (
          isLatestRequest()
            ? {
                meta: {
                  ...s.meta!,
                  model: runtime.model
                }
              }
            : {}
        ))
        await window.api.startSession({
          cwd,
          ...(modelForAgent(agentBackend, runtime.model) ? { model: modelForAgent(agentBackend, runtime.model) } : {}),
          ...(agentBackend ? { agentBackend } : {}),
          effort: get().effort,
          permissionMode: restoredMode,
          resume: sdkSessionId,
          bridgeSessionId: newId
        })
        startGate.resolve()
        return { started: true }
      } catch (error: unknown) {
        startGate.reject(error)
        return { started: false, error }
      }
    })()

    void historyPromise
      .then((items) => {
        if (!cachedItems && isLatestRequest()) startProgressiveSessionHistory(get, set, newId, items)
      })
      .catch(() => {})

    const startResult = await startPromise
    if (!isLatestRequest()) {
      if (startResult.started) await window.api.destroySession(newId).catch(() => {})
      return
    }
    if (startResult.error) {
      const e = startResult.error
      startGate.reject(e)
      if (!isLatestRequest()) return
      // #47 resume 未命中（attach 失败/session-load 失败等）**不新建空壳**：
      // 显示错误、停留在已加载的历史只读视图。标记 bridgeEnded，让下一次
      // sendMessage 走重建路径带 resume 重试，而不是把消息发进不存在的桥接。
      set((s) => ({
        starting: false,
        bridgeEnded: true,
        status: {
          ...s.status,
          running: false,
          error: e instanceof Error ? e.message : String(e)
        }
      }))
      return
    }
    set({ starting: false })

    scheduleInitWatchdog(get, set, newId)
  },

  /** Close the current session and re-spawn it (resuming when possible) so that
   *  config-file changes — e.g. MCP servers — get reloaded. History is restored
   *  from the transcript JSONL, so the conversation is preserved. */
  async renameSession(sessionId: string, title: string, backend?: ClaudeExecutionBackend) {
    const meta = get().meta
    if (!meta) return
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      await window.api.renameSession(sessionId, trimmed, meta.cwd, backend)
    } catch {
      /* ignore — the list will still show the old summary */
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.sessionId === sessionId ? { ...x, summary: trimmed } : x
      )
    }))
  },

  async deleteSession(sessionId: string, backend?: ClaudeExecutionBackend) {
    const meta = get().meta
    if (!meta) return null
    // 销毁仍活着的后端会话（后台缓冲的 / 当前活跃的）：否则 turn 继续在后台烧。
    const bg = takeBackgroundSession(sessionId)
    if (bg) void window.api.destroySession(bg.bridgeSessionId).catch(() => {})
    if (meta.sdkSessionId === sessionId) {
      void window.api.destroySession(meta.sessionId).catch(() => {})
      // 桥接已销毁：标记 bridgeEnded，避免随后的 newChat 把死会话快照进后台缓冲。
      set({ bridgeEnded: true })
    }
    // #5 会话销毁：移出运行中列表。
    markSdkSessionRunning(sessionId, false)
    try {
      const result = await window.api.deleteSession(sessionId, meta.cwd, backend)
      // 主进程校验失败（路径穿越防护等）：不删列表项，提示错误。
      if (result && result.ok === false) {
        const message = result.error ?? '删除会话失败'
        set((s) => ({ status: { ...s.status, error: message } }))
        return message
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((s) => ({ status: { ...s.status, error: message } }))
      return message
    }
    deleteSessionHistoryCache(meta.cwd, sessionId, backend)
    forgetSessionLocalState(sessionId)
    get().setComposerDraft(sessionId, '')
    // 未读计数同样按会话清（同 forgetSessionLocalState 的死键理由，2026-08-25）。
    get().clearUnread(unreadSessionKey(sessionId, backend))
    set((s) => ({ sessions: s.sessions.filter((x) => x.sessionId !== sessionId) }))
    // Deleted the active conversation → start fresh.
    if (meta.sdkSessionId === sessionId) {
      await get().newChat()
    }
    void get().refreshSessions()
    return null
  },

  async deleteSessions(targets) {
    const meta = get().meta
    if (!meta || targets.length === 0) return { deleted: 0, failed: 0 }
    let deleted = 0
    let failed = 0
    const deletedIds = new Set<string>()
    // 串行逐个删：单个失败只计数、不中断整批。
    for (const target of targets) {
      // 销毁仍活着的后端会话（后台缓冲的 / 当前活跃的），否则 turn 继续烧。
      const bg = takeBackgroundSession(target.sessionId)
      if (bg) void window.api.destroySession(bg.bridgeSessionId).catch(() => {})
      if (meta.sdkSessionId === target.sessionId) {
        void window.api.destroySession(meta.sessionId).catch(() => {})
        // 桥接已销毁：标记 bridgeEnded，避免随后的 newChat 把死会话快照进后台缓冲。
        set({ bridgeEnded: true })
      }
      // #5 会话销毁：移出运行中列表。
      markSdkSessionRunning(target.sessionId, false)
      try {
        const result = await window.api.deleteSession(target.sessionId, meta.cwd, target.backend)
        if (result && result.ok === false) {
          failed += 1
          continue
        }
        deleted += 1
        deletedIds.add(target.sessionId)
        deleteSessionHistoryCache(meta.cwd, target.sessionId, target.backend)
        forgetSessionLocalState(target.sessionId)
        get().setComposerDraft(target.sessionId, '')
        // 同单删：未读计数按会话清，防死键滞留（2026-08-25）。
        get().clearUnread(unreadSessionKey(target.sessionId, target.backend))
      } catch {
        failed += 1
      }
    }
    if (deletedIds.size > 0) {
      set((s) => ({ sessions: s.sessions.filter((x) => !deletedIds.has(x.sessionId)) }))
      if (meta.sdkSessionId && deletedIds.has(meta.sdkSessionId)) {
        await get().newChat()
      }
      void get().refreshSessions()
    }
    if (failed > 0) {
      set((s) => ({
        status: { ...s.status, error: `批量删除完成：成功 ${deleted} 个，失败 ${failed} 个` }
      }))
    }
    return { deleted, failed }
  },

  async backgroundTask(taskId: string) {
    const meta = get().meta
    const task = get().tasks.find((t) => t.taskId === taskId)
    if (!meta || !task) return
    // Optimistically mark backgrounded so the UI flips immediately.
    set((s) => ({
      tasks: s.tasks.map((t) => (t.taskId === taskId ? { ...t, isBackgrounded: true } : t))
    }))
    try {
      await window.api.backgroundTask(meta.sessionId, task.toolUseId)
    } catch {
      /* leave optimistic; status will be corrected by task_updated */
    }
  },

  async restartSession() {
    const meta = get().meta
    if (!meta) return
    cancelActiveHistoryHydration()
    const { cwd, model, permissionMode, sdkSessionId, agentBackend } = meta
    const effort = get().effort
    const oldSessionId = meta.sessionId
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const startGate = createSessionStartGate(newId)
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)
    set({
      starting: true,
      status: { running: false },
      currentStreamingMsgId: null,
      items: sdkSessionId ? get().items : [],
      tasks: [],
      pendingQueue: [],
      // 旧桥接即将销毁：它挂着的授权弹窗/提问卡的 toolUseID 已死，回应无处
      // 可去，留着只会永远等不到结果。
      pendingPermissions: [],
      elicitationQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      meta: {
        sessionId: newId,
        ...(agentBackend ? { agentBackend } : {}),
        sdkSessionId,
        cwd,
        model,
        permissionMode,
        tools: []
      }
    })
    // Rebuild the transcript from history so the resumed session shows the same
    // conversation. If we never got an sdkSessionId (init hadn't landed), fall
    // back to a fresh session.
    if (sdkSessionId) {
      void loadSessionHistory(cwd, sdkSessionId)
        .then((items) => {
          if (isLatestRequest()) startProgressiveSessionHistory(get, set, newId, items)
        })
        .catch(() => {})
    }
    // 旧桥接被同 sdkSessionId 的 resume 取代：显式销毁（closeSession 的后台化
    // 语义会让两个桥接共享同一 acpSessionId，事件路由互相覆盖）。
    void window.api.destroySession(oldSessionId).catch(() => {})
    try {
      await window.api.startSession(
        sdkSessionId
          ? {
              cwd,
              ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
              ...(agentBackend ? { agentBackend } : {}),
              effort,
              permissionMode: permissionMode as PermissionMode,
              resume: sdkSessionId,
              bridgeSessionId: newId
            }
          : {
              cwd,
              ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
              ...(agentBackend ? { agentBackend } : {}),
              effort,
              permissionMode: permissionMode as PermissionMode,
              bridgeSessionId: newId
            }
      )
      startGate.resolve()
    } catch (error: unknown) {
      startGate.reject(error)
      if (!isLatestRequest()) return
      set((s) => ({
        starting: false,
        status: {
          ...s.status,
          error: error instanceof Error ? error.message : String(error)
        }
      }))
      return
    }
    if (!isLatestRequest()) {
      await window.api.destroySession(newId).catch(() => {})
      return
    }
    set({ starting: false })
    scheduleInitWatchdog(get, set, newId)
  },

  async setEffort(effort) {
    if (get().effort === effort) return
    set((s) => ({ effort, sessionConfigDirty: s.meta ? true : s.sessionConfigDirty }))
  },

  async switchProvider(id) {
    await window.api.setActiveProvider(id)
    // Keep meta.model in sync with the newly-active provider so the resumed
    // session spawns with that model (the bridge trusts opts.model).
    const provider = await window.api.getActiveProvider()
    const meta = get().meta
    if (meta && provider) set({ meta: { ...meta, model: provider.model } })
    await get().restartSession()
  },

  async reloadForBackendSwitch() {
    sessionHistoryCache.clear()
    const meta = get().meta
    set({ sessions: [], sessionsHasMore: false })
    if (!meta) return
    await get().switchProject(meta.cwd)
  },

  ingestAgentEvent(e) {
    // #6 非当前会话 = 后台会话：事件分流到各自的缓冲（运行标记实时、内容连续），
    // 不再整条丢弃。
    if (get().meta?.sessionId !== e.sessionId) {
      foldBackgroundAgentEvent(get, e)
      return
    }

    if (e.type === 'agent:ended') {
      const endedError = isUserStopDiagnostic(e.error) ? undefined : e.error
      // #5 会话关闭：移出运行中列表。
      markSdkSessionRunning(get().meta?.sdkSessionId, false)
      // 桥接死在流式中途（进程崩溃/被杀）不会再有 result 事件来收尾：先把
      // 积压 delta 冲进 items，再走与 result 相同的封口。不封的话流式光标
      // 永远闪、悬挂的工具卡永远转圈。
      flushPendingStreamDeltas()
      // #29 台账终局结算：ended 之后这个 bridge id 不会再有任何 result，
      // 台账必须清（否则死条目永久滞留）。异常收场（崩溃/被杀）把未确认
      // 消息回收进 pendingQueue（走 #20 重发/清空出路）；用户主动停止/正常
      // 收场只出账不回收。
      const recycled = takeUnackedDirectMessages(e.sessionId)
      const shouldRequeue = endedError !== undefined && recycled.length > 0
      set((s) => ({
        bridgeEnded: true,
        items: sealHungToolBlocks(
          s.items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i)),
          true
        ),
        currentStreamingMsgId: null,
        ...(shouldRequeue
          ? {
              pendingQueue: [
                ...recycled.map((m) => ({
                  id: uid(),
                  text: m.text,
                  ...(m.attachments ? { attachments: m.attachments } : {}),
                  ...(m.swarm ? { swarm: true } : {}),
                  ...(m.cutIn ? { cutIn: true } : {})
                })),
                ...s.pendingQueue
              ]
            }
          : {}),
        status: { ...s.status, running: false, startedAt: undefined, stall: undefined, error: endedError ?? s.status.error }
      }))
      scheduleSessionsRefresh(get)
      return
    }
    const msg = e.message as Record<string, unknown> & { type: string }
    switch (msg.type) {
      case 'system': {
        const subtype = msg.subtype as string
        if (subtype === 'init') {
          const m = msg as unknown as {
            session_id: string
            cwd: string
            model: string
            permissionMode: string
            tools: string[]
          }
          set((s) => ({
            starting: false,
            meta: {
              // CRITICAL: keep the bridge handle id for IPC — never adopt the SDK's
              // internal session_id here, or subsequent sendMessage calls target a
              // session the bridge doesn't know about.
              sessionId: s.meta?.sessionId ?? m.session_id,
              ...(s.meta?.agentBackend ? { agentBackend: s.meta.agentBackend } : {}),
              sdkSessionId: m.session_id,
              cwd: m.cwd,
              model: (s.sessionConfigDirty || s.sessionModelDirty) ? (s.meta?.model ?? m.model) : m.model,
              permissionMode: m.permissionMode,
              tools: m.tools
            },
            sessionModelDirty: false,
            bridgeEnded: false,
            // 新会话/恢复会话时清空上一会话残留的待办清单。原先只等新 plan
            // 事件重建——而 plan 事件要等模型下一次动待办才来，中间这段时间
            // 面板一直是空的。现在紧接着补拉一次真值（见下面的 refreshTodos）。
            planEntries: [],
            planUpdatedAt: null,
            contextUsage: null,
            mcpServers: null,
            modePanel: defaultModePanel(),
            goal: null,
            elicitationQueue: [],
            // compacting 不随会话切换残留：压缩状态由 live 事件重新点亮
            //（2026-08-18 前 resume 会带着上一会话的「正在压缩」卡死）。
            status: { ...s.status, compacting: false }
          }))
          // 会话刚 load 完，立刻补拉待办真值（零 token，失败静默）。
          void get().refreshTodos()
        } else if (subtype === 'status') {
          const status = (msg as unknown as { status: string | null }).status
          set((s) => ({ status: { ...s.status, compacting: status === 'compacting' } }))
        } else if (subtype === 'slash_commands') {
          const c = (msg as unknown as { commands?: SkillInfo[] }).commands
          set({ slashCommands: Array.isArray(c) ? c : [] })
        } else if (subtype === 'plan') {
          // ACP plan：kimi 全量推送待办清单，直接整体替换（实时更新）。
          const entries = (msg as unknown as { entries?: PlanEntry[] }).entries
          set({ planEntries: Array.isArray(entries) ? entries : [], planUpdatedAt: Date.now() })
        } else if (subtype === 'steered_turn') {
          // kimi 自发唤醒轮（后台任务/子代理完成 steer，无客户端 prompt）。
          // status.running 平时"以事件流为准"（sendMessage/result 驱动），
          // steered 轮两头都没有那两个事件，只能靠这条专用消息点亮/收尾。
          const m = msg as unknown as { running?: boolean; startedAt?: number }
          if (m.running === true) {
            set((s) =>
              s.status.running
                ? {}
                : { status: { ...s.status, running: true, startedAt: m.startedAt ?? Date.now(), error: undefined } }
            )
          } else {
            // 收尾对齐 result 分支的兜底：清流式态 + 封悬挂工具块。队列不动
            //（pendingQueue 属于真实 prompt 生命周期,由 result 分支管理）。
            set((s) => ({
              status: { ...s.status, running: s.pendingQueue.length > 0, startedAt: undefined, stall: undefined },
              items: sealHungToolBlocks(
                s.items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i)),
                true
              ),
              currentStreamingMsgId: null
            }))
            // steered 轮很可能动了待办/产出了结果：补拉一次真值（零 token）。
            void get().refreshTodos()
          }
        } else if (subtype === 'context_usage') {
          // 隐藏 /usage 轮解析出的上下文用量（UsageRings 第三环）。
          const usage = (msg as unknown as { contextUsage?: ContextUsage }).contextUsage
          set({ contextUsage: usage ? { ...usage, at: Date.now() } : null })
        } else if (subtype === 'mcp_servers') {
          // 隐藏 /mcp 轮解析出的 server 状态（McpStatusBar 状态区）。
          const servers = (msg as unknown as { servers?: McpServerEntry[] }).servers
          set({ mcpServers: Array.isArray(servers) ? servers : [] })
        } else if (subtype === 'query_result') {
          // 查询类斜杠命令（/usage、/status、/mcp）：结果落成状态卡 item，
          // 不以普通对话流形式出现（#15）。
          const q = (msg as unknown as { query?: { command?: string; text?: string; at?: number } }).query
          if (q) {
            set((s) => ({
              items: [
                ...s.items,
                {
                  id: uid(),
                  kind: 'query' as const,
                  parentToolUseId: null,
                  command: q.command ?? '/status',
                  text: q.text ?? '',
                  at: q.at ?? Date.now()
                }
              ]
            }))
          }
        } else if (subtype === 'goal') {
          // goal 循环状态推送（GoalCard 进度 / ModePanel 开关激活态）。
          const g = (msg as unknown as { goal?: GoalInfo | null }).goal
          set({ goal: g ?? null })
        } else if (subtype === 'turn_stall') {
          // #41 疑似无响应：静默超阈值（含已运行/静默时长）；recovered 撤掉提示。
          const stall = (msg as unknown as {
            stall?: { recovered?: boolean; elapsedMs?: number; silentMs?: number; at?: number }
          }).stall
          set((s) => ({
            status: {
              ...s.status,
              stall:
                stall && !stall.recovered
                  ? {
                      elapsedMs: stall.elapsedMs ?? 0,
                      silentMs: stall.silentMs ?? 0,
                      at: stall.at ?? Date.now()
                    }
                  : undefined
            }
          }))
        } else if (subtype === 'elicitation') {
          // AskUserQuestion：问题卡片入队（多问题 q0/q1… 顺序逐条处理）。
          const req = (msg as unknown as { elicitation?: ElicitationRequest }).elicitation
          if (req?.toolUseID) {
            set((s) => ({
              elicitationQueue: s.elicitationQueue.some((q) => q.toolUseID === req.toolUseID)
                ? s.elicitationQueue
                : [...s.elicitationQueue, req]
            }))
          }
        } else if (subtype === 'compaction') {
          // 压缩完成分界线：main 从 wire.jsonl 的 full_compaction.complete 推送
          // （宿主压缩全程零 ACP 文本输出，2026-08-20 wire 实证），摘要正文来自
          // apply_compaction。不再按文本标记过滤流式条目——那会把引用了标记
          // 文本的正常回复整条误删（同日实证）。
          const c = (msg as unknown as { compaction?: { summary?: string; at?: number } }).compaction
          if (c) {
            set((s) => ({
              items: [
                ...s.items,
                {
                  id: uid(),
                  kind: 'compaction' as const,
                  parentToolUseId: null,
                  ...(c.summary ? { summary: c.summary } : {}),
                  at: c.at ?? Date.now()
                }
              ],
              status: { ...s.status, compacting: false }
            }))
          }
        } else if (subtype === 'history') {
          // session/load 重放的历史：整批转换成 items 前置拼接（不走流式管道，
          // 避免"逐字打出历史"）；与现有内容按 id 去重（重放期间发的消息保留在后）。
          const msgs = (msg as unknown as { messages?: HistoryMessage[] }).messages
          if (Array.isArray(msgs) && msgs.length) {
            const historyItems = historyToItems(msgs).map((it) => ({ ...it, isHistory: true }))
            set((s) => {
              const existing = new Set(s.items.map((i) => i.id))
              const fresh = historyItems.filter((i) => !existing.has(i.id))
              // 压缩分界线去重：live 条与 wire 历史条的对账键是摘要正文（id/时间
              // 都对不上：live id=uid()、at=complete；历史 id=w*-compaction、
              // at=begin）。留历史那条（位置正确），丢 live 那条。
              const historySummaries = new Set(
                fresh.flatMap((i) => (i.kind === 'compaction' && i.summary ? [i.summary] : []))
              )
              return {
                items: [
                  ...fresh,
                  ...s.items.filter(
                    (i) => !(i.kind === 'compaction' && i.summary && historySummaries.has(i.summary))
                  )
                ]
              }
            })
          }
        } else if (subtype === 'permission_denied') {
          const d = msg as unknown as { tool_use_id: string; message: string }
          set((s) => ({
            items: mapTool(s.items, d.tool_use_id, (b) => ({
              ...b,
              status: 'denied',
              errorMessage: d.message,
              endedAt: Date.now()
            }))
          }))
        } else if (subtype === 'task_started') {
          const t = msg as unknown as {
            task_id: string
            tool_use_id?: string
            description: string
            subagent_type?: string
          }
          set((s) => {
            // Was this launched directly in the background (run_in_background:true)?
            const isBackgrounded = launchedInBackground(s.items, t.tool_use_id)
            const task: SubagentTask = {
              taskId: t.task_id,
              description: t.description,
              subagentType: t.subagent_type,
              toolUseId: t.tool_use_id,
              status: 'running',
              isBackgrounded
            }
            return {
              tasks: s.tasks.some((x) => x.taskId === t.task_id)
                ? s.tasks.map((x) => (x.taskId === t.task_id ? { ...x, ...task } : x))
                : [...s.tasks, task]
            }
          })
        } else if (subtype === 'task_progress') {
          const t = msg as unknown as {
            task_id: string
            description?: string
            subagent_type?: string
            usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
            last_tool_name?: string
            summary?: string
          }
          set((s) => ({
            tasks: s.tasks.map((x) =>
              x.taskId === t.task_id
                ? {
                    ...x,
                    description: t.description ?? x.description,
                    subagentType: t.subagent_type ?? x.subagentType,
                    tokens: t.usage?.total_tokens ?? x.tokens,
                    toolUses: t.usage?.tool_uses ?? x.toolUses,
                    durationMs: t.usage?.duration_ms ?? x.durationMs,
                    lastToolName: t.last_tool_name ?? x.lastToolName,
                    summary: t.summary ?? x.summary
                  }
                : x
            )
          }))
        } else if (subtype === 'task_updated') {
          const t = msg as unknown as {
            task_id: string
            patch: { status?: string; description?: string; error?: string; is_backgrounded?: boolean }
          }
          const mappedStatus: SubagentStatus | undefined = t.patch.status
            ? t.patch.status === 'completed' || t.patch.status === 'failed'
              ? t.patch.status
              : t.patch.status === 'killed'
                ? 'stopped'
                : undefined
            : undefined
          set((s) => ({
            tasks: s.tasks.map((x) =>
              x.taskId === t.task_id
                ? {
                    ...x,
                    description: t.patch.description ?? x.description,
                    error: t.patch.error ?? x.error,
                    status: mappedStatus ?? x.status,
                    isBackgrounded: t.patch.is_backgrounded ?? x.isBackgrounded
                  }
                : x
            )
          }))
        } else if (subtype === 'task_notification') {
          const t = msg as unknown as {
            task_id: string
            status: 'completed' | 'failed' | 'stopped'
            summary?: string
            usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
          }
          set((s) => ({
            tasks: s.tasks.map((x) =>
              x.taskId === t.task_id
                ? {
                    ...x,
                    status: t.status,
                    summary: t.summary ?? x.summary,
                    tokens: t.usage?.total_tokens ?? x.tokens,
                    toolUses: t.usage?.tool_uses ?? x.toolUses,
                    durationMs: t.usage?.duration_ms ?? x.durationMs
                  }
                : x
            )
          }))
        }
        break
      }
      case 'user': {
        const parent = (msg.parent_tool_use_id as string | null) ?? null
        const content = (msg as unknown as { message: { content: unknown } }).message.content
        if (typeof content === 'string') {
          if (isModelSwitchControlOutput(content)) {
            set((s) => ({ status: { ...s.status, running: false } }))
            break
          }
          // De-dupe: sendMessage already renders the user's text optimistically, so
          // if the SDK echoes our own message back, don't add it a second time.
          // #9 回显与乐观条目之间可能插了 query_result/流式回复等：向后扫窗口
          // 内最近一条用户消息比对，而不是只看末项。
          set((s) => {
            if (hasRecentOwnMessageEcho(s.items, content)) {
              // #29：agent 回显 = 已收到本条，按内容出台账（FIFO）。
              ackUnackedDirectMessage(e.sessionId, content)
              return { status: { ...s.status, running: true } }
            }
            return {
              items: [
                ...s.items,
                { id: uid(), kind: 'user', text: content, parentToolUseId: parent }
              ],
              status: { ...s.status, running: true }
            }
          })
          // 后台任务完成通知信封：补登对应工具块终态（后台命令面板纠错）。
          if (content.trimStart().startsWith('<notification')) {
            set((s) => ({ items: applyTaskTerminalEnvelope(s.items, content) }))
          }
          // #5 turn 进行中（无论回显还是他端注入的用户消息）。
          markSdkSessionRunning(get().meta?.sdkSessionId, true)
        } else if (Array.isArray(content)) {
          const toolResults = content.filter(
            (c): c is { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean; partial?: boolean } =>
              !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
          )
          if (toolResults.length) {
            set((s) => {
              let items = s.items
              for (const tr of toolResults) {
                items = mapTool(items, tr.tool_use_id, (b) => ({
                  ...b,
                  // partial=true 是执行中的流式内容（子代理输出等）：只更新内容。
                  status: tr.partial ? 'running' : tr.is_error ? 'error' : 'done',
                  result: tr.content,
                  resultIsError: tr.partial ? b.resultIsError : !!tr.is_error,
                  // 终态打戳（任务面板耗时）；partial 中间态不打。
                  ...(tr.partial ? {} : { endedAt: Date.now() }),
                  // rawInput 补丁（后台任务标记 run_in_background 在中间态才到）：
                  // 合并进 block.input，不覆盖已有键值以外的字段。
                  ...((tr as { input?: unknown }).input && typeof (tr as { input?: unknown }).input === 'object'
                    ? {
                        input: {
                          ...((b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>),
                          ...((tr as { input?: Record<string, unknown> }).input ?? {})
                        }
                      }
                    : {})
                }))
              }
              return { items }
            })
          } else {
            const text = content
              .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
              .join('')
            if (isModelSwitchControlOutput(text)) {
              set((s) => ({ status: { ...s.status, running: false } }))
              break
            }
            if (text) {
              set((s) => {
                // De-dupe: sendMessage already rendered this optimistically
                // (incl. attachments), so don't add the text-only echo again.
                // #9 同上：窗口内找最近一条用户消息比对。
                if (hasRecentOwnMessageEcho(s.items, text)) {
                  // #29：agent 回显 = 已收到本条，按内容出台账（FIFO）。
                  ackUnackedDirectMessage(e.sessionId, text)
                  return { status: { ...s.status, running: true } }
                }
                return {
                  items: [
                    ...s.items,
                    { id: uid(), kind: 'user', text, parentToolUseId: parent }
                  ]
                }
              })
            }
          }
        }
        break
      }
      case 'stream_event': {
        const su = msg as unknown as { uuid: string; parent_tool_use_id: string | null; event: Record<string, unknown> }
        const parent = su.parent_tool_use_id ?? null
        set((s) =>
          applyStreamEvent(
            { items: s.items, currentStreamingMsgId: s.currentStreamingMsgId },
            su.uuid,
            parent,
            su.event
          )
        )
        break
      }
      case 'assistant': {
        const parent = (msg.parent_tool_use_id as string | null) ?? null
        const m = msg as unknown as {
          uuid: string
          error?: string
          message: { id?: string; content: Array<Record<string, unknown>> }
        }
        const blocks: AssistantBlock[] = []
        for (const c of m.message?.content ?? []) {
          const t = c.type
          if (t === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
          else if (t === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
          else if (t === 'tool_use') {
            blocks.push({
              kind: 'tool',
              toolUseId: String(c.id ?? ''),
              name: String(c.name ?? 'tool'),
              input: c.input,
              status: 'pending',
              startedAt: Date.now()
            })
          }
        }
        if (blocks.length > 0 && blocks.every((b) => b.kind === 'text' && isModelSwitchControlOutput(b.text))) {
          set((s) => ({ status: { ...s.status, running: false }, currentStreamingMsgId: null }))
          break
        }
        // Replace the in-flight streaming item with the authoritative final
        // message. Prefer currentStreamingMsgId (robust even when the streaming
        // item was keyed by a fallback id), then fall back to message.id, else add.
        set((s) => {
          let targetId: string | null = null
          if (s.currentStreamingMsgId && s.items.some((i) => i.id === s.currentStreamingMsgId)) {
            targetId = s.currentStreamingMsgId
          } else if (m.message?.id && s.items.some((i) => i.id === m.message.id)) {
            targetId = m.message.id
          }
          const finalId = targetId ?? (m.uuid ?? uid())
          const items =
            targetId !== null
              ? s.items.map((i) =>
                  i.id === finalId
                    ? {
                        id: finalId,
                        kind: 'assistant' as const,
                        blocks,
                        parentToolUseId: parent,
                        error: m.error
                      }
                    : i
                )
              : [
                  ...s.items,
                  {
                    id: finalId,
                    kind: 'assistant' as const,
                    blocks,
                    parentToolUseId: parent,
                    error: m.error
                  }
                ]
          return { items, status: { ...s.status, running: true }, currentStreamingMsgId: null }
        })
        // #5 turn 进行中。
        markSdkSessionRunning(get().meta?.sdkSessionId, true)
        break
      }
      case 'tool_progress': {
        const p = msg as unknown as { tool_use_id: string; elapsed_time_seconds: number }
        set((s) => ({
          items: mapTool(s.items, p.tool_use_id, (b) => ({
            ...b,
            status: 'running',
            elapsed: p.elapsed_time_seconds
          }))
        }))
        break
      }
      case 'result': {
        const r = msg as unknown as {
          total_cost_usd: number
          num_turns: number
          usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null }
          stop_reason: string | null
          subtype: string
          errors?: string[]
        }
        const resultError = r.errors?.length ? r.errors.join('; ') : r.subtype
        const shouldSuppressError = r.subtype === 'success' || isUserStopDiagnostic(resultError)
        // #29：错误收尾的 turn 若吞掉了一条直达消息（agent 从未收到/处理，典型：
        // 僵尸 turn "another turn is active"），回收到 pendingQueue 队首，交给
        // #20 的重发/清空出路，而不是只剩一个气泡悄悄丢失。仅在队列已空时回收：
        // 队列未空说明后端仍在按自身队列续跑，塞回去会打乱 renderer↔backend 的
        // 队列镜像。成功 result = 已处理，出台账；用户主动停止（suppressed）不
        // 动台账（该 turn 的消息可能没被处理，留给后续 result 定论）。
        // #29 台账结算（数组：连发的直达消息全部在册）：错误收尾把本会话的
        // 未确认消息**全部**取出回收；成功收尾整会话出账；用户主动停止不动账。
        let swallowed: UnackedDirectMessage[] = []
        if (!shouldSuppressError) {
          swallowed = takeUnackedDirectMessages(e.sessionId)
        } else if (r.subtype === 'success') {
          takeUnackedDirectMessages(e.sessionId)
        }
        set((s) => ({
          status: {
            ...s.status,
            // Stay "running" if a queued message is about to be processed.
            running: s.pendingQueue.length > 0,
            // turn 收尾：无响应提示随之撤掉（下一轮若再静默会重新推送）。
            stall: undefined,
            costUsd: r.total_cost_usd,
            turns: r.num_turns,
            inputTokens: r.usage?.input_tokens,
            outputTokens: r.usage?.output_tokens,
            cacheReadTokens: r.usage?.cache_read_input_tokens ?? undefined,
            stopReason: r.stop_reason ?? undefined,
            error: shouldSuppressError ? undefined : resultError
          },
          // Turn done: clear streaming flags, and drop the oldest queued
          // message into the transcript (the agent will process it next). If
          // there is one, the agent stays "running"; otherwise it goes idle.
          items: (() => {
            const cleared = s.items.map((i) =>
              i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i
            )
            // #32 turn 结束兜底：无终态 tool_result 的悬挂块封口 stopped。
            const sealed = sealHungToolBlocks(cleared, true)
            const due = s.pendingQueue[0]
            if (!due) return sealed
            return [
              ...sealed,
              {
                id: due.id,
                kind: 'user' as const,
                text: due.text,
                parentToolUseId: null,
                ...(due.attachments ? { attachments: due.attachments } : {}),
                ...(due.swarm ? { swarm: true } : {}),
                ...(due.cutIn ? { cutIn: true } : {})
              }
            ]
          })(),
          pendingQueue:
            swallowed.length > 0 && s.pendingQueue.length === 0
              ? swallowed.map((m) => ({
                  id: uid(),
                  text: m.text,
                  ...(m.attachments ? { attachments: m.attachments } : {}),
                  ...(m.swarm ? { swarm: true } : {}),
                  ...(m.cutIn ? { cutIn: true } : {})
                }))
              : s.pendingQueue.slice(1),
          currentStreamingMsgId: null
        }))
        // #5 turn 收尾：镜像 status.running（队列还有续跑消息时保持在册，
        // 真正空闲才移除，避免侧栏标识闪烁）。
        markSdkSessionRunning(get().meta?.sdkSessionId, get().status.running)
        // turn 完成：kimi 此时已持久化会话，刷新侧栏"最近会话"（防抖）。
        scheduleSessionsRefresh(get)
        // #TurnChanges：从本轮的写/改工具调用直接统计行数（不再走 git 快照对——
        // 大脏仓库里快照 IPC 会被轮内流量饿死，卡片晚一分钟才落地、位置跑到
        // 「所有的最下面」。工具输入就在本地，轮末零等待出卡（2026-08-18 用户：
        // 「diff 显示在本轮输出的最下面」）。
        {
          const changes = computeTurnChangesFromItems(get().items)
          if (changes) {
            set((s2) => ({
              items: [
                ...s2.items,
                {
                  id: uid(),
                  kind: 'turnChanges' as const,
                  parentToolUseId: null,
                  files: changes.files,
                  addedTotal: changes.addedTotal,
                  removedTotal: changes.removedTotal,
                  at: Date.now()
                }
              ]
            }))
          }
        }
        break
      }
      default:
        // hook_*, task_* etc. are intentionally ignored in the MVP.
        break
    }
  },

  applyStreamBatch(batch) {
    if (batch.length === 0) return
    const activeSessionId = get().meta?.sessionId
    // #6 后台会话的流式 delta 同样累积进各自的缓冲（切回时内容连续完整）。
    const activeBatch: StreamDeltaBatch[] = []
    for (const b of batch) {
      if (activeSessionId && b.sessionId === activeSessionId) {
        activeBatch.push(b)
        continue
      }
      const bg = backgroundSessions.get(b.sessionId)
      // #6 后台缓冲无渲染订阅：delta 原地折叠，免去逐条的 items 全量拷贝
      // （attach 时 cloneTranscriptItems 统一恢复引用新鲜度）。
      if (bg) foldBackgroundDeltaInPlace(bg, b)
    }
    if (activeBatch.length === 0) return
    // One set() per frame: fold every buffered delta through applyStreamEvent
    // in sequence. content_block_delta's branch returns unchanged items by
    // reference (only the streaming item is rebuilt), so after the loop the
    // final `items` array has exactly one new reference — the streaming message.
    set((s) => {
      let items = s.items
      let currentStreamingMsgId = s.currentStreamingMsgId
      for (const b of activeBatch) {
        const res = applyStreamEvent(
          { items, currentStreamingMsgId },
          b.fallbackId,
          b.parent,
          b.event
        )
        items = res.items
        currentStreamingMsgId = res.currentStreamingMsgId
      }
      return { items, currentStreamingMsgId }
    })
  },

  addPermissionRequest(r) {
    set((s) => ({ pendingPermissions: [...s.pendingPermissions, r] }))
  },

  async respondPermission(toolUseID, behavior, message, answers) {
    const resp: PermissionResponsePayload = {
      toolUseID,
      behavior,
      ...(message ? { message } : {}),
      ...(answers ? { answers } : {})
    }
    const sessionIdAtSend = get().meta?.sessionId
    const removed = get().pendingPermissions.filter((p) => p.toolUseID === toolUseID)
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter((p) => p.toolUseID !== toolUseID)
    }))
    try {
      await window.api.respondPermission(resp)
    } catch (error) {
      // 同 answerElicitation：回滚，否则授权弹窗消失而 turn 永远等不到回复。
      // #10 await 期间可能已切会话：不把 A 的弹窗回滚进 B，身份不符丢弃。
      if (removed.length && get().meta?.sessionId === sessionIdAtSend) {
        set((s) => ({ pendingPermissions: [...removed, ...s.pendingPermissions] }))
      }
      throw error
    }
  }
}))

/** 手动待办覆盖按 sdkSessionId 存取（lib/todoOverrides.ts，2026-08-26）：
 *  切会话/重置时 meta.sdkSessionId 一变就换载当前会话那份。放 subscribe 而
 *  不是散在各路切会话 action 里——meta 的写入点太多，漏一个就是 A 会话的
 *  手动勾选串到 B 会话的面板上。 */
let todoOverrideSessionId: string | undefined
useSessionStore.subscribe((s) => {
  const id = s.meta?.sdkSessionId
  if (id === todoOverrideSessionId) return
  todoOverrideSessionId = id
  useSessionStore.setState({ todoOverrides: id ? readTodoOverrides(id) : {} })
})
