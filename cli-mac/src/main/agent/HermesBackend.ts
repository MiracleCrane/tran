import { readFileSync } from 'node:fs'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import {
  DEFAULT_HERMES_MODEL_ID,
  DEFAULT_HERMES_MODELS
} from '../../shared/models'
import type { AgentBackendHandlers } from './ClaudeCodeBackend'
import {
  HermesAcpClient,
  type HermesRpcId,
  type HermesRpcMessage
} from './HermesAcpClient'
import { log } from '../logger'
import {
  listHermesMcpServers,
  readHermesDefaultModel,
  setHermesMcpServerEnabled
} from '../hermesConfig'

interface QueuedMessage {
  content: string | unknown[]
}

interface ActiveHermesSession {
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
  client: HermesAcpClient
  requestId: HermesRpcId
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

export class HermesBackend {
  readonly id = 'hermes' as const
  private sessions = new Map<string, ActiveHermesSession>()
  private acpToSession = new Map<string, string>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private clientPromise: Promise<HermesAcpClient> | null = null
  private client: HermesAcpClient | null = null

  constructor(private h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Hermes backend currently supports Windows only.')
    const sessionId = opts.bridgeSessionId ?? cryptoId()
    const session: ActiveHermesSession = {
      id: sessionId,
      cwd: opts.cwd,
      model: hermesModel(opts.model),
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
      const message = error instanceof Error ? error.message : String(error)
      log('hermes', `prepare failed session=${sessionId}: ${message}`)
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
    // Hermes owns model/provider selection through config.yaml and `hermes model`.
    // Its ACP set-model route is unstable in 0.16.x and can surface as a server
    // "Internal error", so keep Forge's local state only.
    session.model = hermesModel(model)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.permissionMode = mode
    if (!session.acpSessionId) return
    const client = await this.ensureClient()
    await client.request('session/set_mode', {
      sessionId: session.acpSessionId,
      modeId: hermesMode(mode)
    }).catch((error) => {
      log('hermes', `set mode failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    if (session.acpSessionId) {
      this.acpToSession.delete(session.acpSessionId)
      const client = this.client
      client?.notify('session/cancel', { sessionId: session.acpSessionId })
      await client?.request('session/close', { sessionId: session.acpSessionId }, 5000).catch(() => {})
    }
    this.sessions.delete(sessionId)
  }

  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    return listHermesMcpServers()
  }

  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.listMcpServers(sessionId)
  }

  async toggleMcpServer(_sessionId: string, name: string, enabled: boolean): Promise<void> {
    setHermesMcpServerEnabled(name, enabled)
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
    return mergeComposerModels(
      [{ id: DEFAULT_HERMES_MODEL_ID, label: 'Hermes default' }],
      readHermesDefaultModel()
        ? [{ id: readHermesDefaultModel()!, label: readHermesDefaultModel()! }]
        : [],
      DEFAULT_HERMES_MODELS
    )
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
      log('hermes', `permission response failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  private async prepareSession(
    session: ActiveHermesSession,
    opts: StartSessionOptions
  ): Promise<void> {
    const client = await this.ensureClient()
    let response: Record<string, unknown> | null = null
    if (opts.resume) {
      session.replaying = true
      session.acpSessionId = opts.resume
      this.acpToSession.set(opts.resume, session.id)
      try {
        response = await client.request<Record<string, unknown>>('session/resume', {
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
      if (!acpSessionId) throw new Error('Hermes ACP did not return a session id.')
      session.acpSessionId = acpSessionId
      this.acpToSession.set(acpSessionId, session.id)
    }

    const model = asString(asRecord(response?.models)?.currentModelId) ?? session.model ?? readHermesDefaultModel() ?? DEFAULT_HERMES_MODEL_ID
    session.model = hermesModel(model) ?? undefined
    if (session.permissionMode) {
      await this.setPermissionMode(session.id, session.permissionMode)
    }
    this.emitInit(session, session.acpSessionId ?? opts.resume ?? session.id, session.model ?? model)
    void this.drain(session)
  }

  private async drain(session: ActiveHermesSession): Promise<void> {
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
        error: error instanceof Error ? error.message : String(error)
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

  private async runTurn(session: ActiveHermesSession, message: QueuedMessage): Promise<void> {
    if (!session.acpSessionId) throw new Error('Hermes session is not ready.')
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
      error: response.stopReason === 'refusal' ? 'Hermes refused the prompt.' : undefined,
      inputTokens: asNumber(usage?.inputTokens),
      outputTokens: asNumber(usage?.outputTokens),
      totalTokens: asNumber(usage?.totalTokens)
    })
  }

  private async ensureClient(): Promise<HermesAcpClient> {
    if (this.client) return this.client
    if (!this.clientPromise) {
      this.clientPromise = HermesAcpClient.start({
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

  private handleNotification(msg: HermesRpcMessage): void {
    if (msg.method !== 'session/update') return
    const params = asRecord(msg.params)
    const acpSessionId = asString(params?.sessionId)
    const session = this.sessionForAcp(acpSessionId)
    if (!session || session.replaying) return
    const update = asRecord(params?.update)
    if (!update) return
    this.handleSessionUpdate(session, update)
  }

  private handleSessionUpdate(session: ActiveHermesSession, update: Record<string, unknown>): void {
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
  }

  private handleServerRequest(msg: HermesRpcMessage): void {
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
    client.respondError(msg.id, `Forge does not handle Hermes ACP request: ${method}`, -32601)
  }

  private handlePermissionRequest(
    client: HermesAcpClient,
    requestId: HermesRpcId,
    params: Record<string, unknown>
  ): void {
    const toolCall = asRecord(params.toolCall) ?? {}
    const toolUseID = `hermes-${String(requestId)}`
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

  private emitInit(session: ActiveHermesSession, sdkSessionId: string, model: string): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'init',
      session_id: sdkSessionId,
      cwd: session.cwd,
      model,
      permissionMode: session.permissionMode ?? 'default',
      tools: ['terminal', 'read_file', 'write_file', 'patch', 'search_files', 'mcp']
    } as unknown as SDKMessage)
  }

  private emitAssistantDelta(session: ActiveHermesSession, messageId: string | undefined, delta: string): void {
    if (!session.streamStarted) {
      session.streamStarted = true
      session.currentMessageId = messageId ?? `hermes-message-${cryptoId()}`
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

  private emitThinking(session: ActiveHermesSession, text: string): void {
    const id = `hermes-thinking-${cryptoId()}`
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

  private emitContentBlockStop(session: ActiveHermesSession): void {
    this.emitStreamEvent(session, { type: 'content_block_stop', index: 0 })
  }

  private emitStreamEvent(session: ActiveHermesSession, event: Record<string, unknown>): void {
    this.h.onMessage(session.id, {
      type: 'stream_event',
      uuid: `hermes-stream-${session.currentMessageId ?? cryptoId()}`,
      parent_tool_use_id: null,
      event
    } as unknown as SDKMessage)
  }

  private emitAssistant(session: ActiveHermesSession, itemId: string, text: string): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `hermes-assistant-${itemId}`,
      parent_tool_use_id: null,
      message: {
        id: itemId,
        content: [{ type: 'text', text }]
      }
    } as unknown as SDKMessage)
  }

  private emitToolUse(
    session: ActiveHermesSession,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>
  ): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `hermes-tool-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        id: `hermes-tool-message-${toolUseId}`,
        content: [{ type: 'tool_use', id: toolUseId, name, input }]
      }
    } as unknown as SDKMessage)
  }

  private emitToolResult(
    session: ActiveHermesSession,
    toolUseId: string,
    content: string,
    isError: boolean
  ): void {
    this.h.onMessage(session.id, {
      type: 'user',
      uuid: `hermes-tool-result-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
      }
    } as unknown as SDKMessage)
  }

  private emitResult(
    session: ActiveHermesSession,
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

  private sessionForAcp(acpSessionId: string | undefined): ActiveHermesSession | null {
    if (!acpSessionId) return null
    const sessionId = this.acpToSession.get(acpSessionId)
    return sessionId ? (this.sessions.get(sessionId) ?? null) : null
  }

  private requireSession(sessionId: string): ActiveHermesSession {
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

function hermesMode(mode: string | undefined): string {
  if (mode === 'acceptEdits') return 'accept_edits'
  if (mode === 'bypassPermissions' || mode === 'dontAsk') return 'dont_ask'
  return 'default'
}

function hermesModel(model: string | undefined): string | undefined {
  if (!model || model === DEFAULT_HERMES_MODEL_ID) return undefined
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
  return 'hermes-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
