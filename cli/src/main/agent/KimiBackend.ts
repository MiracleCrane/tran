import { readFileSync, writeFileSync } from 'node:fs'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
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
  /** AI 命名：本运行内是否已触发过自动生成（每会话至多一次，控制 token 成本）。 */
  aiTitleRequested: boolean
}

interface PendingPermission {
  client: AcpClient
  requestId: AcpRpcId
  options: Array<Record<string, unknown>>
  /** AskUserQuestion（elicitation）：回传用户点选的原样 optionId，不走模糊匹配。 */
  elicitation?: boolean
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

/** Map ACP/JSON-RPC failures to user-facing text. authRequired (-32000) means
 *  the Kimi CLI has no usable token — the fix is a terminal `kimi login`. */
function userFacingError(error: unknown): string {
  if (error instanceof AcpRequestError && error.code === -32000) return KIMI_AUTH_HINT
  const message = error instanceof Error ? error.message : String(error)
  return /auth(entication)? (is )?required/i.test(message) ? KIMI_AUTH_HINT : message
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
      aiTitleRequested: false
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

  /** 空壳治理：本次运行由 Tran 新建（非 resume）且从未收到真实用户 prompt 的
   *  会话，在离开（切对话/切项目/退出）时删除并清掉本地标题记录。
   *  删除失败只记日志、不阻塞导航。 */
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

  // TODO(kimi-mcp): 接入 Kimi 的 MCP 配置（session/new 的 mcpServers 转发已获
  // ACP 支持）；目前 UI 的 MCP 面板入口已隐藏，这里先返回空列表。
  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    return []
  }

  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.listMcpServers(sessionId)
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
        response = await client.request<Record<string, unknown>>('session/load', {
          cwd: session.cwd,
          sessionId: opts.resume,
          mcpServers: []
        }, 120000)
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
    // 会话打开即刷新上下文用量（session/new、session/load 各一次；有轮在跑
    // 则 turn 末的 afterTurn 会补，这里只在空转时触发，保持串行）。
    if (!session.closed && !session.running && session.queue.length === 0) {
      void this.runHiddenUsageTurn(session)
    }
  }

  private rememberConfigOptions(value: unknown): void {
    const models = modelOptionsFromConfig(value)
    if (models.length) this.discoveredModels = models
  }

  private async drain(session: ActiveKimiSession): Promise<void> {
    if (session.running || session.closed) return
    const next = session.queue.shift()
    if (!next) return
    session.running = true
    session.turn += 1
    session.turnHadToolCall = false
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
   *  清除——kimi 侧 FIFO，用户轮排在隐藏轮之后，其事件到达时标志已清。 */
  private async runHiddenUsageTurn(session: ActiveKimiSession): Promise<void> {
    if (session.closed || !session.acpSessionId || session.hiddenTurn) return
    session.hiddenTurn = true
    session.hiddenText = ''
    try {
      const client = await this.ensureClient()
      await client.request('session/prompt', {
        sessionId: session.acpSessionId,
        prompt: [{ type: 'text', text: '/usage' }],
        messageId: cryptoId()
      }, 60000)
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
    }
  }

  /** 渲染层悬停上下文环触发的即时刷新：无轮直接跑，有轮标记 pending 轮末补。 */
  async requestUsageRefresh(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    if (session.hiddenTurn) {
      session.usageRefreshPending = true
      return
    }
    void this.runHiddenUsageTurn(session)
  }

  private async runTurn(session: ActiveKimiSession, message: QueuedMessage): Promise<void> {
    if (!session.acpSessionId) throw new Error('Kimi session is not ready.')
    // 侧栏标题兜底：kimi 对未命名会话只回 "New Session"，用首条用户消息补。
    recordSessionTitle(session.acpSessionId, firstUserText(message.content))
    // 压缩轮标记：/compact（含参数形式）——该轮压缩文本不渲染，结束统一解析。
    if (firstUserText(message.content).trimStart().startsWith('/compact')) {
      session.compactTurn = true
    }
    const client = await this.ensureClient()
    const payload = contentToPrompt(message.content)
    const response = await client.request<Record<string, unknown>>('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: payload.prompt,
      messageId: cryptoId()
    }, 900000)
    // goal 循环终止判定用：封停前捕获本轮最终正文。
    session.lastTurnText = session.streamedText
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
    // AI 会话命名：Tran 新建会话的首个真实用户 turn 结束后触发一次（resume 的
    // 老会话不自动生成）。输入只给首条消息（截断 ~500 字符），单次调用
    // ≈100-200 token，失败静默回退原标题，不重试。
    if (session.createdViaNew && !session.aiTitleRequested && session.acpSessionId) {
      session.aiTitleRequested = true
      void generateAiTitle(session.acpSessionId, firstUserText(message.content)).then((title) => {
        if (title) this.h.onSessionsChanged?.()
      })
    }
  }

  private async ensureClient(): Promise<AcpClient> {
    if (this.client) return this.client
    if (!this.clientPromise) {
      const resolved = resolveWindowsKimiCommand()
      this.clientPromise = AcpClient.start({
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
      }).then((client) => {
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
    // 隐藏轮：吞掉该轮所有事件，只累积 agent_message_chunk 文本供解析。
    if (session.hiddenTurn) {
      if (type === 'agent_message_chunk') session.hiddenText += textFromContentBlock(update.content)
      return
    }
    if (type === 'agent_message_chunk') {
      const text = textFromContentBlock(update.content)
      if (!text) return
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
      const partialText = stringifyToolResult(update.rawOutput ?? update.content)
      const rawInput = asRecord(update.rawInput)
      if (partialText || rawInput) this.emitToolPartial(session, toolUseId, partialText, rawInput ?? undefined)
      return
    }
    if (type === 'available_commands_update') {
      session.skills = toSkillInfos(update.availableCommands)
      this.emitSlashCommands(session)
      return
    }
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
    // AskUserQuestion：走 elicitation 通道（区别于工具审批）——问题+选项原样
    // 经 system/elicitation 推渲染层，回答时原样返回 optionId。
    if (asString(toolCall.title) === 'AskUserQuestion') {
      this.pendingPermissions.set(toolUseID, { client, requestId, options, elicitation: true })
      const session = this.sessionForAcp(asString(params.sessionId))
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
    this.pendingPermissions.set(toolUseID, { client, requestId, options })
    this.h.onPermissionRequest({
      toolUseID,
      toolName: toolName(toolCall),
      input: toolInput(toolCall),
      decisionReason: asString(toolCall.title) ?? undefined
    } satisfies PermissionRequestPayload)
  }

  private handleClientClose(error?: string): void {
    this.client = null
    this.clientPromise = null
    for (const session of this.sessions.values()) {
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
