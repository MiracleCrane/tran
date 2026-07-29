import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  McpServerStatusKind,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SDKMessage,
  SessionUsageInfo,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import {
  DEFAULT_KIMI_MODEL_ID,
  DEFAULT_KIMI_MODELS
} from '../../shared/models'
import type { AgentBackendHandlers } from './AgentBridge'
import {
  AcpClient,
  AcpRequestError,
  type AcpRpcId,
  type AcpRpcMessage
} from './AcpClient'
import { resolveWindowsKimiCommand } from '../windowsKimi'
import { recordSessionTitle, removeSessionTitle } from '../sessionTitles'
import { generateAiTitle } from '../aiTitles'
import { deleteKimiSession } from '../sessionDelete'
import {
  controlGoal,
  getGoal,
  startGoal,
  updateGoal,
  type GoalControlAction,
  type GoalInfo,
  type GoalStartOptions
} from '../goalStore'
import { log } from '../logger'

interface QueuedMessage {
  content: string | unknown[]
  /** 目标续跑轮（goal 循环注入的提醒 prompt）：结束后不再触发隐藏 /usage 轮。 */
  goal?: boolean
}

interface ActiveKimiSession {
  id: string
  cwd: string
  model?: string
  permissionMode?: string
  acpSessionId?: string
  queue: QueuedMessage[]
  running: boolean
  closed?: boolean
  ready: Promise<void>
  turn: number
  replaying: boolean
  currentMessageId?: string
  streamedText: string
  streamStarted: boolean
  /** 正文/思考在同一 assistant 消息里的 content block 索引（Claude 惯例：
   *  thinking 在前、text 在后）。同一 turn 的思考流累积进同一个 thinking block，
   *  修复"每个词一个思考块"的碎块问题。 */
  textBlockIndex: number | null
  thinkingText: string
  thinkingBlockIndex: number | null
  nextBlockIndex: number
  toolResults: Set<string>
  skills: SkillInfo[]
  lastUsage?: TokenUsage
  /** 隐藏轮（/usage）：标志置位期间该会话所有流式事件不转发渲染层，只累积文本。 */
  hiddenTurn: boolean
  hiddenText: string
  /** 隐藏轮解析出的上下文用量（Context: X / Y (Z%)）。 */
  contextUsage?: ContextUsage
  /** session/load 历史重放累积器（仅 resume 的 replaying 窗口内存在）。 */
  replay?: ReplayAccumulator
  /** 本轮最终正文（goal 循环终止判定用，runTurn 封停前捕获）。 */
  lastTurnText: string
  /** 本轮是否发生过 tool_call（goal 无进展保护用）。 */
  turnHadToolCall: boolean
  /** 连续无 tool_call 的 goal 轮数（≥3 暂停）。 */
  noProgressTurns: number
  /** 本轮是否出错（goal 循环遇错暂停）。 */
  lastTurnFailed: boolean
  /** 压缩轮标记（/compact prompt 或自动压缩检出）：该轮压缩文本累积不转发，
   *  turn 结束解析后经 system/compaction 合成消息推渲染层。 */
  compactTurn: boolean
  compactText: string
  /** 隐藏 /usage 轮进行中又收到刷新请求：轮末补跑一次。 */
  usageRefreshPending: boolean
  /** 空壳治理：本次运行由 Tran 新建（session/new，非 resume）的会话。 */
  createdViaNew: boolean
  /** 空壳治理：是否收到过真实用户 prompt（sendMessage 的用户消息；
   *  隐藏 /usage 轮不算）。 */
  gotRealPrompt: boolean
  /** AI 命名：本运行内是否已触发过自动生成（首轮快命名，控制 token 成本）。 */
  aiTitleRequested: boolean
  /** AI 命名：是否已用前几次发言精修过一次（至多一次，AI 标题可覆盖）。 */
  aiTitleRefined: boolean
  /** AI 命名语料：前 3 次真实用户发言原文（斜杠命令轮不收）。 */
  titleTexts: string[]
  /** 查询轮（/usage、/status、/mcp 这类"查询结果非对话"的斜杠命令）：该轮
   *  文本累积不转发对话流，turn 结束经 system/query_result 状态卡推送。 */
  queryTurn: boolean
  queryText: string
  queryCommand?: string
  /** 隐藏 /mcp 轮解析出的 server 状态缓存（listMcpServers / 面板刷新用）。 */
  mcpServers?: McpServerEntry[]
  /** #41 本轮用户 turn 开始时间（0=空闲；忙碌态计时/静默监督用）。 */
  turnStartedAt: number
  /** #41 最近一次该会话事件时间（静默监督的活动计时）。 */
  lastEventAt: number
  /** #41 上次"疑似无响应"推送时间（0=未推送；活动恢复后归零）。 */
  stallWarnedAt: number
  /** #41 静默监督定时器（仅用户轮在跑时存在）。 */
  stallTimer?: NodeJS.Timeout
  /** #41 兜底中止：纯静默到上限时 reject 进行中的 prompt（runTurn race）。 */
  stallAbort?: (error: Error) => void
  /** #41 权限/elicitation 等待中：是在等用户不是 agent 卡死，静默监督暂停。 */
  waitingOnUser: boolean
}

interface PendingPermission {
  client: AcpClient
  requestId: AcpRpcId
  options: Array<Record<string, unknown>>
  /** AskUserQuestion（elicitation）：回传用户点选的原样 optionId，不走模糊匹配。 */
  elicitation?: boolean
  /** #41 发起等待的桥接会话 id：用户作答后复位其 waitingOnUser。 */
  sessionId?: string
}

interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextUsed?: number
  contextSize?: number
}

/** 隐藏轮解析出的上下文用量（渲染层圆环/预览卡用）。 */
interface ContextUsage {
  usedText: string
  /** usedText 的数值形式（k/M 后缀已换算），两位小数百分比用它算。 */
  used: number
  total: number
  pct: number
  /** /usage 的 Total 行：会话累计 token（cache creation 忽略）。 */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
}

/** 历史重放累积器：replaying 窗口内把重放事件流攒成 HistoryMessage 形状的
 *  消息数组，session/load 响应到达后整批推给渲染层（不走流式管道）。 */
interface ReplayAccumulator {
  sessionId: string
  messages: Array<Record<string, unknown>>
  /** toolUseId → 最新非终态结果（flush 时补一条 done 结果，防卡片永远"排队中"）。 */
  pendingToolResults: Map<string, { content: string; isError: boolean }>
  /** 已出终态（completed/failed）的 toolUseId。 */
  terminalToolCalls: Set<string>
  thinkingText: string
  text: string
  /** 当前用户消息的 messageId（user_message_chunk 分块追加用）。 */
  userMsgId: string | null
}

interface PromptPayload {
  prompt: Array<Record<string, unknown>>
}

const KIMI_AUTH_HINT = 'Kimi CLI 未登录或登录已过期：请在终端运行 kimi login 完成登录，然后重启 Tran。'

/** 会话打开后查 MCP 状态前的等待（server 异步连接，实测秒级）。 */
const MCP_CONNECT_GRACE_MS = 3500
/** /mcp 结果仍有 pending server 时的补查间隔（只补一次）。 */
const MCP_PENDING_RETRY_MS = 6000

/** 僵尸 turn 恢复：命中 "another turn" 后补发 session/cancel 的生效等待
 *  （kimi 侧取消是异步的，立即重试会再撞一次）。 */
const ZOMBIE_CANCEL_GRACE_MS = 2000

/** #41 长 turn 分级介入（用户轮不再 900s 硬掐——一次多任务、阻塞型子代理可
 *  十几分钟无流式事件，硬超时会把正常工作掐死）。该会话任何事件都重置静默
 *  计时；纯静默到 WARN 不掐断，推"疑似无响应"给渲染层（用户决定继续等/打断，
 *  打断走现有 cancel 路径）；纯静默到 ABORT 才自动 cancel 防真僵尸（后续
 *  请求撞 "another turn" 时由 #27 的 cancel+retry 恢复）。 */
const TURN_STALL_WARN_MS = 15 * 60_000
const TURN_STALL_ABORT_MS = 2 * 60 * 60_000
const TURN_STALL_CHECK_MS = 60_000

/** Map ACP/JSON-RPC failures to user-facing text. authRequired (-32000) means
 *  the Kimi CLI has no usable token — the fix is a terminal `kimi login`. */
function userFacingError(error: unknown): string {

  if (error instanceof AcpRequestError && error.code === -32000) return KIMI_AUTH_HINT
  const message = error instanceof Error ? error.message : String(error)
  return /auth(entication)? (is )?required/i.test(message) ? KIMI_AUTH_HINT : message
}

/** 拼接错误的 message 与 error.data 供文本匹配。
 *  error 可能是 null/undefined（promise 以空值 reject），直接取 .data 会
 *  抛 TypeError，把原始错误换成一个更难查的崩溃。 */
function errorHaystack(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  let data = ''
  if (error !== null && typeof error === 'object') {
    try {
      data = JSON.stringify((error as { data?: unknown }).data ?? '')
    } catch {
      data = ''
    }
  }
  return `${message} ${data}`
}

/** "another turn" 错误识别（turn ID 数字可变，与渲染层 ErrorDiagnosticPanel 的
 *  识别文案同源）：agent 侧还挂着上一轮（result 丢失/超时取消失败留下的僵尸
 *  turn）时，session/prompt 会以此报错。message 与 error.data 一并匹配。 */
function isAnotherTurnError(error: unknown): boolean {
  const haystack = errorHaystack(error)
  return haystack.includes('another turn') || haystack.includes('turn.agent_busy')
}

/** 从 session/load 的错误文本中解析缺失的 plan 文件绝对路径。严格白名单校验
 *  （必须位于 ~/.kimi-code/sessions 下、属于该会话、在 plans 目录、.md 结尾），
 *  防止异常文本诱导写出任意路径。 */
