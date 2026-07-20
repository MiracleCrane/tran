import { readFileSync, writeFileSync } from 'node:fs'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SDKMessage,
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
  toolResults: Set<string>
  skills: SkillInfo[]
  lastUsage?: TokenUsage
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
      toolResults: new Set(),
      skills: []
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
      session.toolResults.clear()
      if (!session.closed && session.queue.length) void this.drain(session)
    }
  }

  private async runTurn(session: ActiveKimiSession, message: QueuedMessage): Promise<void> {
    if (!session.acpSessionId) throw new Error('Kimi session is not ready.')
    const client = await this.ensureClient()
    const payload = contentToPrompt(message.content)
    const response = await client.request<Record<string, unknown>>('session/prompt', {
      sessionId: session.acpSessionId,
      prompt: payload.prompt,
      messageId: cryptoId()
    }, 900000)
    if (session.streamStarted) this.emitContentBlockStop(session)
    if (session.streamedText) {
      this.emitAssistant(session, session.currentMessageId ?? cryptoId(), session.streamedText)
    }
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
    if (!session || session.replaying) return
    const update = asRecord(params?.update)
    if (!update) return
    this.handleSessionUpdate(session, update)
  }

  private handleSessionUpdate(session: ActiveKimiSession, update: Record<string, unknown>): void {
    const type = asString(update.sessionUpdate)
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
      this.emitToolUse(session, toolUseId, toolName(update), toolInput(update))
      return
    }
    if (type === 'tool_call_update') {
      const toolUseId = asString(update.toolCallId)
      if (!toolUseId || session.toolResults.has(toolUseId)) return
      const status = asString(update.status)
      if (status !== 'completed' && status !== 'failed') return
      session.toolResults.add(toolUseId)
      this.emitToolResult(
        session,
        toolUseId,
        stringifyToolResult(update.rawOutput ?? update.content ?? update.title ?? status),
        status === 'failed'
      )
      return
    }
    if (type === 'available_commands_update') {
      session.skills = toSkillInfos(update.availableCommands)
      return
    }
    if (type === 'usage_update') {
      const usage = asRecord(update.usage)
      session.lastUsage = {
        inputTokens: asNumber(usage?.inputTokens),
        outputTokens: asNumber(usage?.outputTokens),
        totalTokens: asNumber(usage?.totalTokens)
      }
    }
    // TODO: 'plan' / 'config_option_update' 暂不映射到 UI。
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
    if (!session.streamStarted) {
      session.streamStarted = true
      session.currentMessageId = messageId ?? `kimi-message-${cryptoId()}`
      this.emitStreamEvent(session, { type: 'message_start', message: { id: session.currentMessageId } })
      this.emitStreamEvent(session, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    }
    session.streamedText += delta
    this.emitStreamEvent(session, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: delta }
    })
  }

  private emitThinking(session: ActiveKimiSession, text: string): void {
    const id = `kimi-thinking-${cryptoId()}`
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: null,
      message: {
        id,
        content: [{ type: 'thinking', thinking: text }]
      }
    } as unknown as SDKMessage)
  }

  private emitContentBlockStop(session: ActiveKimiSession): void {
    this.emitStreamEvent(session, { type: 'content_block_stop', index: 0 })
  }

  private emitStreamEvent(session: ActiveKimiSession, event: Record<string, unknown>): void {
    this.h.onMessage(session.id, {
      type: 'stream_event',
      uuid: `kimi-stream-${session.currentMessageId ?? cryptoId()}`,
      parent_tool_use_id: null,
      event
    } as unknown as SDKMessage)
  }

  private emitAssistant(session: ActiveKimiSession, itemId: string, text: string): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `kimi-assistant-${itemId}`,
      parent_tool_use_id: null,
      message: {
        id: itemId,
        content: [{ type: 'text', text }]
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

function readFileSlice(path: string, line?: number, limit?: number): string {
  const text = readFileSync(path, 'utf8')
  if (!line && !limit) return text
  const lines = text.split(/\r?\n/)
  const start = Math.max(0, (line ?? 1) - 1)
  const end = limit && limit > 0 ? start + limit : undefined
  return lines.slice(start, end).join('\n')
}

function permissionOptionId(options: Array<Record<string, unknown>>, behavior: 'allow' | 'deny'): string | null {
  const ids = options.map((option) => asString(option.optionId) ?? asString(option.option_id)).filter(Boolean) as string[]
  if (behavior === 'allow') {
    return ids.find((id) => id === 'allow_once') ?? ids.find((id) => id.startsWith('allow')) ?? null
  }
  return ids.find((id) => id === 'deny') ?? ids.find((id) => id.startsWith('reject')) ?? null
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
