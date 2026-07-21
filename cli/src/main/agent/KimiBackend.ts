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
import { recordSessionTitle } from '../sessionTitles'
import { log } from '../logger'

interface QueuedMessage {
  content: string | unknown[]
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
}

interface PendingPermission {
  client: AcpClient
  requestId: AcpRpcId
  options: Array<Record<string, unknown>>
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
  total: number
  pct: number
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
      hiddenText: ''
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
    session.queue.push({ content })
    void this.drain(session)
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session?.acpSessionId) return
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
      this.acpToSession.delete(session.acpSessionId)
      this.pendingNotifications.delete(session.acpSessionId)
      // Kimi ACP 未实现 session/close —— 只取消当前 turn 并丢弃本地映射。
      this.client?.notify('session/cancel', { sessionId: session.acpSessionId })
    }
    this.sessions.delete(sessionId)
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
      // session/load 恢复会话并回放历史；回放产生的 session/update 通知在
      // replaying 窗口内被吞掉（UI 的历史预览走 getSessionMessages，ACP 侧
      // 暂无逐条消息读取 —— 见 main/kimiHistory.ts 的 TODO）。
      session.replaying = true
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
      }
    } else {
      response = await client.request<Record<string, unknown>>('session/new', {
        cwd: session.cwd,
        mcpServers: []
      }, 120000)
      const acpSessionId = asString(response?.sessionId)
      if (!acpSessionId) throw new Error('Kimi ACP did not return a session id.')
      session.acpSessionId = acpSessionId
      this.acpToSession.set(acpSessionId, session.id)
      // kimi 在 session/new 响应后立即推 available_commands_update 等通知，此时
      // 注册刚完成——把竞争窗口里缓冲的通知按序回放（见 handleNotification）。
      this.flushPendingNotifications(acpSessionId)
    }

    this.rememberConfigOptions(response?.configOptions)
    const model = currentConfigValue(response?.configOptions, 'model') ?? session.model ?? DEFAULT_KIMI_MODEL_ID
    session.model = kimiModel(model) ?? undefined
    if (session.permissionMode) {
      await this.setPermissionMode(session.id, session.permissionMode)
    }
    this.emitInit(session, session.acpSessionId ?? opts.resume ?? session.id, session.model ?? model)
    void this.drain(session)
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
    try {
      await session.ready
      await this.runTurn(session, next)
    } catch (error) {
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
      if (!session.closed && session.queue.length) void this.drain(session)
      // 正常 turn 完成且队列空了：发一个隐藏 /usage 轮更新上下文用量
      // （kimi 宿主直接返回、不调模型、零额度消耗）。
      else if (!session.closed) void this.runHiddenUsageTurn(session)
    }
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
    }
  }

  private async runTurn(session: ActiveKimiSession, message: QueuedMessage): Promise<void> {
    if (!session.acpSessionId) throw new Error('Kimi session is not ready.')
    // 侧栏标题兜底：kimi 对未命名会话只回 "New Session"，用首条用户消息补。
    recordSessionTitle(session.acpSessionId, firstUserText(message.content))
    const client = await this.ensureClient()
    const payload = contentToPrompt(message.content)
    const response = await client.request<Record<string, unknown>>('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: payload.prompt,
      messageId: cryptoId()
    }, 900000)
    this.sealStreamMessage(session)
    const usage = asRecord(response.usage)
    this.emitResult(session, {
      subtype: response.stopReason === 'refusal' ? 'error' : 'success',
      error: response.stopReason === 'refusal' ? 'Kimi refused the prompt.' : undefined,
      inputTokens: asNumber(usage?.inputTokens),
      outputTokens: asNumber(usage?.outputTokens),
      totalTokens: asNumber(usage?.totalTokens)
    })
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
    // 回放（session/load）期间吞掉历史内容，但 available_commands_update 是
    // 会话级配置推送，照常处理（否则 resume 的会话拿不到斜杠命令）。
    if (session.replaying && asString(update.sessionUpdate) !== 'available_commands_update') return
    this.handleSessionUpdate(session, update)
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
      if (text) this.emitAssistantDelta(session, asString(update.messageId), text)
      return
    }
    if (type === 'agent_thought_chunk') {
      const text = textFromContentBlock(update.content)
      if (text) this.emitThinking(session, text)
      return
    }
    if (type === 'tool_call') {
      const toolUseId = asString(update.toolCallId) ?? cryptoId()
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
      // 渲染层保持 running 状态、只更新卡片内容。
      const partialText = stringifyToolResult(update.rawOutput ?? update.content)
      if (partialText) this.emitToolPartial(session, toolUseId, partialText)
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
    if (session.streamedText) content.push({ type: 'text', text: session.streamedText })
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
   *  卡片内容、不翻完成态。 */
  private emitToolPartial(
    session: ActiveKimiSession,
    toolUseId: string,
    content: string
  ): void {
    this.h.onMessage(session.id, {
      type: 'user',
      uuid: `kimi-tool-partial-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false, partial: true }]
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

/** 解析 /usage 隐藏轮文本里的 Context 行：
 *  `- Context: 45.6k / 1,048,576 (5.0%)` → { usedText: '45.6k', total: 1048576, pct: 5 } */
function parseContextUsage(text: string): ContextUsage | null {
  const match = text.match(/Context:\s*([\d.,a-zA-Z]+)\s*\/\s*([\d,]+)\s*\(\s*([\d.]+)\s*%\)/)
  if (!match) return null
  const total = Number(match[2].replace(/,/g, ''))
  const pct = Number(match[3])
  if (!Number.isFinite(total) || !Number.isFinite(pct)) return null
  return { usedText: match[1], total, pct }
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