function missingPlanFileFromError(error: unknown, acpSessionId: string): string | null {
  const haystack = errorHaystack(error)
  if (!haystack.includes('ENOENT') || !haystack.includes('readTextFile')) return null
  const match = /readTextFile failed for (.+?\.md)\b/i.exec(haystack)
  if (!match) return null
  const p = match[1].trim()
  const norm = (s: string): string => s.replace(/\//g, '\\').toLowerCase()
  const sessionsRoot = join(homedir(), '.kimi-code', 'sessions')
  if (!norm(p).startsWith(norm(sessionsRoot))) return null
  if (!norm(p).includes(norm(acpSessionId)) || !norm(p).includes('\\plans\\')) return null
  return p
}

export class KimiBackend {
  readonly id = 'kimi' as const
  private sessions = new Map<string, ActiveKimiSession>()
  private acpToSession = new Map<string, string>()
  private pendingPermissions = new Map<string, PendingPermission>()
  /** 注册竞争窗口里到达的 session/update 通知（按 acpSessionId 分组），
   *  在 acpToSession 注册后按序 flush —— 不丢、不重、顺序保持。 */
  private pendingNotifications = new Map<string, AcpRpcMessage[]>()
  private clientPromise: Promise<AcpClient> | null = null
  private client: AcpClient | null = null
  /** Model choices discovered from session/new configOptions (ACP-side source
   *  of truth), merged over DEFAULT_KIMI_MODELS in listModels(). */
  private discoveredModels: ComposerModel[] = []

  constructor(private h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Kimi backend currently supports Windows only.')
    const sessionId = opts.bridgeSessionId ?? cryptoId()
    const session: ActiveKimiSession = {
      id: sessionId,
      cwd: opts.cwd,
      model: kimiModel(opts.model),
      permissionMode: opts.permissionMode,
      queue: [],
      running: false,
      ready: Promise.resolve(),
      turn: 0,
      replaying: false,
      streamedText: '',
      streamStarted: false,
      textBlockIndex: null,
      thinkingText: '',
      thinkingBlockIndex: null,
      nextBlockIndex: 0,
      toolResults: new Set(),
      skills: [],
      hiddenTurn: false,
      hiddenText: '',
      lastTurnText: '',
      turnHadToolCall: false,
      noProgressTurns: 0,
      lastTurnFailed: false,
      compactTurn: false,
      compactText: '',
      usageRefreshPending: false,
      createdViaNew: !opts.resume,
      gotRealPrompt: false,
      aiTitleRequested: false,
      aiTitleRefined: false,
      titleTexts: [],
      queryTurn: false,
      queryText: '',
      turnStartedAt: 0,
      lastEventAt: 0,
      stallWarnedAt: 0,
      waitingOnUser: false
    }
    session.ready = this.prepareSession(session, opts)
    this.sessions.set(sessionId, session)
    session.ready.catch((error) => {
      if (!this.sessions.has(sessionId)) return
      const message = userFacingError(error)
      log('kimi', `prepare failed session=${sessionId}: ${message}`)
      this.h.onEnded(sessionId, message)
      this.sessions.delete(sessionId)
    })
    return sessionId
  }

  send(sessionId: string, content: string | unknown[]): void {
    const session = this.requireSession(sessionId)
    // 真实用户 prompt 标记（空壳治理用；隐藏 /usage 轮不走这里，不会误标）。
    session.gotRealPrompt = true
    session.queue.push({ content })
    void this.drain(session)
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.acpSessionId) return
    // 手停闸：用户中断时 goal 循环一并暂停（防止取消后轮次继续烧）。
    if (getGoal(sessionId)?.status === 'active') {
      controlGoal(sessionId, 'pause')
      this.emitGoal(session)
    }
    const client = await this.ensureClient()
    client.notify('session/cancel', { sessionId: session.acpSessionId })
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.model = kimiModel(model)
    // 'kimi-default' 表示交给 CLI 自己选模型，不下发 ACP 切换。
    if (!session.model || !session.acpSessionId) return
    const client = await this.ensureClient()
    await client.request('session/set_config_option', {
      sessionId: session.acpSessionId,
      configId: 'model',
      value: session.model
    }).catch((error) => {
      log('kimi', `set model failed: ${userFacingError(error)}`)
    })
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.permissionMode = mode
    if (!session.acpSessionId) return
    const client = await this.ensureClient()
    await client.request('session/set_config_option', {
      sessionId: session.acpSessionId,
      configId: 'mode',
      value: kimiMode(mode)
    }).catch((error) => {
      log('kimi', `set mode failed: ${userFacingError(error)}`)
    })
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    this.disarmStallWatch(session)
    if (session.acpSessionId) {
      // 空壳治理：Tran 新建但没发过消息的会话，离开时直接从磁盘删掉。
      this.discardEmptyShell(session)
      this.acpToSession.delete(session.acpSessionId)
      this.pendingNotifications.delete(session.acpSessionId)
      // Kimi ACP 未实现 session/close —— 只取消当前 turn 并丢弃本地映射。
      this.client?.notify('session/cancel', { sessionId: session.acpSessionId })
    }
    this.sessions.delete(sessionId)
  }

  /**
   * 切走/后台化（区别于显式关闭）：不 cancel turn、不删 session、保留
   * acpToSession 映射——后台 turn 继续跑，事件继续经 onMessage/onEnded（带
   * sessionId）推给渲染层。仅保留空壳治理：从未发过消息的新会话仍删磁盘壳。
   */
  background(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.discardEmptyShell(session)
  }

  /** session/prompt 硬超时后补发 session/cancel：终止 agent 侧空跑的 turn，
   *  避免后续请求撞 "another turn in progress"。失败只记日志（AcpClient 保证
   *  不掩盖原始超时错误）。 */
  private cancelTurnOnTimeout(client: AcpClient, session: ActiveKimiSession): void {
    if (!session.acpSessionId) return
    try {
      client.notify('session/cancel', { sessionId: session.acpSessionId })
    } catch (error) {
      log('kimi', `cancel after timeout failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** session/prompt 统一入口（用户轮 + 隐藏轮共用）：撞 "another turn"（僵尸
   *  turn——上轮 result 丢失或超时取消未生效，Tran 侧 running 已复位但 agent 侧
   *  turn 还活着）时自动补 session/cancel、短等生效后原样重试一次；重试仍失败
   *  才把原始错误抛给 UI。与 drain/hiddenTurn 互斥守卫配合：本进程内不可能另有
   *  本地轮在跑，命中即僵尸，cancel 不会误杀正常轮。全过程只记日志，对用户无感。 */
  private async promptWithRecovery(
    client: AcpClient,
    session: ActiveKimiSession,
    payload: PromptPayload,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const acpSessionId = session.acpSessionId
    if (!acpSessionId) throw new Error('Kimi session is not ready.')
    const send = (): Promise<Record<string, unknown>> =>
      client.request<Record<string, unknown>>('session/prompt', {
        sessionId: acpSessionId,
        prompt: payload.prompt,
        messageId: cryptoId()
      }, timeoutMs, () => this.cancelTurnOnTimeout(client, session))
    try {
      return await send()
    } catch (error) {
      if (!isAnotherTurnError(error) || session.closed) throw error
      log('kimi', `zombie turn detected session=${session.id}: ${userFacingError(error)} — cancel + retry once`)
      this.cancelTurnOnTimeout(client, session)
      await new Promise((resolve) => setTimeout(resolve, ZOMBIE_CANCEL_GRACE_MS))
      if (session.closed) throw error
      try {
        return await send()
      } catch (retryError) {
        log('kimi', `zombie turn retry failed session=${session.id}: ${userFacingError(retryError)}`)
        throw error
      }
    }
  }

  /** 侧栏列表合并用：正在跑 turn 的 ACP 会话 id 集合。 */
  runningAcpSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.running && session.acpSessionId) ids.add(session.acpSessionId)
    }
    return ids
  }

  /** turn 开始/结束时推送运行状态（渲染层实时更新侧栏/标签的运行标记）。
   *  开始时附带本轮开始时间戳（#41 渲染层忙碌态 mm:ss 计时用）。 */
  private emitRunning(session: ActiveKimiSession, running: boolean): void {
    this.h.onSessionRunning?.(
      session.id,
      running,
      session.acpSessionId,
      running && session.turnStartedAt ? session.turnStartedAt : undefined
    )
  }

  /** #41 静默监督（仅用户轮；隐藏轮保持 60s 硬超时不变）：每分钟检查一次该
   *  会话活动。纯静默到 WARN 推"疑似无响应"（之后每个 WARN 周期复读一次，
   *  含最新时长）；到 ABORT 自动 cancel 并中止本轮（真僵尸兜底）。 */
  private armStallWatch(session: ActiveKimiSession): void {
    this.disarmStallWatch(session)
    session.lastEventAt = Date.now()
    session.stallWarnedAt = 0
    session.stallTimer = setInterval(() => this.checkTurnStall(session), TURN_STALL_CHECK_MS)
    session.stallTimer.unref()
  }

  private disarmStallWatch(session: ActiveKimiSession): void {
    if (session.stallTimer) {
      clearInterval(session.stallTimer)
      session.stallTimer = undefined
    }
    session.stallWarnedAt = 0
  }

  private checkTurnStall(session: ActiveKimiSession): void {
    if (!session.running || !session.turnStartedAt || session.closed) return
    // 权限/elicitation 等待期间不算无响应——是在等用户，不是 agent 卡死。
    if (session.waitingOnUser) return
    // 会话已被取代/清空（close/handleClientClose 后旧定时器的残火）：直接自拆。
    if (this.sessions.get(session.id) !== session) {
      this.disarmStallWatch(session)
      return
    }
    const now = Date.now()
    const silentMs = now - session.lastEventAt
    if (silentMs >= TURN_STALL_ABORT_MS) {
      const silentMin = Math.round(silentMs / 60000)
      log('kimi', `turn stalled ${silentMin}min session=${session.id} — auto cancel (zombie fallback)`)
      this.emitTurnStall(session, silentMs)
      if (this.client) this.cancelTurnOnTimeout(this.client, session)
      // 中止 runTurn 的等待（race）。prompt 的 pending 条目留给 ACP 响应/进程
      // 关闭时清理——cancel 生效（#27 实测）时响应会到达并正常清掉。
      session.stallAbort?.(new Error(`本轮已 ${silentMin} 分钟完全无响应，Tran 已自动中断（agent 疑似卡死）。`))
      return
    }
    if (silentMs >= TURN_STALL_WARN_MS && now - session.stallWarnedAt >= TURN_STALL_WARN_MS) {
      session.stallWarnedAt = now
      this.emitTurnStall(session, silentMs)
    }
  }

  /** #41 活动触点：该会话任何事件（流式/工具/权限/fs）都重置静默计时；
   *  曾推过"疑似无响应"的，补一条 recovered 让渲染层撤掉提示。 */
  private touchTurnActivity(session: ActiveKimiSession): void {
    if (!session.running || !session.turnStartedAt) return
    session.lastEventAt = Date.now()
    if (session.stallWarnedAt) {
      session.stallWarnedAt = 0
      this.h.onMessage(session.id, {
        type: 'system',
        subtype: 'turn_stall',
        stall: { recovered: true, at: Date.now() }
      } as unknown as SDKMessage)
    }
  }

  /** #41 "疑似无响应"推送：含本轮已运行时长与当前静默时长（渲染层提示卡用）。 */
  private emitTurnStall(session: ActiveKimiSession, silentMs: number): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'turn_stall',
      stall: {
        elapsedMs: Date.now() - session.turnStartedAt,
        silentMs,
        at: Date.now()
      }
    } as unknown as SDKMessage)
  }

  /** 空壳治理：Tran 新建但没发过消息的会话，在离开（切对话/切项目/退出）时删除
   *  并清掉本地标题记录。删除失败只记日志、不阻塞导航。 */
  private discardEmptyShell(session: ActiveKimiSession): void {
    if (!session.createdViaNew || session.gotRealPrompt || !session.acpSessionId) return
    const result = deleteKimiSession(session.acpSessionId)
    if (result.ok) {
      removeSessionTitle(session.acpSessionId)
      log('kimi', `discarded empty session shell ${session.acpSessionId}`)
      // 通知渲染层刷新侧栏（空壳条目立即消失）；删除失败不发。15 秒的补刀
      // 删除（见下）不再通知——条目在首次刷新后已不可见。
      this.h.onSessionsChanged?.()
      // kimi ACP 进程在删除后会异步重建目录壳（空的 agents/ 残留，实测）。
      // 延迟补一刀：仍在索引外就直接再删；兜底扫尾交给启动时的孤儿清扫。
      const acpSessionId = session.acpSessionId
      setTimeout(() => {
        const retry = deleteKimiSession(acpSessionId)
        if (!retry.ok) log('kimi', `empty shell re-delete failed: ${retry.error ?? 'unknown'}`)
      }, 15_000).unref()
    } else {
      log('kimi', `discard empty shell failed: ${result.error ?? 'unknown'}`)
    }
  }

  // MCP server 状态来自隐藏 /mcp 轮（ACP initialize/session-new 均不下发
  // server 明细，实测 0.29）；会话打开时自动查一次并经 system/mcp_servers
  // 推送，这里返回缓存。toggle 尚未接入（ACP 无对应方法）。
  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    return [...(session.mcpServers ?? [])]
  }

  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready.catch(() => {})
    // 触发一次隐藏 /mcp 轮重查（内部有空闲/串行守卫），结果经
    // system/mcp_servers 推送；这里先返回现有缓存。
    void this.runHiddenMcpTurn(session)
    return [...(session.mcpServers ?? [])]
  }

  async toggleMcpServer(_sessionId: string, _name: string, _enabled: boolean): Promise<void> {
    // see listMcpServers TODO
  }

  async backgroundTask(_sessionId: string, _toolUseId?: string): Promise<boolean> {
    return false
  }

  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    return [...session.skills]
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const session = this.requireSession(sessionId)
    await session.ready.catch(() => {})
    const usage = session.lastUsage
    return {
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage?.totalTokens,
      contextUsed: usage?.contextUsed,
      contextSize: usage?.contextSize ?? contextWindowForModel(session.model),
      model: session.model
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    return mergeComposerModels(DEFAULT_KIMI_MODELS, this.discoveredModels)
  }

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    return []
  }

  respondPermission(resp: PermissionResponsePayload): boolean {
    const pending = this.pendingPermissions.get(resp.toolUseID)
    if (!pending) return false
    this.pendingPermissions.delete(resp.toolUseID)
    // #41 用户已作答：复位"等用户"状态，静默监督恢复。
    if (pending.sessionId) {
      const session = this.sessions.get(pending.sessionId)
      if (session) session.waitingOnUser = false
    }
    if (pending.elicitation) {
      // elicitation：原样返回用户点选的 optionId（不做 allow/deny 模糊匹配）。
      const chosen = asString(resp.answers?.optionId)
      try {
        pending.client.respond(pending.requestId, {
          outcome: chosen ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' }
        })
      } catch (error) {
        log('kimi', `elicitation response failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return true
    }
    const optionId = permissionOptionId(pending.options, resp.behavior)
    try {
      pending.client.respond(
        pending.requestId,
        optionId
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } }
      )
    } catch (error) {
      log('kimi', `permission response failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  private async prepareSession(
    session: ActiveKimiSession,
    opts: StartSessionOptions
  ): Promise<void> {
    const client = await this.ensureClient()
    let response: Record<string, unknown> | null = null
    if (opts.resume) {
      // session/load 恢复会话并回放历史；重放事件（响应返回前到达）在 replaying
      // 窗口内累积成 HistoryMessage 数组，窗口结束后经 system/history 整批推给
      // 渲染层（不走流式管道，避免"逐字打出历史"）。已知瑕疵：每轮最后一条
      // agent 回复可能缺席（~90% 保真），可接受。
      session.replaying = true
      session.replay = {
        sessionId: opts.resume,
        messages: [],
        pendingToolResults: new Map(),
        terminalToolCalls: new Set(),
        thinkingText: '',
        text: '',
        userMsgId: null
      }
      session.acpSessionId = opts.resume
      this.acpToSession.set(opts.resume, session.id)
      // resume 路径注册在请求之前，理论上不会有缓冲；防御性 flush（通常空转）。
      this.flushPendingNotifications(opts.resume)
      try {
        response = await this.loadSessionWithRecovery(client, session, opts.resume)
      } finally {
        session.replaying = false
        this.flushReplay(session)
      }
    } else {
      response = await client.request<Record<string, unknown>>('session/new', {
        cwd: session.cwd,
        mcpServers: []
      }, 120000)
      const acpSessionId = asString(response?.sessionId)
      if (!acpSessionId) throw new Error('Kimi ACP did not return a session id.')
      session.acpSessionId = acpSessionId
      // 竞态修复：session/new 在途期间会话已被关闭/取代（典型：新建对话 → 1 秒
      // 内切走）。close 时 acpSessionId 还没就绪，discardEmptyShell 当时直接
      // return，磁盘空壳无人清理——这里补删（含 removeSessionTitle +
      // onSessionsChanged 通知，与 close 路径一致），不注册映射、不做后续初始化。
      if (session.closed) {
        this.discardEmptyShell(session)
        // 缓冲区里可能已经堆了这个 acpSessionId 的通知（kimi 在 session/new
        // 响应后立刻推）。这里不注册映射也不 flush，不清就永久留在 Map 里。
        this.pendingNotifications.delete(acpSessionId)
        return
      }
      this.acpToSession.set(acpSessionId, session.id)
      // kimi 在 session/new 响应后立即推 available_commands_update 等通知，此时
      // 注册刚完成——把竞争窗口里缓冲的通知按序回放（见 handleNotification）。
      this.flushPendingNotifications(acpSessionId)
    }

    // resume 路径同理早退：session/load 在途（或 ensureClient 在途）被 close 时
    // 不删（是有内容的真实会话），但若映射是在 close 之后才注册的，清掉防悬挂。
    // 同样跳过后续初始化（thinking/mode 下发、emitInit、drain、隐藏 /usage 轮）
    // ——会话已被取代，渲染层不再等它的 init。
    if (session.closed) {
      const lateAcpSessionId = session.acpSessionId
      if (lateAcpSessionId) {
        this.acpToSession.delete(lateAcpSessionId)
        this.pendingNotifications.delete(lateAcpSessionId)
      }
      return
    }

    this.rememberConfigOptions(response?.configOptions)
    const model = currentConfigValue(response?.configOptions, 'model') ?? session.model ?? DEFAULT_KIMI_MODEL_ID
    session.model = kimiModel(model) ?? undefined
    // 思考等级映射：kimi 0.26 ACP 的 thinking 配置恒为 "on"（设值不报错也不生效），
    // 照发不误——kimi 未来开放后自动生效。UI 三档：low/high/max。
    if (opts.effort) {
      void client.request('session/set_config_option', {
        sessionId: session.acpSessionId,
        configId: 'thinking',
        value: opts.effort
      }).catch((error) => log('kimi', `set thinking failed: ${userFacingError(error)}`))
    }
    // resume 路径不传 permissionMode：从 configOptions 回填 ACP 侧真实 mode，
    // 保证 resume 历史会话保持原有模式（否则 emitInit 把它显示成 default）。
    if (!session.permissionMode) {
      const acpMode = currentConfigValue(response?.configOptions, 'mode')
      if (acpMode) session.permissionMode = acpMode
    }
    if (session.permissionMode) {
      await this.setPermissionMode(session.id, session.permissionMode)
    }
    this.emitInit(session, session.acpSessionId ?? opts.resume ?? session.id, session.model ?? model)
    void this.drain(session)
    // 会话打开即刷新上下文用量 + MCP server 状态（串行隐藏轮；有轮在跑则
    // turn 末的 afterTurn 会补 /usage，这里只在空转时触发，保持串行）。
    if (!session.closed && !session.running && session.queue.length === 0) {
      void this.runSessionOpenHiddenTurns(session)
    }
  }

  /** 会话打开时的串行隐藏轮：先 /usage（上下文环），稍等 MCP 异步连接后
   *  再 /mcp（server 状态条）。任一环节失败只记日志，不影响会话。 */
  private async runSessionOpenHiddenTurns(session: ActiveKimiSession): Promise<void> {
    await this.runHiddenUsageTurn(session)
    // MCP server 在 session/new / session/load 后异步连接（实测秒级），立即查
    // 只能拿到 pending——先等一拍；仍有 pending 时 runHiddenMcpTurn 自补一次。
    await new Promise((resolve) => setTimeout(resolve, MCP_CONNECT_GRACE_MS))
    if (session.closed || session.running || session.queue.length) return
    await this.runHiddenMcpTurn(session)
  }

  private rememberConfigOptions(value: unknown): void {
    const models = modelOptionsFromConfig(value)
    if (models.length) this.discoveredModels = models
  }

  /** session/load 容错：kimi CLI 回放 wire 时会读取计划模式事件引用的 plan 文件
   *  （会话目录下 agents 各子目录 plans 里的 .md）；会话在计划模式中被中断可能
   *  留下"有引用、无文件"的残缺状态，使整个 session/load 以 Internal error
   *  失败、会话永久打不开。检测到这类 ENOENT 时补建占位 plan 文件并重试（多个
   *  缺失文件逐个补，上限 4 次防御死循环），其余错误原样抛出。 */
  private async loadSessionWithRecovery(
    client: AcpClient,
    session: ActiveKimiSession,
    acpSessionId: string
  ): Promise<Record<string, unknown>> {
    const doLoad = (): Promise<Record<string, unknown>> =>
      client.request<Record<string, unknown>>(
        'session/load',
        {
          cwd: session.cwd,
          sessionId: acpSessionId,
          mcpServers: []
        },
        120000
      )

    let lastError: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await doLoad()
      } catch (error) {
        lastError = error
        const missing = missingPlanFileFromError(error, acpSessionId)
        if (!missing) throw error
        try {
          mkdirSync(dirname(missing), { recursive: true })
          if (!existsSync(missing)) {
            writeFileSync(
              missing,
              '# 计划\n\n（会话在计划模式中被中断，原始计划文件未能保存。此文件为恢复会话加载而补建。）\n',
              'utf8'
            )
          }
          log('kimi', `session/load recovery: recreated missing plan file ${missing}`)
        } catch (writeError) {
          log('kimi', `session/load recovery write failed: ${userFacingError(writeError)}`)
          throw error
        }
      }
    }
    throw lastError
  }

  private async drain(session: ActiveKimiSession): Promise<void> {
    // hiddenTurn 互斥：隐藏轮（/usage、/mcp）在 agent 侧也是真实 turn，不设
    // running——这里挡住，避免用户轮与隐藏轮并发撞 "another turn"。隐藏轮
    // 结束时会在 finally 里补 drain 排队的消息。
    if (session.running || session.hiddenTurn || session.closed) return
    const next = session.queue.shift()
    if (!next) return
    session.running = true
    session.turn += 1
    session.turnHadToolCall = false
    session.turnStartedAt = Date.now()
    this.emitRunning(session, true)
    try {
      await session.ready
      await this.runTurn(session, next)
    } catch (error) {
      session.lastTurnFailed = true
      this.emitResult(session, {
        subtype: 'error',
        error: userFacingError(error)
      })
    } finally {
      session.running = false
      session.turnStartedAt = 0
      session.waitingOnUser = false
      this.disarmStallWatch(session)
      this.emitRunning(session, false)
      session.currentMessageId = undefined
      session.streamedText = ''
      session.streamStarted = false
      session.textBlockIndex = null
      session.thinkingText = ''
      session.thinkingBlockIndex = null
      session.nextBlockIndex = 0
      session.toolResults.clear()
      // 压缩轮标志随轮重置（runTurn 正常结束已清；这里是出错兜底）。
      session.compactTurn = false
      session.compactText = ''
      // 查询轮标志同理（出错兜底：吞掉的文本直接丢弃，不补状态卡）。
      session.queryTurn = false
      session.queryText = ''
      session.queryCommand = undefined
      if (!session.closed && session.queue.length) void this.drain(session)
      // turn 完成且队列空了：隐藏 /usage 轮 + goal 续跑（串行，见 afterTurn）。
      else if (!session.closed) void this.afterTurn(session, next)
    }
  }

  /** turn 结束后的串行钩子：先隐藏 /usage 轮（快；goal 续跑轮跳过，避免每轮
   *  双倍 /usage），再判定 goal 循环是否续跑。 */
  private async afterTurn(session: ActiveKimiSession, finished: QueuedMessage): Promise<void> {
    if (!finished.goal) await this.runHiddenUsageTurn(session)
    if (session.closed) return
    // MCP 状态首查在会话打开时没机会跑（用户立即开聊）：turn 末空闲补一次。
    if (session.mcpServers === undefined && !session.running && session.queue.length === 0) {
      await this.runHiddenMcpTurn(session)
      if (session.closed) return
    }
    if (session.queue.length) {
      void this.drain(session)
      return
    }
    // 上轮出错：goal 循环不再续跑（防连续报错烧额度），置 paused。
    if (session.lastTurnFailed) {
      session.lastTurnFailed = false
      const goal = getGoal(session.id)
      if (goal?.status === 'active') {
        updateGoal(session.id, { status: 'paused', blockedReason: '上轮执行出错' })
        this.emitGoal(session)
      }
      return
    }
    await this.maybeContinueGoal(session)
    if (!session.closed && session.queue.length) void this.drain(session)
  }

  /** goal 循环钩子：解析上轮最终文本的状态行决定 停/续；续跑时注入改写的
   *  active-reminder（untrusted_objective + 纪律 + GOAL_STATUS 文本协议）。 */
  private async maybeContinueGoal(session: ActiveKimiSession, force = false): Promise<void> {
    const goal = getGoal(session.id)
    if (!goal || goal.status !== 'active') return

    if (!force) {
      // 终止判定：状态行（大小写不敏感，容许 markdown 行内形式）。
      const verdict = parseGoalStatus(session.lastTurnText)
      if (verdict?.action === 'complete') {
        updateGoal(session.id, { status: 'complete' })
        this.emitGoal(session)
        return
      }
      if (verdict?.action === 'blocked') {
        updateGoal(session.id, { status: 'blocked', blockedReason: verdict.reason ?? 'agent 宣告阻塞' })
        this.emitGoal(session)
        return
      }
      // 无进展保护：连续 3 轮 continue（或状态行缺失）且无任何 tool_call → 暂停。
      session.noProgressTurns = session.turnHadToolCall ? 0 : session.noProgressTurns + 1
      if (session.noProgressTurns >= 3) {
        session.noProgressTurns = 0
        updateGoal(session.id, { status: 'paused', blockedReason: '连续 3 轮无进展' })
        this.emitGoal(session)
        return
      }
    } else {
      session.noProgressTurns = 0
    }

    // 预算闸：耗尽则暂停（防烧额度第一道闸）。
    if (goal.turnCount >= goal.maxTurns) {
      updateGoal(session.id, { status: 'paused', blockedReason: '预算耗尽' })
      this.emitGoal(session)
      return
    }
    const next = updateGoal(session.id, { turnCount: goal.turnCount + 1 })
    this.emitGoal(session)
    session.queue.push({ content: buildGoalReminder(next ?? goal), goal: true })
  }

  private emitGoal(session: ActiveKimiSession): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'goal',
      goal: getGoal(session.id)
    } as unknown as SDKMessage)
  }

  async goalStart(sessionId: string, opts: GoalStartOptions): Promise<GoalInfo | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const goal = startGoal(sessionId, opts)
    this.emitGoal(session)
    return goal
  }

  async goalControl(sessionId: string, action: GoalControlAction): Promise<GoalInfo | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const goal = controlGoal(sessionId, action)
    this.emitGoal(session)
    // resume：立即续跑一轮（跳过状态行判定，预算闸仍然生效）。
    if (action === 'resume' && goal?.status === 'active' && !session.running) {
      void (async () => {
        await this.maybeContinueGoal(session, true)
        if (!session.closed && session.queue.length) void this.drain(session)
      })()
    }
    return goal
  }

  async goalGet(sessionId: string): Promise<GoalInfo | null> {
    return getGoal(sessionId)
  }

  /** 隐藏轮：向 ACP 会话发 '/usage'，该轮的流式事件全部吞掉（hiddenTurn 标志），
   *  只累积文本，结束后解析 Context 行推给渲染层。标志在 prompt 响应到达后才
   *  清除——kimi 侧 FIFO，用户轮排在隐藏轮之后，其事件到达时标志已清。
   *  只在会话空闲时跑（busy 直接跳过：turn 末的 afterTurn 会补刷新），不与
   *  对话流抢 FIFO。 */
  private async runHiddenUsageTurn(session: ActiveKimiSession): Promise<void> {
    if (session.closed || !session.acpSessionId || session.hiddenTurn) return
    if (session.running || session.queue.length) return
    session.hiddenTurn = true
    session.hiddenText = ''
    try {
      const client = await this.ensureClient()
      await this.promptWithRecovery(client, session, { prompt: [{ type: 'text', text: '/usage' }] }, 60000)
      const usage = parseContextUsage(session.hiddenText)
      if (usage && !session.closed) {
        session.contextUsage = usage
        this.h.onMessage(session.id, {
          type: 'system',
          subtype: 'context_usage',
          contextUsage: usage
        } as unknown as SDKMessage)
      }
    } catch (error) {
      log('kimi', `hidden /usage turn failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      session.hiddenTurn = false
      session.hiddenText = ''
      // 轮进行中收到的刷新请求：轮末补跑一次。
      if (session.usageRefreshPending && !session.closed) {
        session.usageRefreshPending = false
        void this.runHiddenUsageTurn(session)
      }
      // 隐藏轮期间排队的消息（drain 被 hiddenTurn 互斥挡住）：轮末补 drain。
      if (!session.closed && !session.hiddenTurn && session.queue.length) void this.drain(session)
    }
  }

  /** 渲染层悬停上下文环触发的即时刷新：无轮直接跑，隐藏轮在途标记 pending 轮末
   *  补；用户轮在途/队列非空则跳过（turn 末 afterTurn 会补刷新）。 */
  async requestUsageRefresh(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    if (session.hiddenTurn) {
      session.usageRefreshPending = true
      return
    }
    void this.runHiddenUsageTurn(session)
  }

  /** 隐藏轮：向 ACP 会话发 '/mcp'，解析 server 连接状态（名称/connected 等
   *  状态/传输方式/工具数），经 system/mcp_servers 推渲染层状态区。与
   *  /usage 隐藏轮共用 hiddenTurn 吞事件机制；只在会话空闲时跑（用户轮在
   *  途时直接放弃，状态区等下次机会，不与对话流抢 FIFO）。 */
  private async runHiddenMcpTurn(session: ActiveKimiSession, allowRetry = true): Promise<void> {
    if (session.closed || !session.acpSessionId || session.hiddenTurn) return
    if (session.running || session.queue.length) return
    session.hiddenTurn = true
    session.hiddenText = ''
    try {
      const client = await this.ensureClient()
      await this.promptWithRecovery(client, session, { prompt: [{ type: 'text', text: '/mcp' }] }, 60000)
      const servers = parseMcpServers(session.hiddenText)
      if (servers && !session.closed) {
        session.mcpServers = servers
        this.h.onMessage(session.id, {
          type: 'system',
          subtype: 'mcp_servers',
          servers
        } as unknown as SDKMessage)
        // server 异步连接：还有 pending 就晚些补查一次（仅一次，防轮询烧 turn）。
        if (allowRetry && servers.some((s) => s.status === 'pending')) {
          setTimeout(() => {
            if (!session.closed) void this.runHiddenMcpTurn(session, false)
          }, MCP_PENDING_RETRY_MS).unref()
        }
      }
    } catch (error) {
      log('kimi', `hidden /mcp turn failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      session.hiddenTurn = false
      session.hiddenText = ''
      // 轮进行中收到的 /usage 刷新请求：轮末补跑（与 runHiddenUsageTurn 同款）。
      if (session.usageRefreshPending && !session.closed) {
        session.usageRefreshPending = false
        void this.runHiddenUsageTurn(session)
      }
      // 隐藏轮期间排队的消息（drain 被 hiddenTurn 互斥挡住）：轮末补 drain。
      if (!session.closed && !session.hiddenTurn && session.queue.length) void this.drain(session)
    }
  }

  private async runTurn(session: ActiveKimiSession, message: QueuedMessage): Promise<void> {
    if (!session.acpSessionId) throw new Error('Kimi session is not ready.')
    const userText = firstUserText(message.content).trimStart()
    // 查询轮标记（/usage、/status、/mcp：输出是状态信息不是对话）：该轮文本
    // 累积不转发对话流，turn 结束经 system/query_result 状态卡推送。
    const queryCommand = queryCommandOf(userText)
    if (queryCommand) {
      session.queryTurn = true
      session.queryCommand = queryCommand
    } else {
      // 侧栏标题兜底：kimi 对未命名会话只回 "New Session"，用首条用户消息补
      // （斜杠命令轮不当标题）。
      recordSessionTitle(session.acpSessionId, firstUserText(message.content))
    }
    // AI 命名语料：前 3 次真实发言（斜杠命令轮不收）。
    if (session.createdViaNew && userText && !userText.startsWith('/') && session.titleTexts.length < 3) {
      session.titleTexts.push(firstUserText(message.content))
    }
    // 压缩轮标记：/compact（含参数形式）——该轮压缩文本不渲染，结束统一解析。
    if (userText.startsWith('/compact')) {
      session.compactTurn = true
    }
    const client = await this.ensureClient()
    const payload = contentToPrompt(message.content)
    // #41 用户轮无硬超时（timeoutMs=0）：长任务（一次多任务、阻塞型子代理可
    // 十几分钟无流式事件）不该被 900s 掐死。改由静默监督分级介入：纯静默
    // 15 分钟推"疑似无响应"（用户决定继续等/打断），纯静默 2 小时自动 cancel
    // 兜底（stallAbort race 在此 reject，错误走 drain 的统一出错路径）。
    this.armStallWatch(session)
    const stallAbort = new Promise<never>((_, reject) => {
      session.stallAbort = reject
    })
    let response: Record<string, unknown>
    try {
      response = await Promise.race([this.promptWithRecovery(client, session, payload, 0), stallAbort])
    } finally {
      session.stallAbort = undefined
      this.disarmStallWatch(session)
    }
    // goal 循环终止判定用：封停前捕获本轮最终正文。
    session.lastTurnText = session.streamedText
    // 查询轮：输出经 system/query_result 状态卡推渲染层（原文不进对话流）。
    if (session.queryTurn) {
      const command = session.queryCommand ?? '/status'
      const text = session.queryText.trim()
      session.queryTurn = false
      session.queryText = ''
      session.queryCommand = undefined
      this.h.onMessage(session.id, {
        type: 'system',
        subtype: 'query_result',
        query: { command, text, at: Date.now() }
      } as unknown as SDKMessage)
      // 用户手输 /usage：顺带刷新上下文环（与隐藏轮同一解析）。
      if (command === '/usage') {
        const usage = parseContextUsage(text)
        if (usage) {
          session.contextUsage = usage
          this.h.onMessage(session.id, {
            type: 'system',
            subtype: 'context_usage',
            contextUsage: usage
          } as unknown as SDKMessage)
        }
      }
    }
    // 压缩轮：解析统计数据，经 system/compaction 推渲染层（原始文本不渲染）。
    if (session.compactTurn) {
      this.h.onMessage(session.id, {
        type: 'system',
        subtype: 'compaction',
        compaction: { ...parseCompaction(session.compactText), at: Date.now() }
      } as unknown as SDKMessage)
      session.compactTurn = false
      session.compactText = ''
    }
    this.sealStreamMessage(session)
    const usage = asRecord(response.usage)
    this.emitResult(session, {
      subtype: response.stopReason === 'refusal' ? 'error' : 'success',
      error: response.stopReason === 'refusal' ? 'Kimi refused the prompt.' : undefined,
      inputTokens: asNumber(usage?.inputTokens),
      outputTokens: asNumber(usage?.outputTokens),
      totalTokens: asNumber(usage?.totalTokens)
    })
    // AI 会话命名：Tran 新建会话限定（resume 的老会话不自动生成）。首轮结束
    // 用首条发言快速命名一次；攒够前 3 次发言后再精修一次（#17：命名输入不
    // 只给第一句话；AI 标题可覆盖，手动命名永远不动）。单次 ≈100-200 token，
    // 每会话至多 2 次，失败静默回退原标题，不重试。
    if (session.createdViaNew && session.acpSessionId) {
      const texts = session.titleTexts
      if (!session.aiTitleRequested && texts.length > 0) {
        session.aiTitleRequested = true
        void generateAiTitle(session.acpSessionId, texts[0]).then((title) => {
          if (title) this.h.onSessionsChanged?.()
        })
      } else if (texts.length >= 3 && !session.aiTitleRefined) {
        session.aiTitleRefined = true
        void generateAiTitle(session.acpSessionId, texts.join('\n'), { overwriteAiTitle: true }).then((title) => {
          if (title) this.h.onSessionsChanged?.()
        })
      }
    }
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client) return this.client
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const resolved = await resolveWindowsKimiCommand()
        return AcpClient.start({
          command: resolved.command,
          argsPrefix: resolved.argsPrefix,
          args: ['acp'],
          displayPath: resolved.displayPath,
          logTag: 'kimi',
          clientInfo: { name: 'tran', title: 'Tran', version: '1.0.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: false
          }
        }, {
          onNotification: (msg) => this.handleNotification(msg),
          onServerRequest: (msg) => this.handleServerRequest(msg),
          onClose: (error) => this.handleClientClose(error)
        })
      })().then((client) => {
        this.client = client
        return client
      }).catch((error) => {
        this.clientPromise = null
        throw error
      })
    }
    return this.clientPromise
  }

  private handleNotification(msg: AcpRpcMessage): void {
    if (msg.method !== 'session/update') return
    const params = asRecord(msg.params)
    const acpSessionId = asString(params?.sessionId)
    const session = this.sessionForAcp(acpSessionId)
    if (!session) {
      // 时序竞争：kimi 在 session/new 响应后紧跟着推 available_commands_update
      // 等通知，stdout 在同一同步块里先 resolve request、再处理通知，而
      // acpToSession 注册要等微任务。查不到 session 时先缓冲，注册后按序回放。
      if (acpSessionId) {
        const pending = this.pendingNotifications.get(acpSessionId) ?? []
        pending.push(msg)
        this.pendingNotifications.set(acpSessionId, pending)
      }
      return
    }
    const update = asRecord(params?.update)
    if (!update) return
    // 回放（session/load）期间：历史内容累积成 transcript（见 handleReplayUpdate），
    // 会话级配置推送（斜杠命令/plan/usage）在累积器内分流、照常处理。
    if (session.replaying) {
      this.handleReplayUpdate(session, update)
      return
    }
    this.handleSessionUpdate(session, update)
  }

  /** replaying 窗口内的事件路由：配置类推送走正常逻辑，历史内容累积成
   *  HistoryMessage 形状的消息数组（flushReplay 时整批发出）。 */
  private handleReplayUpdate(session: ActiveKimiSession, update: Record<string, unknown>): void {
    const replay = session.replay
    if (!replay) return
    const type = asString(update.sessionUpdate)
    if (type === 'available_commands_update' || type === 'plan' || type === 'usage_update') {
      this.handleSessionUpdate(session, update)
      return
    }
    if (type === 'user_message_chunk') {
      // 用户消息原文（可能分块）：同 messageId 追加，否则开新用户消息。
      this.sealReplayStream(session)
      const text = textFromContentBlock(update.content)
      if (!text) return
      const msgId = asString(update.messageId)
      const last = replay.messages[replay.messages.length - 1]
      if (msgId && msgId === replay.userMsgId && last?.type === 'user') {
        const m = last.message as { content: string }
        m.content += text
      } else {
        replay.userMsgId = msgId ?? `kimi-replay-user-${cryptoId()}`
        replay.messages.push({
          type: 'user',
          uuid: `kimi-replay-${cryptoId()}`,
          session_id: session.acpSessionId ?? '',
          message: { content: text },
          parent_tool_use_id: null
        })
      }
      return
    }
    replay.userMsgId = null
    if (type === 'agent_thought_chunk') {
      replay.thinkingText += textFromContentBlock(update.content)
      return
    }
    if (type === 'agent_message_chunk') {
      replay.text += textFromContentBlock(update.content)
      return
    }
    if (type === 'tool_call') {
      this.sealReplayStream(session)
      const toolUseId = asString(update.toolCallId) ?? cryptoId()
      replay.messages.push({
        type: 'assistant',
        uuid: `kimi-replay-${cryptoId()}`,
        session_id: session.acpSessionId ?? '',
        message: {
          id: `kimi-replay-toolmsg-${toolUseId}`,
          content: [{ type: 'tool_use', id: toolUseId, name: toolName(update), input: toolInput(update) }]
        },
        parent_tool_use_id: null
      })
      return
    }
    if (type === 'tool_call_update') {
      const toolUseId = asString(update.toolCallId)
      if (!toolUseId || replay.terminalToolCalls.has(toolUseId)) return
      const status = asString(update.status)
      const content = stringifyToolResult(update.rawOutput ?? update.content ?? update.title ?? status ?? '')
      if (status === 'completed' || status === 'failed') {
        replay.terminalToolCalls.add(toolUseId)
        replay.pendingToolResults.delete(toolUseId)
        pushReplayToolResult(replay, toolUseId, content, status === 'failed')
      } else {
        replay.pendingToolResults.set(toolUseId, { content, isError: false })
      }
      return
    }
  }

  /** 把累积的思考+正文封停成一条 assistant 历史消息（工具调用/用户消息边界处调用）。 */
  private sealReplayStream(session: ActiveKimiSession): void {
    const replay = session.replay
    if (!replay) return
    const content: Array<Record<string, unknown>> = []
    if (replay.thinkingText) content.push({ type: 'thinking', thinking: replay.thinkingText })
    // 重放也要剥 GOAL_STATUS 状态行——goal 会话的历史重放里状态行同样不该裸露
    // （live 路径按 goal 激活态剥，重放路径无 goal 上下文，按模式匹配无条件剥）。
    if (replay.text) content.push({ type: 'text', text: stripGoalStatusLine(replay.text) })
    if (content.length) {
      replay.messages.push({
        type: 'assistant',
        uuid: `kimi-replay-${cryptoId()}`,
        session_id: session.acpSessionId ?? '',
        message: { id: `kimi-replay-msg-${cryptoId()}`, content },
        parent_tool_use_id: null
      })
    }
    replay.thinkingText = ''
    replay.text = ''
  }

  /** 重放窗口结束：封停流、补齐无终态的工具结果，整批经 system/history 发出。 */
  private flushReplay(session: ActiveKimiSession): void {
    const replay = session.replay
    if (!replay) return
    this.sealReplayStream(session)
    for (const [toolUseId, r] of replay.pendingToolResults) {
      pushReplayToolResult(replay, toolUseId, r.content, r.isError)
    }
    replay.pendingToolResults.clear()
    session.replay = undefined
    if (!replay.messages.length) return
    log('kimi', `history replay: ${replay.messages.length} messages session=${session.id}`)
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'history',
      messages: replay.messages
    } as unknown as SDKMessage)
  }

  /** 注册完成后回放该 acpSessionId 在竞争窗口里缓冲的通知（到达顺序）。
   *  先删再逐条走正常逻辑，重入安全、不会重复。 */
  private flushPendingNotifications(acpSessionId: string): void {
    const pending = this.pendingNotifications.get(acpSessionId)
    if (!pending?.length) return
    this.pendingNotifications.delete(acpSessionId)
    for (const msg of pending) this.handleNotification(msg)
  }

  private handleSessionUpdate(session: ActiveKimiSession, update: Record<string, unknown>): void {
    const type = asString(update.sessionUpdate)
    this.touchTurnActivity(session)
    // #49：plan 是会话级全量待办状态，隐藏轮（afterTurn 的 /usage、/mcp 轮）期间
    // 后台子代理收尾推送的 plan 帧也要照常转发——吞掉后无任何补偿重拉，
    // 待办卡会一直停在旧快照。故放在 hiddenTurn 吞事件检查之前。
    if (type === 'plan') {
      // 待办清单（kimi 在计划模式下全量推送 entries），合成 system/plan 消息
      // 走 onMessage 通道送到渲染层（同 slash_commands 的模式）。
      this.h.onMessage(session.id, {
        type: 'system',
        subtype: 'plan',
        entries: toPlanEntries(update.entries)
      } as unknown as SDKMessage)
      return
    }
    // 隐藏轮：吞掉该轮所有事件，只累积 agent_message_chunk 文本供解析。
    if (session.hiddenTurn) {
      if (type === 'agent_message_chunk') session.hiddenText += textFromContentBlock(update.content)
      return
    }
    if (type === 'agent_message_chunk') {
      const text = textFromContentBlock(update.content)
      if (!text) return
      // 查询轮（/usage、/status、/mcp 标记）：累积不转发，turn 结束经
      // system/query_result 状态卡推送。
      if (session.queryTurn) {
        session.queryText += text
        return
      }
      // 压缩轮（/compact 标记；或自动压缩：chunk 文本出现压缩标记即检出并置位，
      // 后续 chunk 一并吞掉）：累积不转发，turn 结束经 system/compaction 推送。
      if (session.compactTurn || isCompactionText(session.compactText + text)) {
        session.compactTurn = true
        session.compactText += text
        return
      }
      this.emitAssistantDelta(session, asString(update.messageId), text)
      return
    }
    if (type === 'agent_thought_chunk') {
      const text = textFromContentBlock(update.content)
      if (text) this.emitThinking(session, text)
      return
    }
    if (type === 'tool_call') {
      const toolUseId = asString(update.toolCallId) ?? cryptoId()
      session.turnHadToolCall = true
      // 工具调用是独立的 assistant 消息；先封停当前流式消息（思考/正文），
      // 否则渲染层会把工具卡覆盖到正在流式的那条消息上。
      this.sealStreamMessage(session)
      this.emitToolUse(session, toolUseId, toolName(update), toolInput(update))
      return
    }
    if (type === 'tool_call_update') {
      const toolUseId = asString(update.toolCallId)
      if (!toolUseId) return
      const status = asString(update.status)
      if (status === 'completed' || status === 'failed') {
        if (session.toolResults.has(toolUseId)) return
        session.toolResults.add(toolUseId)
        this.emitToolResult(
          session,
          toolUseId,
          stringifyToolResult(update.rawOutput ?? update.content ?? update.title ?? status),
          status === 'failed'
        )
        return
      }
      // in_progress 等中间态：转发流式内容（子代理输出等），partial 标记让
      // 渲染层保持 running 状态、只更新卡片内容。rawInput（后台任务标记
      //  run_in_background 在这里才到）一并下传，渲染层合并进 block.input。
      let partialText = stringifyToolResult(update.rawOutput ?? update.content)
      const rawInput = asRecord(update.rawInput)
      // #30：输入未闭合时 kimi 把"工具输入 JSON 的累积快照"当 in_progress
      // content 逐字推流（{"command":"… 不断增长）——这是输入不是输出，不当
      // 卡片正文渲染。但快照里已拼出的 command/description 正是摘要要等的
      // 信息（#40：权限等待/输入流式期间摘要不能一直停"准备执行…"），抢救
      // 出来按 rawInput 同款合并下传。真正的输出从不在输入闭合前到达，闭合
      // 后的 update 带 rawInput 走正常合并，completed 再带全量输出。
      if (!rawInput && partialText.trimStart().startsWith('{')) {
        const salvaged = salvageStreamingInput(partialText)
        if (salvaged) this.emitToolPartial(session, toolUseId, '', salvaged)
        return
      }
      // #30 残留：闭合瞬间的 update 把完整输入快照当 content 带来（与 rawInput
      // 同文），不是输出——不下传，否则 running 卡片正文显示整段输入 JSON。
      if (rawInput && partialText === JSON.stringify(rawInput)) partialText = ''
      if (partialText || rawInput) this.emitToolPartial(session, toolUseId, partialText, rawInput ?? undefined)
      return
    }
    if (type === 'available_commands_update') {
      session.skills = toSkillInfos(update.availableCommands)
      this.emitSlashCommands(session)
      return
    }
    if (type === 'usage_update') {
      // 实测 kimi 0.26.0 不发送 usage_update（936 条 session/update 中零条）；
      // 解析保留以便未来版本上报时直接可用。形状防御：字段可能在 update.usage
      // 下，也可能平铺在 update 上（ACP 规范的 used/size）。
      const usage = asRecord(update.usage) ?? update
      session.lastUsage = {
        inputTokens: asNumber(usage.inputTokens),
        outputTokens: asNumber(usage.outputTokens),
        totalTokens: asNumber(usage.totalTokens),
        contextUsed: asNumber(usage.used),
        contextSize: asNumber(usage.size)
      }
    }
    // TODO: 'config_option_update' 暂不映射到 UI。
  }

  private handleServerRequest(msg: AcpRpcMessage): void {
    const method = msg.method ?? ''
    const params = asRecord(msg.params) ?? {}
    if (msg.id === undefined) return
    const client = this.client
    if (!client) return
    // #41 权限/fs 请求也是该会话的活动（权限等待不算无响应）：重置静默计时。
    const session = this.sessionForAcp(asString(params.sessionId))
    if (session) this.touchTurnActivity(session)
    if (method === 'session/request_permission') {
      this.handlePermissionRequest(client, msg.id, params)
      return
    }
    if (method === 'fs/read_text_file') {
      const path = asString(params.path)
      if (!path) {
        client.respondError(msg.id, 'path is required')
        return
      }
      try {
        client.respond(msg.id, { content: readFileSlice(path, asNumber(params.line), asNumber(params.limit)) })
      } catch (error) {
        client.respondError(msg.id, error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (method === 'fs/write_text_file') {
      const path = asString(params.path)
      if (!path) {
        client.respondError(msg.id, 'path is required')
        return
      }
      try {
        writeFileSync(path, asString(params.content) ?? '', 'utf8')
        client.respond(msg.id, {})
      } catch (error) {
        client.respondError(msg.id, error instanceof Error ? error.message : String(error))
      }
      return
    }
    client.respondError(msg.id, `Tran does not handle Kimi ACP request: ${method}`, -32601)
  }

  private handlePermissionRequest(
    client: AcpClient,
    requestId: AcpRpcId,
    params: Record<string, unknown>
  ): void {
    const toolCall = asRecord(params.toolCall) ?? {}
    const toolUseID = `kimi-${String(requestId)}`
    const options = Array.isArray(params.options)
      ? params.options.filter((option): option is Record<string, unknown> => !!asRecord(option))
      : []
    // #41 转入"等用户"状态：权限/elicitation 等待期间静默监督暂停（作答后复位）。
    const session = this.sessionForAcp(asString(params.sessionId))
    if (session) session.waitingOnUser = true
    // AskUserQuestion：走 elicitation 通道（区别于工具审批）——问题+选项原样
    // 经 system/elicitation 推渲染层，回答时原样返回 optionId。
    if (asString(toolCall.title) === 'AskUserQuestion') {
      this.pendingPermissions.set(toolUseID, {
        client,
        requestId,
        options,
        elicitation: true,
        ...(session ? { sessionId: session.id } : {})
      })
      const choices = options
        .map((option) => {
          const optionId = asString(option.optionId)
          if (!optionId) return null
          return {
            optionId,
            name: asString(option.name) ?? optionId,
            ...(asString(option.kind) ? { kind: asString(option.kind)! } : {})
          }
        })
        .filter((option): option is NonNullable<typeof option> => !!option)
      if (session) {
        this.h.onMessage(session.id, {
          type: 'system',
          subtype: 'elicitation',
          elicitation: {
            toolUseID,
            question: elicitationQuestion(toolCall),
            options: choices,
            // multiSelect 尽量从 toolCall 解析（content/input 里的布尔标记），
            // 解析不到按单选（渲染层 radio 式）。
            ...(elicitationMultiSelect(toolCall) ? { multiSelect: true } : {})
          }
        } as unknown as SDKMessage)
      }
      return
    }
    this.pendingPermissions.set(toolUseID, { client, requestId, options, ...(session ? { sessionId: session.id } : {}) })
    this.h.onPermissionRequest({
      toolUseID,
      toolName: toolName(toolCall),
      input: toolInput(toolCall),
      decisionReason: asString(toolCall.title) ?? undefined
    } satisfies PermissionRequestPayload)
  }

  /** 退出前释放后端级资源：kill ACP 子进程并停掉所有定时器。 */
  dispose(): void {
    for (const session of this.sessions.values()) {
      this.disarmStallWatch(session)
    }
    const client = this.client
    this.client = null
    this.clientPromise = null
    try {
      client?.close()
    } catch {
      /* 退出路径尽力而为 */
    }
    this.sessions.clear()
    this.acpToSession.clear()
    this.pendingPermissions.clear()
    this.pendingNotifications.clear()
  }

  private handleClientClose(error?: string): void {
    this.client = null
    this.clientPromise = null
    for (const session of this.sessions.values()) {
      // 先停掉本会话的 stall 定时器：只清 sessions 的话，定时器要等下一次
      // 60s tick 自检才会自拆，这段时间里是空转的残火。
      this.disarmStallWatch(session)
      this.h.onEnded(session.id, error)
    }
    this.sessions.clear()
    this.acpToSession.clear()
    this.pendingPermissions.clear()
    this.pendingNotifications.clear()
  }

  private emitInit(session: ActiveKimiSession, acpSessionId: string, model: string): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'init',
      session_id: acpSessionId,
      cwd: session.cwd,
      model,
      permissionMode: session.permissionMode ?? 'default',
      tools: ['shell', 'read_file', 'write_file', 'patch', 'search', 'mcp']
    } as unknown as SDKMessage)
  }

  private emitAssistantDelta(session: ActiveKimiSession, messageId: string | undefined, delta: string): void {
    this.ensureStreamMessage(session, messageId)
    if (session.textBlockIndex === null) {
      session.textBlockIndex = session.nextBlockIndex++
      this.emitStreamEvent(session, {
        type: 'content_block_start',
        index: session.textBlockIndex,
        content_block: { type: 'text', text: '' }
      })
    }
    session.streamedText += delta
    this.emitStreamEvent(session, {
      type: 'content_block_delta',
      index: session.textBlockIndex,
      delta: { type: 'text_delta', text: delta }
    })
  }

  /** 思考流累积：与正文同款流式模式——首个 thought chunk 在当前消息里开
   *  thinking content block，后续 chunk 以 thinking_delta 追加到同一 block，
   *  封停时连同正文一起以最终 assistant 消息定稿（渲染层只渲染一个思考块）。
   *  content 结构防御式解析见 textFromContentBlock。 */
  private emitThinking(session: ActiveKimiSession, text: string): void {
    this.ensureStreamMessage(session, undefined)
    if (session.thinkingBlockIndex === null) {
      session.thinkingBlockIndex = session.nextBlockIndex++
      this.emitStreamEvent(session, {
        type: 'content_block_start',
        index: session.thinkingBlockIndex,
        content_block: { type: 'thinking', thinking: '' }
      })
    }
    session.thinkingText += text
    this.emitStreamEvent(session, {
      type: 'content_block_delta',
      index: session.thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking: text }
    })
  }

  private ensureStreamMessage(session: ActiveKimiSession, messageId: string | undefined): void {
    if (session.streamStarted) return
    session.streamStarted = true
    session.currentMessageId = messageId ?? `kimi-message-${cryptoId()}`
    this.emitStreamEvent(session, { type: 'message_start', message: { id: session.currentMessageId } })
  }

  /** 封停当前流式消息：补 content_block_stop，把累积的思考+正文以最终
   *  assistant 消息定稿（替换渲染层的流式 item），然后重置流式状态——
   *  后续 chunk / tool_call 会开新消息，互不覆盖。 */
  private sealStreamMessage(session: ActiveKimiSession): void {
    if (!session.streamStarted) return
    if (session.thinkingBlockIndex !== null) {
      this.emitStreamEvent(session, { type: 'content_block_stop', index: session.thinkingBlockIndex })
    }
    if (session.textBlockIndex !== null) {
      this.emitStreamEvent(session, { type: 'content_block_stop', index: session.textBlockIndex })
    }
    const content: Array<Record<string, unknown>> = []
    if (session.thinkingText) content.push({ type: 'thinking', thinking: session.thinkingText })
    // goal 激活时：最终消息剥掉末尾的 GOAL_STATUS 状态行（流式期间短暂可见可接受）。
    const displayText =
      getGoal(session.id)?.status === 'active'
        ? stripGoalStatusLine(session.streamedText)
        : session.streamedText
    if (displayText) content.push({ type: 'text', text: displayText })
    if (content.length) this.emitAssistant(session, session.currentMessageId ?? cryptoId(), content)
    session.streamStarted = false
    session.currentMessageId = undefined
    session.streamedText = ''
    session.thinkingText = ''
    session.textBlockIndex = null
    session.thinkingBlockIndex = null
    session.nextBlockIndex = 0
  }

  /** Kimi 在 session/new 后推送的斜杠命令（available_commands_update）——
   *  经 system/slash_commands 消息送到渲染层，供 Composer 的 `/` 菜单使用。 */
  private emitSlashCommands(session: ActiveKimiSession): void {
    log('kimi', `slash commands x${session.skills.length}`)
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'slash_commands',
      commands: session.skills
    } as unknown as SDKMessage)
  }

  private emitStreamEvent(session: ActiveKimiSession, event: Record<string, unknown>): void {
    this.h.onMessage(session.id, {
      type: 'stream_event',
      uuid: `kimi-stream-${session.currentMessageId ?? cryptoId()}`,
      parent_tool_use_id: null,
      event
    } as unknown as SDKMessage)
  }

  private emitAssistant(session: ActiveKimiSession, itemId: string, content: Array<Record<string, unknown>>): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `kimi-assistant-${itemId}`,
      parent_tool_use_id: null,
      message: {
        id: itemId,
        content
      }
    } as unknown as SDKMessage)
  }

  private emitToolUse(
    session: ActiveKimiSession,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>
  ): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `kimi-tool-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        id: `kimi-tool-message-${toolUseId}`,
        content: [{ type: 'tool_use', id: toolUseId, name, input }]
      }
    } as unknown as SDKMessage)
  }

  private emitToolResult(
    session: ActiveKimiSession,
    toolUseId: string,
    content: string,
    isError: boolean
  ): void {
    this.h.onMessage(session.id, {
      type: 'user',
      uuid: `kimi-tool-result-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
      }
    } as unknown as SDKMessage)
  }

  /** 工具执行中的流式中间内容（如子代理输出）：partial=true，渲染层只更新
   *  卡片内容、不翻完成态。rawInput 可能在此刻才到达（后台任务标记），随包下传。 */
  private emitToolPartial(
    session: ActiveKimiSession,
    toolUseId: string,
    content: string,
    input?: Record<string, unknown>
  ): void {
    this.h.onMessage(session.id, {
      type: 'user',
      uuid: `kimi-tool-partial-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false, partial: true, ...(input ? { input } : {}) }]
      }
    } as unknown as SDKMessage)
  }

  private emitResult(
    session: ActiveKimiSession,
    result: {
      subtype: 'success' | 'error'
      error?: string
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
  ): void {
    const usage = result.inputTokens || result.outputTokens
      ? result
      : session.lastUsage
    this.h.onMessage(session.id, {
      type: 'result',
      total_cost_usd: 0,
      num_turns: session.turn,
      usage: {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_read_input_tokens: null
      },
      stop_reason: null,
      subtype: result.subtype,
      ...(result.error ? { errors: [result.error] } : {})
    } as unknown as SDKMessage)
  }

  private sessionForAcp(acpSessionId: string | undefined): ActiveKimiSession | null {
    if (!acpSessionId) return null
    const sessionId = this.acpToSession.get(acpSessionId)
    return sessionId ? (this.sessions.get(sessionId) ?? null) : null
  }

  private requireSession(sessionId: string): ActiveKimiSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)
    return session
  }
}

