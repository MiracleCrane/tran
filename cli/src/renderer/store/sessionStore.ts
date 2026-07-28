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

/** 每个会话（按 sdkSessionId）最近使用的权限模式。kimi CLI 的 session/load
 *  不会恢复会话模式（init 恒报 default），Tran 侧持久化并在 resume 时重放，
 *  否则切走再切回来 chip 会被 init 覆盖回 default。 */
const PERMISSION_MODE_KEY_PREFIX = 'forge.permissionMode.'

function readStoredPermissionMode(sdkSessionId: string | undefined): PermissionMode | null {
  if (!sdkSessionId) return null
  try {
    const v = window.localStorage.getItem(PERMISSION_MODE_KEY_PREFIX + sdkSessionId)
    return v ? (v as PermissionMode) : null
  } catch {
    return null
  }
}

function storePermissionMode(sdkSessionId: string | undefined, mode: string): void {
  if (!sdkSessionId) return
  try {
    window.localStorage.setItem(PERMISSION_MODE_KEY_PREFIX + sdkSessionId, mode)
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
  /** Switch the active working directory (project): close the current session and
   *  start a fresh one in the new cwd (history is per-cwd in the sidebar). */
  switchProject: (path: string) => Promise<void>

  /** Sidebar actions */
  refreshSessions: () => Promise<void>
  /** 侧栏历史列表范围：当前项目 / 全部（跨项目，按 cwd 分组）。 */
  sessionScope: 'project' | 'all'
  setSessionScope: (scope: 'project' | 'all') => Promise<void>
  /** 「全部」视图点其他项目的会话：先切到该会话的 cwd 再 resume。 */
  openSessionCrossProject: (
    sdkSessionId: string,
    cwd: string | undefined,
    backend?: ClaudeExecutionBackend
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
  /** AskUserQuestion 回答：原样回传 optionId 并从队列移除。 */
  answerElicitation: (toolUseID: string, optionId: string) => Promise<void>
  loadMoreSessions: () => Promise<void>
  newChat: () => Promise<void>
  openSession: (sdkSessionId: string, backend?: ClaudeExecutionBackend) => Promise<void>
  prefetchSessionHistory: (sdkSessionId: string, backend?: ClaudeExecutionBackend) => Promise<void>
  pruneSessionHistoryCache: (visibleSessionIds: string[]) => void
  setTranscriptScrolling: (scrolling: boolean) => void
  renameSession: (sessionId: string, title: string, backend?: ClaudeExecutionBackend) => Promise<void>
  deleteSession: (sessionId: string, backend?: ClaudeExecutionBackend) => Promise<void>
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
const SESSION_PAGE_SIZE = 24
/** 「全部」视图一次拉取的上限（跨项目不做分页）。 */
const ALL_SESSIONS_LIMIT = 200
const HISTORY_PRELOAD_CHUNK_SIZE = 50
const HISTORY_HYDRATION_IDLE_TIMEOUT_MS = 700
const HISTORY_HYDRATION_SCROLL_PAUSE_MS = 140
const HISTORY_HYDRATION_RELEASE_MS = 2_000
let startupBootstrapPromise: Promise<void> | null = null
let sessionNavigationSeq = 0
let sessionListRequestSeq = 0
let loadMoreSessionsRequestSeq = 0

interface SessionHistoryCacheEntry {
  items?: TranscriptItem[]
  promise?: Promise<TranscriptItem[]>
  lastTouched: number
}

const sessionHistoryCache = new Map<string, SessionHistoryCacheEntry>()
const sessionStartPromises = new Map<string, Promise<void>>()

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
    if (transcriptScrolling) {
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
      set((s) => (
        s.meta?.sessionId === task.bridgeSessionId
          ? {
              items: [
                ...chunk.filter((item) => !s.items.some((existing) => existing.id === item.id)),
                ...s.items
              ]
            }
          : {}
      ))
    }

    if (task.loadedFrom > 0) {
      scheduleHistoryHydrationStep(get, set, task)
    }
  }

  if ('requestIdleCallback' in window) {
    task.idleId = window.requestIdleCallback(run, { timeout: HISTORY_HYDRATION_IDLE_TIMEOUT_MS })
  } else {
    task.timeoutId = setTimeout(run, 48)
  }
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
            const liveItems = s.items.filter((item) => !sourceIds.has(item.id))
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

  return { items, currentStreamingMsgId: msgId }
}

/** Convert a past session's transcript messages into renderable items, pairing
 *  each tool_use with its tool_result by id. */
export function historyToItems(messages: HistoryMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const m of messages) {
    if (m.type === 'assistant') {
      const beta = m.message as { content?: Array<Record<string, unknown>> }
      const blocks: AssistantBlock[] = []
      for (const c of beta.content ?? []) {
        if (c.type === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
        else if (c.type === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
        else if (c.type === 'tool_use')
          blocks.push({
            kind: 'tool',
            toolUseId: String(c.id ?? ''),
            name: String(c.name ?? 'tool'),
            input: c.input,
            status: 'pending'
          })
      }
      items.push({ id: m.uuid, kind: 'assistant', blocks, parentToolUseId: m.parent_tool_use_id })
    } else {
      const mp = m.message as { content?: unknown }
      const content = mp.content
      if (typeof content === 'string') {
        items.push({ id: m.uuid, kind: 'user', text: content, parentToolUseId: m.parent_tool_use_id })
      } else if (Array.isArray(content)) {
        const toolResults = content.filter(
          (c) => !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
        )
        if (toolResults.length) {
          for (const tr of toolResults) {
            const tid = (tr as { tool_use_id?: string }).tool_use_id
            for (const it of items) {
              if (it.kind !== 'assistant') continue
              for (const b of it.blocks) {
                if (b.kind === 'tool' && b.toolUseId === tid && b.status === 'pending') {
                  b.status = (tr as { is_error?: boolean }).is_error ? 'error' : 'done'
                  b.result = (tr as { content?: unknown }).content
                  b.resultIsError = !!(tr as { is_error?: boolean }).is_error
                }
              }
            }
          }
        } else {
          const text = content
            .map((c) =>
              c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''
            )
            .join('')
          if (text)
            items.push({ id: m.uuid, kind: 'user', text, parentToolUseId: m.parent_tool_use_id })
        }
      }
    }
  }
  return items
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
  /** 桥接进程已结束（agent:ended）：后端会话死了，attach 无意义，走原重放路径。 */
  ended: boolean
  error?: string
  tasks: SubagentTask[]
  planEntries: PlanEntry[]
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
}

const backgroundSessions = new Map<string, BackgroundSessionState>()
/** 缓冲上限：超限时淘汰最旧的空闲缓冲（连后端会话一起销毁，防内存/进程泄漏）。 */
const BACKGROUND_SESSION_CAP = 12

/** 导航离开当前会话前调用：把当前会话状态快照进后台缓冲，配合主进程的
 *  后台化语义，事件流由 foldBackgroundAgentEvent 继续往里累积。 */
function snapshotActiveSessionIntoBackground(get: () => SessionStore): void {
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
    ended: false,
    ...(s.status.error ? { error: s.status.error } : {}),
    tasks: s.tasks,
    planEntries: s.planEntries,
    goal: s.goal,
    slashCommands: s.slashCommands,
    contextUsage: s.contextUsage,
    mcpServers: s.mcpServers,
    elicitationQueue: s.elicitationQueue,
    swarmTasks: s.swarmTasks,
    modePanel: s.modePanel
  })
  while (backgroundSessions.size > BACKGROUND_SESSION_CAP) {
    const oldest = [...backgroundSessions.values()].find((bg) => !bg.running)
    if (!oldest) break
    backgroundSessions.delete(oldest.bridgeSessionId)
    void window.api.destroySession(oldest.bridgeSessionId).catch(() => {})
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

/** 后台会话的事件折叠：与 ingestAgentEvent 主会话分支同构，直接改缓冲对象。 */
function foldBackgroundAgentEvent(get: () => SessionStore, e: AgentEvent): void {
  const bg = backgroundSessions.get(e.sessionId)
  if (!bg) return // 未快照过的会话（防御）：保持原丢弃行为
  if (e.type === 'agent:ended') {
    bg.ended = true
    bg.running = false
    bg.error = isUserStopDiagnostic(e.error) ? bg.error : (e.error ?? bg.error)
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
          bg.items = [...historyItems.filter((i) => !existing.has(i.id)), ...bg.items]
        }
      } else if (subtype === 'plan') {
        const entries = (msg as unknown as { entries?: PlanEntry[] }).entries
        bg.planEntries = Array.isArray(entries) ? entries : []
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
        const c = (msg as unknown as {
          compaction?: { messagesCompacted?: number; tokensBefore?: number; tokensAfter?: number; at?: number }
        }).compaction
        if (c) {
          bg.items = [
            ...bg.items.filter(
              (it) =>
                !(
                  it.kind === 'assistant' &&
                  it.streaming &&
                  it.blocks.some(
                    (b) =>
                      b &&
                      b.kind === 'text' &&
                      /Compacting conversation context|Compaction completed/.test(b.text)
                  )
                )
            ),
            {
              id: uid(),
              kind: 'compaction' as const,
              parentToolUseId: null,
              ...(c.messagesCompacted !== undefined ? { messagesCompacted: c.messagesCompacted } : {}),
              ...(c.tokensBefore !== undefined ? { tokensBefore: c.tokensBefore } : {}),
              ...(c.tokensAfter !== undefined ? { tokensAfter: c.tokensAfter } : {}),
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
      }
      // status 等只影响瞬时 UI 的子类型，后台不需要。
      break
    }
    case 'user': {
      const parent = (msg.parent_tool_use_id as string | null) ?? null
      const content = (msg as unknown as { message: { content: unknown } }).message.content
      if (typeof content === 'string') {
        if (isModelSwitchControlOutput(content)) break
        const last = bg.items[bg.items.length - 1]
        if (!isOwnMessageEcho(last, content)) {
          bg.items = [...bg.items, { id: uid(), kind: 'user', text: content, parentToolUseId: parent }]
        }
        bg.running = true
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
            const last = bg.items[bg.items.length - 1]
            if (!isOwnMessageEcho(last, text)) {
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
      // turn 结束：清流式标记。后台缓冲没有 pendingQueue（切走时队列已清空，
      // 后续消息靠后端回显进入 items），running 以后端推送/下一个事件为准。
      bg.running = false
      bg.items = bg.items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i))
      bg.currentStreamingMsgId = null
      const resultError = r.errors?.length ? r.errors.join('; ') : r.subtype
      if (r.subtype !== 'success' && !isUserStopDiagnostic(resultError)) bg.error = resultError
      invalidateBackgroundHistoryCache(bg)
      scheduleSessionsRefresh(get)
      break
    }
    default:
      break
  }
}

/** If the SDK never sends system/init (e.g. the API backend hangs), unblock the
 *  UI after a timeout so the user can retry via New chat. */
function scheduleInitWatchdog(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  sessionId?: string
): void {
  setTimeout(() => {
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

function nextSessionNavigationSeq(): number {
  sessionNavigationSeq += 1
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
  status: emptyStatus,
  pendingPermissions: [],
  currentStreamingMsgId: null,
  sessions: [],
  sessionsLoading: false,
  sessionsHasMore: false,
  sessionScope: 'project',
  tasks: [], pendingQueue: [],
  sessionConfigDirty: false,
  sessionModelDirty: false,
  bridgeEnded: false,
  slashCommands: [],
  planEntries: [],
  swarmTasks: null,
  contextUsage: null,
  mcpServers: null,
  modePanel: defaultModePanel(),
  goal: null,
  elicitationQueue: [],

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
      const model = modelForAgent(agentBackend, args.model)
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
          model: displayModelForAgent(agentBackend, args.model),
          permissionMode,
          tools: []
        },
        items: [],
        tasks: [], pendingQueue: [],
        sessionConfigDirty: false,
        sessionModelDirty: false,
        bridgeEnded: false,
        planEntries: [],
        contextUsage: null,
        mcpServers: null,
        modePanel: defaultModePanel(),
        goal: null,
        elicitationQueue: [],
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
        set({ sessionConfigDirty: false, sessionModelDirty: refreshingModel, bridgeEnded: false })
        meta = get().meta
        if (!meta) return
      } catch (error: unknown) {
        set((s) => ({
          meta: oldMeta,
          status: {
            ...s.status,
            error: error instanceof Error ? error.message : String(error)
          }
        }))
        return
      }
    }

    if (meta.sdkSessionId) deleteSessionHistoryCache(meta.cwd, meta.sdkSessionId)
    // 目标模式：goalEnabled 且无进行中的目标时，用本条消息文本创建目标（本条即第 1 轮）。
    if (get().modePanel.goalEnabled && value) {
      const currentGoal = get().goal
      if (!currentGoal || (currentGoal.status !== 'active' && currentGoal.status !== 'paused')) {
        void window.api.goalStart(meta.sessionId, { objective: value }).catch(() => {})
      }
    }
    // Swarm 模式：发送时在用户文本前隐藏拼接指令前缀（气泡显示原文 + Swarm 徽章）。
    const swarmOn = get().modePanel.swarmEnabled
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

    // Always push to the SDK (it queues internally); the UI placement differs.
    // Queue (hover) only when the MAIN agent is genuinely busy — not when it's
    // merely waiting on a backgrounded subagent (then it's free for new input).
    const hasBackgroundSubagent = get().tasks.some(
      (t) => t.isBackgrounded && t.status === 'running'
    )
    const busy = get().status.running && !hasBackgroundSubagent
    if (busy) {
      set((s) => ({ pendingQueue: [...s.pendingQueue, { id: uid(), text: value, ...attProps, ...swarmProps, ...cutInProps }] }))
    } else {
      set((s) => ({
        items: [...s.items, { id: uid(), kind: 'user', text: value, parentToolUseId: null, ...attProps, ...swarmProps, ...cutInProps }],
        status: { ...s.status, running: true, error: undefined }
      }))
    }
    try {
      await sessionStartPromises.get(meta.sessionId)
      if (get().meta?.sessionId !== meta.sessionId) return
      await window.api.sendMessage(meta.sessionId, content)
    } catch (error: unknown) {
      if (get().meta?.sessionId !== meta.sessionId) return
      set((s) => ({
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
      status: { ...s.status, running: false }
    }))
    await window.api.interrupt(meta.sessionId)
  },

  async setModel(model) {
    const meta = get().meta
    if (!meta) return
    if (meta.model === model) return
    // Kimi ACP 支持会话内实时切换模型（session/set_config_option），无需重启
    // 会话；切换失败时后端只记录日志，本地状态保持新值即可。
    set({ meta: { ...meta, model } })
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
    set({ starting: false, meta: null, items: [], tasks: [], pendingQueue: [], sessionConfigDirty: false, sessionModelDirty: false, bridgeEnded: false, status: emptyStatus, pendingPermissions: [], currentStreamingMsgId: null, sessions: [], sessionsHasMore: false, slashCommands: [], planEntries: [], contextUsage: null, mcpServers: null, modePanel: defaultModePanel(), goal: null, elicitationQueue: [] })
  },

  async bootstrap() {
    if (get().bootstrapped || get().meta) return
    if (startupBootstrapPromise) return startupBootstrapPromise

    startupBootstrapPromise = (async () => {
      try {
        const proj = await window.api.getStartupProject()
        if (proj) {
          const provider = await window.api.getActiveProvider()
          await get().startSession({ cwd: proj.path, model: provider?.model })
        }
      } finally {
        set({ bootstrapped: true })
        startupBootstrapPromise = null
      }
    })()

    return startupBootstrapPromise
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
      sessions: [],
      sessionsHasMore: false,
      planEntries: [],
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
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
    // 后台缓冲的 running（attach 时恢复忙碌态用）。
    const bg = backgroundSessions.get(p.sessionId)
    if (bg) bg.running = p.running
    // 侧栏列表项的 running 标记（按 acpSessionId 匹配）。当前会话的
    // status.running 以事件流为准，这里不动。
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
  },

  async answerElicitation(toolUseID, optionId) {
    // elicitation：原样回传用户点选的 optionId（answers 通道），从队列移除。
    set((s) => ({ elicitationQueue: s.elicitationQueue.filter((q) => q.toolUseID !== toolUseID) }))
    await window.api.respondPermission({
      toolUseID,
      behavior: 'allow',
      answers: { optionId }
    })
  },

  async refreshSessions() {
    const meta = get().meta
    if (!meta) return
    const requestSeq = ++sessionListRequestSeq
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
    } finally {
      if (sessionListRequestSeq === requestSeq) set({ sessionsLoading: false })
    }
  },

  async setSessionScope(scope) {
    if (get().sessionScope === scope) return
    set({ sessionScope: scope, sessions: [], sessionsHasMore: false })
    await get().refreshSessions()
  },

  async openSessionCrossProject(sdkSessionId, cwd, backend) {
    const meta = get().meta
    if (!meta) return
    // 先切到该会话所属项目，再 resume（不在原项目里跨 cwd load）。
    if (cwd && normalizeCwdForCompare(cwd) !== normalizeCwdForCompare(meta.cwd)) {
      await get().switchProject(cwd)
    }
    await get().openSession(sdkSessionId, backend)
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

  async newChat() {
    const meta = get().meta
    if (!meta) return
    cancelActiveHistoryHydration()
    const { cwd, model, agentBackend } = meta
    const oldSessionId = meta.sessionId
    const newId = uid()
    const requestSeq = nextSessionNavigationSeq()
    const startGate = createSessionStartGate(newId)
    const isLatestRequest = (): boolean => isCurrentSessionNavigation(get, requestSeq, newId)
    // #6 切走=后台化：快照当前会话进事件缓冲（turn 继续跑，切回可 attach）。
    snapshotActiveSessionIntoBackground(get)
    // 根因修复：此前 newChat 沿用旧会话的 permissionMode 做乐观值、且不传给
    // 后端（opts 里根本没有 permissionMode），ACP 侧停留在 CLI default，init
    // 事件随后把 chip 覆盖回 default —— 设置里的默认权限模式就此丢失。
    // 全新会话应用设置里的默认档；resume 历史会话仍走原模式（见 openSession）。
    const prefs = await window.api.getPreferences().catch(() => null)
    const permissionMode = prefs?.defaultPermissionMode ?? 'default'
    if (!isLatestRequest()) {
      startGate.resolve()
      return
    }
    // Switch the UI to a fresh session instantly (unlocked). claude.exe spawns
    // in the background; any messages sent now queue and flush once ready.
    set({
      starting: true,
      items: [],
      tasks: [], pendingQueue: [],
      sessionConfigDirty: false,
      sessionModelDirty: false,
      bridgeEnded: false,
      planEntries: [],
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
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
  },

  async openSession(sdkSessionId: string, backend?: ClaudeExecutionBackend) {
    const meta = get().meta
    if (!meta) return
    if (meta.sdkSessionId === sdkSessionId) return
    cancelActiveHistoryHydration()
    const { cwd, model, permissionMode, agentBackend } = meta
    // resume 不会带回会话模式（init 恒报 default）：优先用本地记住的该会话
    // 模式，其次沿用当前会话的模式，并在 startSession 时显式下发。
    const restoredMode: PermissionMode = readStoredPermissionMode(sdkSessionId) ?? (permissionMode as PermissionMode)
    const oldSessionId = meta.sessionId

    // #6 后台会话 attach：目标会话切走时后端未被 cancel，事件已累积进它自己的
    // 缓冲——直接接管其桥接 id 和缓冲内容继续渲染，不走 session/load 全量重放
    // （重放会重复，且空壳已被磁盘删除时 load 直接失败）。
    const bg = findLiveBackgroundSession(sdkSessionId)
    if (bg && normalizeCwdForCompare(bg.cwd) === normalizeCwdForCompare(cwd)) {
      backgroundSessions.delete(bg.bridgeSessionId)
      nextSessionNavigationSeq()
      snapshotActiveSessionIntoBackground(get)
      void window.api.closeSession(oldSessionId).catch(() => {})
      // 桥接早已就绪：sendMessage 的启动门闩直接放行。
      createSessionStartGate(bg.bridgeSessionId).resolve()
      // #23 swarmTasks 交接给 App 的订阅 effect（防它的切会话清空抹掉恢复值）。
      attachedSwarmTasks = { sdkSessionId, tasks: bg.swarmTasks }
      set({
        starting: false,
        items: bg.items,
        tasks: bg.tasks,
        pendingQueue: [],
        sessionConfigDirty: false,
        sessionModelDirty: false,
        bridgeEnded: false,
        planEntries: bg.planEntries,
        contextUsage: bg.contextUsage,
        mcpServers: bg.mcpServers,
        modePanel: bg.modePanel,
        goal: bg.goal,
        elicitationQueue: bg.elicitationQueue,
        slashCommands: bg.slashCommands,
        swarmTasks: bg.swarmTasks,
        status: { running: bg.running, ...(bg.error ? { error: bg.error } : {}) },
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
      planEntries: [],
      contextUsage: null,
      mcpServers: null,
      modePanel: defaultModePanel(),
      goal: null,
      elicitationQueue: [],
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
      set((s) => ({
        starting: false,
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
    if (!meta) return
    // 销毁仍活着的后端会话（后台缓冲的 / 当前活跃的）：否则 turn 继续在后台烧。
    const bg = takeBackgroundSession(sessionId)
    if (bg) void window.api.destroySession(bg.bridgeSessionId).catch(() => {})
    if (meta.sdkSessionId === sessionId) {
      void window.api.destroySession(meta.sessionId).catch(() => {})
      // 桥接已销毁：标记 bridgeEnded，避免随后的 newChat 把死会话快照进后台缓冲。
      set({ bridgeEnded: true })
    }
    try {
      const result = await window.api.deleteSession(sessionId, meta.cwd, backend)
      // 主进程校验失败（路径穿越防护等）：不删列表项，提示错误。
      if (result && result.ok === false) {
        set((s) => ({ status: { ...s.status, error: result.error ?? '删除会话失败' } }))
        return
      }
    } catch {
      /* ignore */
    }
    deleteSessionHistoryCache(meta.cwd, sessionId, backend)
    set((s) => ({ sessions: s.sessions.filter((x) => x.sessionId !== sessionId) }))
    // Deleted the active conversation → start fresh.
    if (meta.sdkSessionId === sessionId) {
      await get().newChat()
    }
    void get().refreshSessions()
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
      try {
        const result = await window.api.deleteSession(target.sessionId, meta.cwd, target.backend)
        if (result && result.ok === false) {
          failed += 1
          continue
        }
        deleted += 1
        deletedIds.add(target.sessionId)
        deleteSessionHistoryCache(meta.cwd, target.sessionId, target.backend)
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
      set((s) => ({
        bridgeEnded: true,
        status: { ...s.status, running: false, error: endedError ?? s.status.error }
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
            // 新会话/恢复会话时清空上一会话残留的待办清单（新 plan 事件会重建）。
            planEntries: [],
            contextUsage: null,
            mcpServers: null,
            modePanel: defaultModePanel(),
            goal: null,
            elicitationQueue: [],
            status: { ...s.status }
          }))
        } else if (subtype === 'status') {
          const status = (msg as unknown as { status: string | null }).status
          set((s) => ({ status: { ...s.status, compacting: status === 'compacting' } }))
        } else if (subtype === 'slash_commands') {
          const c = (msg as unknown as { commands?: SkillInfo[] }).commands
          set({ slashCommands: Array.isArray(c) ? c : [] })
        } else if (subtype === 'plan') {
          // ACP plan：kimi 全量推送待办清单，直接整体替换（实时更新）。
          const entries = (msg as unknown as { entries?: PlanEntry[] }).entries
          set({ planEntries: Array.isArray(entries) ? entries : [] })
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
          // 压缩轮（/compact 或自动压缩）：插入分界线 item；剔除可能已流式进
          // transcript 的压缩原文（未标记的自动压缩兜底路径会短暂流出）。
          const c = (msg as unknown as {
            compaction?: { messagesCompacted?: number; tokensBefore?: number; tokensAfter?: number; at?: number }
          }).compaction
          if (c) {
            set((s) => ({
              items: [
                ...s.items.filter(
                  (it) =>
                    !(
                      it.kind === 'assistant' &&
                      it.streaming &&
                      it.blocks.some(
                        (b) =>
                          b &&
                          b.kind === 'text' &&
                          /Compacting conversation context|Compaction completed/.test(b.text)
                      )
                    )
                ),
                {
                  id: uid(),
                  kind: 'compaction' as const,
                  parentToolUseId: null,
                  ...(c.messagesCompacted !== undefined ? { messagesCompacted: c.messagesCompacted } : {}),
                  ...(c.tokensBefore !== undefined ? { tokensBefore: c.tokensBefore } : {}),
                  ...(c.tokensAfter !== undefined ? { tokensAfter: c.tokensAfter } : {}),
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
              return { items: [...fresh, ...s.items] }
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
          set((s) => {
            const last = s.items[s.items.length - 1]
            if (isOwnMessageEcho(last, content)) {
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
                const last = s.items[s.items.length - 1]
                if (isOwnMessageEcho(last, text)) {
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
        set((s) => ({
          status: {
            ...s.status,
            // Stay "running" if a queued message is about to be processed.
            running: s.pendingQueue.length > 0,
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
            const due = s.pendingQueue[0]
            if (!due) return cleared
            return [
              ...cleared,
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
          pendingQueue: s.pendingQueue.slice(1),
          currentStreamingMsgId: null
        }))
        // turn 完成：kimi 此时已持久化会话，刷新侧栏"最近会话"（防抖）。
        scheduleSessionsRefresh(get)
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
      if (bg) {
        const res = applyStreamEvent(
          { items: bg.items, currentStreamingMsgId: bg.currentStreamingMsgId },
          b.fallbackId,
          b.parent,
          b.event
        )
        bg.items = res.items
        bg.currentStreamingMsgId = res.currentStreamingMsgId
      }
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
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter((p) => p.toolUseID !== toolUseID)
    }))
    await window.api.respondPermission(resp)
  }
}))
