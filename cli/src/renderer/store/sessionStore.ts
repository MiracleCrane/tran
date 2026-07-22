import { create } from 'zustand'
import type {
  AgentEvent,
  StartSessionOptions,
  PermissionResponsePayload,
  SessionListItem,
  HistoryMessage,
  PickedFile,
  EffortLevel,
  PermissionMode,
  AgentBackendId,
  ClaudeExecutionBackend,
  SkillInfo,
  GoalInfo
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
import { pickedFileToUserAttachment } from '../utils/attachments'
import { DEFAULT_KIMI_MODEL_ID } from '../../shared/models'
import { normalizeCwdForCompare } from '../../shared/paths'
import { emitForgeEvent } from '../events'

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
  /** 隐藏 /usage 轮解析出的上下文用量（system/context_usage；null 表示无数据）。 */
  contextUsage: ContextUsage | null
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

/** 模式面板状态（per session，随会话切换重置）。 */
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
  if (!entry?.items) return null
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
  if (cached?.items) {
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
        sessionHistoryCache.set(key, {
          items: cloneTranscriptItems(items),
          lastTouched: Date.now()
        })
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
  contextUsage: null,
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
        await window.api.closeSession(oldSessionId).catch(() => {})
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
    set({ starting: false, meta: null, items: [], tasks: [], pendingQueue: [], sessionConfigDirty: false, sessionModelDirty: false, bridgeEnded: false, status: emptyStatus, pendingPermissions: [], currentStreamingMsgId: null, sessions: [], sessionsHasMore: false, slashCommands: [], planEntries: [], contextUsage: null, modePanel: defaultModePanel(), goal: null, elicitationQueue: [] })
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
      await window.api.closeSession(newId).catch(() => {})
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
      await window.api.closeSession(newId).catch(() => {})
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
    const oldSessionId = meta.sessionId
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
        permissionMode,
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
      if (startResult.started) await window.api.closeSession(newId).catch(() => {})
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
    void window.api.closeSession(oldSessionId).catch(() => {})
    try {
      await window.api.startSession(
        sdkSessionId
          ? {
              cwd,
              ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
              ...(agentBackend ? { agentBackend } : {}),
              effort,
              resume: sdkSessionId,
              bridgeSessionId: newId
            }
          : {
              cwd,
              ...(modelForAgent(agentBackend, model) ? { model: modelForAgent(agentBackend, model) } : {}),
              ...(agentBackend ? { agentBackend } : {}),
              effort,
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
      await window.api.closeSession(newId).catch(() => {})
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
    if (get().meta?.sessionId !== e.sessionId) return

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
    if (!activeSessionId) return
    const activeBatch = batch.filter((b) => b.sessionId === activeSessionId)
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