/** 取用户消息的首段纯文本（作为会话标题兜底；附件块跳过）。 */
function firstUserText(content: string | unknown[]): string {
  if (typeof content === 'string') return content
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null
    if (b?.type === 'text' && b.text) return b.text
  }
  return ''
}

/** GOAL_STATUS 状态行匹配（大小写不敏感，容许 `…`/**…** 等 markdown 行内形式）。 */
const GOAL_STATUS_LINE_RE = /^[*`>\s]*GOAL_STATUS\s*:\s*(continue|complete|blocked)\b\s*:?\s*([^`*]*?)\s*[`*]*$/i

/** 解析本轮最终文本最后一行的 GOAL_STATUS 状态行（goal 循环的终止协议——
 *  ACP 没有 UpdateGoal 工具，用文本行替代）。 */
function parseGoalStatus(text: string): { action: 'continue' | 'complete' | 'blocked'; reason?: string } | null {
  const lines = text.trimEnd().split('\n')
  const last = lines[lines.length - 1]?.trim()
  if (!last) return null
  const match = last.match(GOAL_STATUS_LINE_RE)
  if (!match) return null
  const action = match[1].toLowerCase() as 'continue' | 'complete' | 'blocked'
  const reason = match[2]?.trim()
  return { action, ...(reason ? { reason } : {}) }
}

/** 从最终展示文本里剥掉末尾的 GOAL_STATUS 状态行（流式期间短暂可见可接受）。 */
function stripGoalStatusLine(text: string): string {
  const lines = text.trimEnd().split('\n')
  if (lines.length && GOAL_STATUS_LINE_RE.test(lines[lines.length - 1].trim())) {
    return lines.slice(0, -1).join('\n').trimEnd()
  }
  return text
}

/** 改写的官方 active-reminder：untrusted_objective 防注入 + 状态/进度行 +
 *  预算纪律 + 文本状态行协议（替代官方 UpdateGoal 工具调用）。 */
function buildGoalReminder(goal: GoalInfo): string {
  return [
    `<untrusted_objective>${goal.objective}</untrusted_objective>`,
    ...(goal.completionCriterion ? [`完成判据：${goal.completionCriterion}`] : []),
    `Status: ${goal.status} · Progress: turn ${goal.turnCount}/${goal.maxTurns}`,
    '纪律：每轮只推进一个小切片，不要试图一轮全部做完；证据不足不要宣告完成；同一阻塞连续 3 轮才允许宣告 blocked。',
    '在回复的最后一行输出状态行（不要省略）：GOAL_STATUS: continue / GOAL_STATUS: complete / GOAL_STATUS: blocked: <原因>'
  ].join('\n')
}

/** 往重放累积器追加一条 tool_result 用户消息（HistoryMessage 形状）。 */
function pushReplayToolResult(
  replay: ReplayAccumulator,
  toolUseId: string,
  content: string,
  isError: boolean
): void {
  replay.messages.push({
    type: 'user',
    uuid: `kimi-replay-${cryptoId()}`,
    session_id: replay.sessionId,
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
    },
    parent_tool_use_id: null
  })
}

/** 压缩文本检出：kimi 宿主直返的压缩提示（/compact 或自动压缩）。 */
function isCompactionText(text: string): boolean {
  return text.includes('Compacting conversation context') || text.includes('Compaction completed')
}

/** "查询类"斜杠命令（输出是状态信息、不该以普通对话形式出现）：命中返回
 *  规范化命令名，否则 null。/compact 走压缩轮通道，不在此列。 */
function queryCommandOf(text: string): string | null {
  const match = text.match(/^\/(usage|status|mcp)\b/)
  return match ? `/${match[1]}` : null
}

/** /mcp 状态词 → 面板状态枚举（未知词按 pending，连接中会由补查修正）。 */
function mcpStatusKind(raw: string): McpServerStatusKind {
  const s = raw.toLowerCase()
  if (s === 'connected') return 'connected'
  if (s === 'failed' || s === 'error') return 'failed'
  if (s === 'disabled') return 'disabled'
  if (s === 'needs-auth' || s === 'needsauth') return 'needs-auth'
  return 'pending'
}

/** 解析 /mcp 隐藏轮文本（kimi 宿主直返，实测 0.29）：
 *  `MCP servers (1):` + `- yuque: connected (stdio, 19 tools)`。
 *  配置了 0 个 server 时返回 []；文本完全不像 /mcp 输出（出错/格式变化）
 *  返回 null——不推渲染层，状态区保持无数据而非误显示空。 */
function parseMcpServers(text: string): McpServerEntry[] | null {
  if (!/MCP servers?/i.test(text)) return null
  const servers: McpServerEntry[] = []
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^[-•]\s*(.+?):\s*([A-Za-z][\w-]*)(?:\s*\(([^)]*)\))?\s*$/)
    if (!match) continue
    const detail = match[3] ?? ''
    const transport = detail.match(/stdio|http|sse/i)?.[0]?.toLowerCase()
    const toolCount = Number(detail.match(/(\d+)\s*tools?/i)?.[1])
    servers.push({
      name: match[1].trim(),
      status: mcpStatusKind(match[2]),
      ...(transport ? { config: { type: transport } } : {}),
      ...(Number.isFinite(toolCount) ? { toolCount } : {})
    })
  }
  return servers
}

/** 解析压缩统计：`Messages compacted: 16` / `Tokens before: 1,906` / `Tokens after: 782`。 */
function parseCompaction(text: string): {
  messagesCompacted?: number
  tokensBefore?: number
  tokensAfter?: number
} {
  const num = (pattern: RegExp): number | undefined => {
    const match = text.match(pattern)
    if (!match) return undefined
    const value = Number(match[1].replace(/,/g, ''))
    return Number.isFinite(value) ? value : undefined
  }
  return {
    ...(num(/Messages compacted:\s*(\d+)/) !== undefined
      ? { messagesCompacted: num(/Messages compacted:\s*(\d+)/) }
      : {}),
    ...(num(/Tokens before:\s*([\d,]+)/) !== undefined
      ? { tokensBefore: num(/Tokens before:\s*([\d,]+)/) }
      : {}),
    ...(num(/Tokens after:\s*([\d,]+)/) !== undefined
      ? { tokensAfter: num(/Tokens after:\s*([\d,]+)/) }
      : {})
  }
}

/** AskUserQuestion 的问题文本：toolCall.content[].content.text 防御式下钻。 */
function elicitationQuestion(toolCall: Record<string, unknown>): string {
  const content = toolCall.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const record = asRecord(item)
      const text = asString(asRecord(record?.content)?.text) ?? asString(record?.text)
      if (text) return text
    }
  }
  return asString(toolCall.title) ?? ''
}

/** multiSelect 标记的防御式解析：toolCall 及其 content/input 嵌套里找
 *  multiSelect / multi_select 布尔（找不到按单选）。 */
function elicitationMultiSelect(toolCall: Record<string, unknown>): boolean {
  const seen = new Set<unknown>()
  const walk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.some((item) => walk(item, depth + 1))
    const record = value as Record<string, unknown>
    if (record.multiSelect === true || record.multi_select === true) return true
    return Object.values(record).some((item) => walk(item, depth + 1))
  }
  return walk(toolCall.content, 0) || walk(toolCall.rawInput, 0)
}

/** usedText（"45.6k"/"1.2M"/"782"）换算成数值。 */
function parseUsedText(text: string): number | undefined {
  const match = text.trim().match(/^([\d.,]+)\s*([kKmM]?)$/)
  if (!match) return undefined
  const base = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(base)) return undefined
  const suffix = match[2].toLowerCase()
  return suffix === 'k' ? base * 1000 : suffix === 'm' ? base * 1_000_000 : base
}

/** 解析 /usage 隐藏轮文本：
 *  `- Context: 45.6k / 1,048,576 (5.0%)` → usedText/total/pct
 *  `- Total: input 6,465, output 1,911, cache read 199,168` → 会话 token（可选） */
function parseContextUsage(text: string): ContextUsage | null {
  const match = text.match(/Context:\s*([\d.,a-zA-Z]+)\s*\/\s*([\d,]+)\s*\(\s*([\d.]+)\s*%\)/)
  if (!match) return null
  const total = Number(match[2].replace(/,/g, ''))
  const pct = Number(match[3])
  const used = parseUsedText(match[1])
  if (!Number.isFinite(total) || !Number.isFinite(pct) || used === undefined) return null
  const usage: ContextUsage = { usedText: match[1], used, total, pct }
  const totalMatch = text.match(/Total:\s*input\s*([\d,]+),\s*output\s*([\d,]+),\s*cache read\s*([\d,]+)/i)
  if (totalMatch) {
    const parse = (v: string): number | undefined => {
      const n = Number(v.replace(/,/g, ''))
      return Number.isFinite(n) ? n : undefined
    }
    const inputTokens = parse(totalMatch[1])
    const outputTokens = parse(totalMatch[2])
    const cacheReadTokens = parse(totalMatch[3])
    if (inputTokens !== undefined) usage.inputTokens = inputTokens
    if (outputTokens !== undefined) usage.outputTokens = outputTokens
    if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
  }
  return usage
}

function contentToPrompt(content: string | unknown[]): PromptPayload {
  if (typeof content === 'string') {
    return { prompt: [{ type: 'text', text: content }] }
  }
  const prompt: Array<Record<string, unknown>> = []
  const text: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as {
      type?: string
      text?: string
      source?: { type?: string; media_type?: string; data?: string }
    }
    if (typed.type === 'text' && typed.text) text.push(typed.text)
    if (typed.type === 'image' && typed.source?.type === 'base64' && typed.source.data) {
      prompt.push({
        type: 'image',
        data: typed.source.data,
        mimeType: typed.source.media_type ?? 'image/png'
      })
    }
  }
  if (text.length) prompt.unshift({ type: 'text', text: text.join('\n') })
  if (!prompt.length) prompt.push({ type: 'text', text: '' })
  return { prompt }
}

/** Kimi 的真实模式（session/new configOptions.mode 实测）：default / plan /
 *  auto / yolo。原样直通，未知值回落 default。 */
function kimiMode(mode: string | undefined): string {
  if (mode === 'plan' || mode === 'auto' || mode === 'yolo') return mode
  return 'default'
}

function kimiModel(model: string | undefined): string | undefined {
  if (!model || model === DEFAULT_KIMI_MODEL_ID) return undefined
  return model
}

/** 上下文窗口上限（实测 /usage 分母）：k3 / kimi-for-coding 系列均 1,048,576，
 *  未知模型回落 1M。 */
const KIMI_CONTEXT_WINDOWS: Record<string, number> = {
  'kimi-code/k3': 1_048_576,
  'kimi-code/kimi-for-coding': 1_048_576,
  'kimi-code/kimi-for-coding-highspeed': 1_048_576
}
const DEFAULT_KIMI_CONTEXT_WINDOW = 1_048_576

function contextWindowForModel(model: string | undefined): number {
  return (model ? KIMI_CONTEXT_WINDOWS[model] : undefined) ?? DEFAULT_KIMI_CONTEXT_WINDOW
}

function readFileSlice(path: string, line?: number, limit?: number): string {
  const text = readFileSync(path, 'utf8')
  if (!line && !limit) return text
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit && limit > 0 ? start + limit : undefined
  return lines.slice(start, end).join('\n')
}

function permissionOptionId(options: Array<Record<string, unknown>>, behavior: 'allow' | 'deny'): string | null {
  const entries = options
    .map((option) => ({
      id: asString(option.optionId) ?? asString(option.option_id),
      kind: asString(option.kind)
    }))
    .filter((entry): entry is { id: string; kind: string | undefined } => !!entry.id)
  // kimi 实测：optionId 是 approve_once/approve_always/reject，语义在 kind 字段
  // （allow_once/allow_always/reject_once）——优先按 kind 匹配，optionId 做兜底。
  if (behavior === 'allow') {
    const hit =
      entries.find((e) => e.kind === 'allow_once') ??
      entries.find((e) => e.kind?.startsWith('allow')) ??
      entries.find((e) => e.id.startsWith('allow') || e.id.startsWith('approve'))
    return hit?.id ?? null
  }
  const hit =
    entries.find((e) => e.kind?.startsWith('reject')) ??
    entries.find((e) => e.id === 'deny' || e.id.startsWith('reject'))
  return hit?.id ?? null
}

function textFromContentBlock(value: unknown): string {
  const block = asRecord(value)
  if (!block) return ''
  if (block.type === 'text') return asString(block.text) ?? ''
  return stringifyToolResult(block)
}

function toolName(update: Record<string, unknown>): string {
  const rawInput = asRecord(update.rawInput)
  const title = asString(update.title)
  const kind = asString(update.kind)
  if (rawInput?.command) return 'terminal'
  if (kind === 'edit') return 'patch'
  if (kind === 'read') return 'read_file'
  return title?.split(/\s+/)[0]?.replace(/[^\w.-]/g, '') || kind || 'tool'
}

function toolInput(update: Record<string, unknown>): Record<string, unknown> {
  const raw = asRecord(update.rawInput)
  if (raw) return raw
  const title = asString(update.title)
  const content = update.content
  return {
    ...(title ? { title } : {}),
    ...(content ? { content } : {})
  }
}

/** ACP plan 条目的防御式解析：每项取 content/status(/priority/activeForm)，
 *  status 非三态时归一为 pending。 */
function toPlanEntries(value: unknown): Array<{
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: string
  activeForm?: string
}> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const entry = asRecord(item)
      const content = asString(entry?.content)
      if (!content) return null
      const rawStatus = asString(entry?.status)
      const status: 'pending' | 'in_progress' | 'completed' =
        rawStatus === 'in_progress' || rawStatus === 'completed' ? rawStatus : 'pending'
      const priority = asString(entry?.priority)
      const activeForm = asString(entry?.activeForm)
      return {
        content,
        status,
        ...(priority ? { priority } : {}),
        ...(activeForm ? { activeForm } : {})
      }
    })
    .filter((item): item is NonNullable<typeof item> => !!item)
}

function toSkillInfos(value: unknown): SkillInfo[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): SkillInfo | null => {
      const command = asRecord(item)
      const name = asString(command?.name)
      if (!name) return null
      const argumentHint = asString(asRecord(command?.input)?.hint)
      return {
        name,
        description: asString(command?.description) ?? name,
        ...(argumentHint ? { argumentHint } : {})
      }
    })
    .filter((item): item is SkillInfo => !!item)
}

function stringifyToolResult(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyToolContentItem(item)).filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringifyToolContentItem(value: unknown): string {
  const item = asRecord(value)
  if (!item) return typeof value === 'string' ? value : ''
  if (item.type === 'content') return textFromContentBlock(item.content)
  if (item.type === 'terminal') return asString(item.command) ?? asString(item.output) ?? ''
  if (item.type === 'diff') return asString(item.diff) ?? ''
  return asString(item.text) ?? asString(item.title) ?? ''
}

/** #40 从流式输入 JSON 快照残片里抢救已拼出的 command/description（卡片摘要用）。
 *  快照是 truncated JSON（字符串值可能未闭合），不做整体 parse，逐字段正则提取；
 *  残片恰好在转义符中间断开时剥掉孤立反斜杠再试，仍失败则放弃该字段。 */
function salvageStreamingInput(snapshot: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {}
  for (const key of ['command', 'description']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(snapshot)
    if (!m || !m[1]) continue
    const raw = m[1]
    try {
      out[key] = JSON.parse(`"${raw}"`) as string
    } catch {
      try {
        out[key] = JSON.parse(`"${raw.replace(/\\+$/, '')}"`) as string
      } catch {
        /* 残片无法修复：跳过该字段，等下一条更长的快照 */
      }
    }
  }
  return Object.keys(out).length ? out : null
}

function mergeComposerModels(...groups: ComposerModel[][]): ComposerModel[] {
  const seen = new Set<string>()
  const merged: ComposerModel[] = []
  for (const group of groups) {
    for (const model of group) {
      const id = model.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      merged.push({ id, label: model.label.trim() || id })
    }
  }
  return merged
}

/** Flatten the `model` select out of a session/new|load configOptions array.
 *  Tolerates both flat { value, name } options and one level of grouped
 *  { name, options: [...] } nesting. */
function modelOptionsFromConfig(value: unknown): ComposerModel[] {
  if (!Array.isArray(value)) return []
  for (const entry of value) {
    const option = asRecord(entry)
    if (!option || asString(option.id) !== 'model') continue
    const rawOptions = Array.isArray(option.options) ? option.options : []
    const models: ComposerModel[] = []
    const push = (item: unknown): void => {
      const record = asRecord(item)
      if (!record) return
      const id = asString(record.value) ?? asString(record.id)
      if (!id) return
      models.push({ id, label: asString(record.name) ?? asString(record.label) ?? id })
    }
    for (const item of rawOptions) {
      const nested = asRecord(item)?.options
      if (Array.isArray(nested)) nested.forEach(push)
      else push(item)
    }
    if (models.length) return models
  }
  return []
}

function currentConfigValue(configOptions: unknown, configId: string): string | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const entry of configOptions) {
    const option = asRecord(entry)
    if (!option || asString(option.id) !== configId) continue
    return asString(option.currentValue) ?? asString(option.value)
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function cryptoId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'kimi-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
