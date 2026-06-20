import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import {
  DEFAULT_CODEX_MODEL_ID,
  DEFAULT_CODEX_MODELS
} from '../../shared/models'
import type { AgentBackendHandlers } from './ClaudeCodeBackend'
import { log } from '../logger'
import {
  CodexAppServerClient,
  type CodexRpcId,
  type CodexRpcMessage
} from './CodexAppServerClient'

interface QueuedMessage {
  content: string | unknown[]
}

interface ActiveCodexSession {
  id: string
  cwd: string
  model?: string
  permissionMode?: string
  threadId?: string
  queue: QueuedMessage[]
  running: boolean
  closed?: boolean
  ready: Promise<void>
  turn: number
  currentTurnId?: string
  streamedMessageIds: Set<string>
  streamedText: Map<string, string>
  itemOutput: Map<string, string>
  lastUsage?: TokenUsage
}

interface PendingPermission {
  client: CodexAppServerClient
  requestId: CodexRpcId
  method: string
  params: Record<string, unknown>
}

interface PromptPayload {
  input: Array<Record<string, unknown>>
  images: string[]
}

interface TokenUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
}

type AppItem = Record<string, unknown> & {
  id?: string
  type?: string
  text?: string
  command?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  status?: string
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  changes?: unknown
}

interface CodexModelListResponse {
  data?: unknown[]
  nextCursor?: string | null
}

interface CodexPluginListResponse {
  marketplaces?: unknown[]
  marketplaceLoadErrors?: unknown[]
  featuredPluginIds?: string[]
  data?: unknown[]
}

export class CodexBackend {
  readonly id = 'codex' as const
  private sessions = new Map<string, ActiveCodexSession>()
  private threadToSession = new Map<string, string>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private clientPromise: Promise<CodexAppServerClient> | null = null
  private client: CodexAppServerClient | null = null

  constructor(private h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    if (process.platform !== 'win32') throw new Error('Codex backend currently supports Windows only.')
    const sessionId = opts.bridgeSessionId ?? cryptoId()
    const session: ActiveCodexSession = {
      id: sessionId,
      cwd: opts.cwd,
      model: codexModel(opts.model),
      permissionMode: opts.permissionMode,
      queue: [],
      running: false,
      turn: 0,
      streamedMessageIds: new Set(),
      streamedText: new Map(),
      itemOutput: new Map(),
      ready: Promise.resolve()
    }
    session.ready = this.prepareSession(session, opts)
    this.sessions.set(sessionId, session)
    session.ready.catch((error) => {
      if (!this.sessions.has(sessionId)) return
      const message = error instanceof Error ? error.message : String(error)
      log('codex', `prepare failed session=${sessionId}: ${message}`)
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
    if (!session?.threadId || !session.currentTurnId) return
    const client = await this.ensureClient()
    await client.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.currentTurnId
    }).catch(() => {})
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.model = codexModel(model)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.permissionMode = mode
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    if (session.threadId) {
      this.threadToSession.delete(session.threadId)
      const client = this.client
      await client?.request('thread/unsubscribe', { threadId: session.threadId }).catch(() => {})
    }
    this.sessions.delete(sessionId)
  }

  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    const client = await this.ensureClient()
    const response = await client.request<{ data?: unknown[] }>('mcpServerStatus/list', {
      threadId: session.threadId ?? null,
      detail: 'full'
    })
    return (response.data ?? []).map(toMcpEntry)
  }

  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    const client = await this.ensureClient()
    await client.request('config/mcpServer/reload').catch((error) => {
      log('codex', `mcp reload failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.listMcpServers(sessionId)
  }

  async toggleMcpServer(_sessionId: string, name: string, enabled: boolean): Promise<void> {
    const client = await this.ensureClient()
    await client.request('config/value/write', {
      keyPath: `mcp_servers.${name}.enabled`,
      value: enabled,
      mergeStrategy: 'upsert'
    })
    await client.request('config/mcpServer/reload').catch(() => {})
  }

  async backgroundTask(_sessionId: string, _toolUseId?: string): Promise<boolean> {
    return false
  }

  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const session = this.requireSession(sessionId)
    await session.ready
    const client = await this.ensureClient()
    const response = await client.request<{ data?: Array<{ skills?: unknown[] }> }>('skills/list', {
      cwds: [session.cwd],
      forceReload: false
    })
    return (response.data ?? [])
      .flatMap((entry) => entry.skills ?? [])
      .map(toSkillInfo)
      .filter((skill): skill is SkillInfo => !!skill)
  }

  async listMarketplacePlugins(cwd?: string): Promise<MarketplacePlugin[]> {
    if (process.platform !== 'win32') return []
    try {
      const client = await this.ensureClient()
      const response = await client.request<CodexPluginListResponse>(
        'plugin/list',
        {
          ...(cwd ? { cwds: [cwd] } : {}),
          marketplaceKinds: ['local', 'vertical', 'workspace-directory', 'shared-with-me']
        },
        30000
      )
      const plugins = toCodexMarketplacePlugins(response)
      const loadErrors = Array.isArray(response.marketplaceLoadErrors)
        ? response.marketplaceLoadErrors.length
        : 0
      log('codex', `loaded ${plugins.length} plugins from app-server marketplace(s) errors=${loadErrors}`)
      return plugins
    } catch (error) {
      log('codex', `list marketplace plugins failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    if (process.platform !== 'win32') return DEFAULT_CODEX_MODELS
    try {
      const client = await this.ensureClient()
      const liveModels: ComposerModel[] = []
      let cursor: string | null = null
      do {
        const response: CodexModelListResponse = await client.request<CodexModelListResponse>(
          'model/list',
          { cursor, limit: 100, includeHidden: false },
          30000
        )
        const rawModels = Array.isArray(response.data) ? response.data : []
        liveModels.push(
          ...rawModels
            .map(toComposerModel)
            .filter((model: ComposerModel | null): model is ComposerModel => !!model)
        )
        cursor = response.nextCursor || null
      } while (cursor)
      return mergeComposerModels(
        [{ id: DEFAULT_CODEX_MODEL_ID, label: 'Codex default' }],
        liveModels,
        DEFAULT_CODEX_MODELS
      )
    } catch (error) {
      log('codex', `list models failed: ${error instanceof Error ? error.message : String(error)}`)
      return DEFAULT_CODEX_MODELS
    }
  }

  respondPermission(resp: PermissionResponsePayload): boolean {
    const pending = this.pendingPermissions.get(resp.toolUseID)
    if (!pending) return false
    this.pendingPermissions.delete(resp.toolUseID)
    try {
      pending.client.respond(
        pending.requestId,
        permissionResponseFor(pending.method, pending.params, resp)
      )
    } catch (error) {
      log('codex', `permission response failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  private async prepareSession(
    session: ActiveCodexSession,
    opts: StartSessionOptions
  ): Promise<void> {
    const client = await this.ensureClient()
    const baseParams = buildThreadOptions(session)
    let resumed = false
    let response: Record<string, unknown>
    if (opts.resume) {
      try {
        response = await client.request<Record<string, unknown>>('thread/resume', {
          ...baseParams,
          threadId: opts.resume
        })
        resumed = true
      } catch (error) {
        if (isMissingCodexRolloutError(error)) {
          log('codex', `resume rollout missing thread=${opts.resume}; starting a fresh thread`)
          response = await client.request<Record<string, unknown>>('thread/start', baseParams)
        } else {
          throw error
        }
      }
    } else {
      response = await client.request<Record<string, unknown>>('thread/start', baseParams)
    }
    const thread = asRecord(response.thread)
    const threadId = asString(thread?.id) ?? (resumed ? opts.resume : undefined)
    if (!threadId) throw new Error('Codex app-server did not return a thread id.')
    session.threadId = threadId
    session.model = codexModel(asString(response.model)) ?? session.model
    this.threadToSession.set(threadId, session.id)
    this.emitInit(session, threadId, asString(response.model) ?? session.model)
    void this.drain(session)
  }

  private async drain(session: ActiveCodexSession): Promise<void> {
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
      session.currentTurnId = undefined
      if (!session.closed && session.queue.length) void this.drain(session)
    }
  }

  private async runTurn(session: ActiveCodexSession, message: QueuedMessage): Promise<void> {
    if (!session.threadId) throw new Error('Codex session is not ready.')
    const client = await this.ensureClient()
    const payload = contentToPrompt(message.content)
    let turnId: string | undefined
    try {
      const response = await client.request<{ turn?: { id?: string; status?: string } }>('turn/start', {
        threadId: session.threadId,
        clientUserMessageId: cryptoId(),
        input: payload.input,
        cwd: session.cwd,
        ...buildTurnOptions(session)
      })
      turnId = response.turn?.id
      if (!turnId) throw new Error('Codex app-server did not return a turn id.')
      session.currentTurnId = turnId
      if (response.turn?.status === 'completed') {
        this.emitResult(session, { subtype: 'success', ...session.lastUsage })
        cleanupFiles(payload.images)
        return
      }
      await new Promise<void>((resolve, reject) => {
        turnWaiters.set(turnId!, {
          sessionId: session.id,
          resolve,
          reject,
          cleanup: () => cleanupFiles(payload.images)
        })
      })
    } finally {
      if (!turnId) cleanupFiles(payload.images)
    }
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client) return this.client
    if (!this.clientPromise) {
      this.clientPromise = CodexAppServerClient.start({
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

  private handleNotification(msg: CodexRpcMessage): void {
    const method = msg.method ?? ''
    const params = asRecord(msg.params) ?? {}
    if (method === 'thread/started') {
      const thread = asRecord(params.thread)
      const threadId = asString(thread?.id)
      if (threadId && !this.threadToSession.has(threadId)) log('codex', `thread started ${threadId}`)
      return
    }
    if (method === 'item/agentMessage/delta') {
      const session = this.sessionForThread(asString(params.threadId))
      const itemId = asString(params.itemId)
      const delta = asString(params.delta)
      if (session && itemId && delta) this.emitAssistantDelta(session, itemId, delta)
      return
    }
    if (method === 'item/commandExecution/outputDelta') {
      const session = this.sessionForThread(asString(params.threadId))
      const itemId = asString(params.itemId)
      const delta = asString(params.delta)
      if (session && itemId && delta) {
        session.itemOutput.set(itemId, (session.itemOutput.get(itemId) ?? '') + delta)
      }
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const session = this.sessionForThread(asString(params.threadId))
      const usage = asRecord(asRecord(params.tokenUsage)?.last)
      if (session && usage) {
        session.lastUsage = {
          inputTokens: asNumber(usage.inputTokens),
          cachedInputTokens: asNumber(usage.cachedInputTokens),
          outputTokens: asNumber(usage.outputTokens)
        }
      }
      return
    }
    if (method === 'item/started') {
      const session = this.sessionForThread(asString(params.threadId))
      const item = asRecord(params.item) as AppItem | null
      if (session && item) this.handleItemStarted(session, item)
      return
    }
    if (method === 'item/completed') {
      const session = this.sessionForThread(asString(params.threadId))
      const item = asRecord(params.item) as AppItem | null
      if (session && item) this.handleItemCompleted(session, item)
      return
    }
    if (method === 'turn/completed') {
      this.handleTurnCompleted(params)
      return
    }
    if (method === 'error') {
      const message = asString(asRecord(params.error)?.message) ?? asString(params.message) ?? 'Codex error'
      const session = this.sessionForThread(asString(params.threadId))
      if (session) this.emitResult(session, { subtype: 'error', error: message })
      else log('codex', message)
    }
  }

  private handleItemStarted(session: ActiveCodexSession, item: AppItem): void {
    const id = asString(item.id) ?? cryptoId()
    if (item.type === 'commandExecution') {
      this.emitToolUse(session, id, 'shell', { command: asString(item.command) ?? '', cwd: item.cwd })
    } else if (item.type === 'mcpToolCall') {
      this.emitToolUse(session, id, `${asString(item.server) ?? 'mcp'}.${asString(item.tool) ?? 'tool'}`, {
        arguments: item.arguments
      })
    } else if (item.type === 'dynamicToolCall') {
      this.emitToolUse(session, id, asString(item.tool) ?? 'tool', { arguments: item.arguments })
    } else if (item.type === 'fileChange') {
      this.emitToolUse(session, id, 'apply_patch', { changes: item.changes })
    } else if (item.type === 'webSearch') {
      this.emitToolUse(session, id, 'web_search', { query: item.query })
    }
  }

  private handleItemCompleted(session: ActiveCodexSession, item: AppItem): void {
    const id = asString(item.id) ?? cryptoId()
    if (item.type === 'agentMessage') {
      const text = asString(item.text) ?? session.streamedText.get(id) ?? ''
      if (text) {
        if (session.streamedMessageIds.has(id)) this.emitContentBlockStop(session, id)
        this.emitAssistant(session, id, text)
      }
      session.streamedMessageIds.delete(id)
      session.streamedText.delete(id)
    } else if (item.type === 'commandExecution') {
      const output = asString(item.aggregatedOutput) ?? session.itemOutput.get(id) ?? ''
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
      this.emitToolResult(session, id, output, exitCode !== null && exitCode !== 0)
      session.itemOutput.delete(id)
    } else if (item.type === 'mcpToolCall') {
      this.emitToolResult(session, id, stringifyToolResult(item.result ?? item.error), !!item.error)
    } else if (item.type === 'dynamicToolCall') {
      this.emitToolResult(session, id, stringifyToolResult(item.contentItems ?? item.result), item.success === false)
    } else if (item.type === 'fileChange') {
      this.emitToolResult(session, id, stringifyToolResult(item.changes ?? item.status), item.status === 'failed')
    } else if (item.type === 'webSearch') {
      this.emitToolResult(session, id, stringifyToolResult(item.action ?? item.query), false)
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const threadId = asString(params.threadId)
    const session = this.sessionForThread(threadId)
    const turn = asRecord(params.turn)
    const turnId = asString(turn?.id)
    if (!session || !turnId) return
    const waiter = turnWaiters.get(turnId)
    turnWaiters.delete(turnId)
    const status = asString(turn?.status)
    const error = asRecord(turn?.error)
    this.emitResult(session, {
      subtype: status === 'failed' ? 'error' : 'success',
      error: asString(error?.message),
      ...session.lastUsage
    })
    waiter?.cleanup()
    waiter?.resolve()
  }

  private handleServerRequest(msg: CodexRpcMessage): void {
    const method = msg.method ?? ''
    const params = asRecord(msg.params) ?? {}
    if (msg.id === undefined) return
    const client = this.client
    if (!client) return
    if (!isPermissionRequest(method)) {
      log('codex', `unhandled server request method=${method} params=${previewJson(params)}`)
      client.respondError(msg.id, `Forge does not handle Codex app-server request: ${method}`)
      return
    }
    const toolUseID = `codex-${String(msg.id)}`
    this.pendingPermissions.set(toolUseID, {
      client,
      requestId: msg.id,
      method,
      params
    })
    const toolName = permissionToolName(method, params)
    log('codex', `permission request method=${method} id=${String(msg.id)} tool=${toolName}`)
    this.h.onPermissionRequest({
      toolUseID,
      toolName,
      input: permissionInput(method, params),
      decisionReason: asString(params.reason) ?? undefined
    })
  }

  private handleClientClose(error?: string): void {
    this.client = null
    this.clientPromise = null
    for (const session of this.sessions.values()) {
      this.h.onEnded(session.id, error)
    }
    this.sessions.clear()
    this.threadToSession.clear()
    for (const waiter of turnWaiters.values()) {
      waiter.cleanup()
      waiter.reject(new Error(error ?? 'Codex app-server closed.'))
    }
    turnWaiters.clear()
  }

  private emitInit(session: ActiveCodexSession, sdkSessionId: string, model?: string): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'init',
      session_id: sdkSessionId,
      cwd: session.cwd,
      model: model ?? session.model ?? readCodexDefaultModel() ?? 'codex-default',
      permissionMode: session.permissionMode ?? 'default',
      tools: ['shell', 'apply_patch', 'mcp']
    } as unknown as SDKMessage)
  }

  private emitAssistantDelta(session: ActiveCodexSession, itemId: string, delta: string): void {
    if (!session.streamedMessageIds.has(itemId)) {
      session.streamedMessageIds.add(itemId)
      this.emitStreamEvent(session, itemId, { type: 'message_start', message: { id: itemId } })
      this.emitStreamEvent(session, itemId, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    }
    session.streamedText.set(itemId, (session.streamedText.get(itemId) ?? '') + delta)
    this.emitStreamEvent(session, itemId, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: delta }
    })
  }

  private emitContentBlockStop(session: ActiveCodexSession, itemId: string): void {
    this.emitStreamEvent(session, itemId, { type: 'content_block_stop', index: 0 })
  }

  private emitStreamEvent(
    session: ActiveCodexSession,
    itemId: string,
    event: Record<string, unknown>
  ): void {
    this.h.onMessage(session.id, {
      type: 'stream_event',
      uuid: `codex-stream-${itemId}`,
      parent_tool_use_id: null,
      event
    } as unknown as SDKMessage)
  }

  private emitAssistant(session: ActiveCodexSession, itemId: string, text: string): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `codex-assistant-${itemId}`,
      parent_tool_use_id: null,
      message: {
        id: itemId,
        content: [{ type: 'text', text }]
      }
    } as unknown as SDKMessage)
  }

  private emitToolUse(
    session: ActiveCodexSession,
    toolUseId: string,
    name: string,
    input: Record<string, unknown>
  ): void {
    this.h.onMessage(session.id, {
      type: 'assistant',
      uuid: `codex-tool-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        id: `codex-tool-message-${toolUseId}`,
        content: [{ type: 'tool_use', id: toolUseId, name, input }]
      }
    } as unknown as SDKMessage)
  }

  private emitToolResult(
    session: ActiveCodexSession,
    toolUseId: string,
    content: string,
    isError: boolean
  ): void {
    this.h.onMessage(session.id, {
      type: 'user',
      uuid: `codex-tool-result-${toolUseId}`,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
      }
    } as unknown as SDKMessage)
  }

  private emitResult(
    session: ActiveCodexSession,
    result: {
      subtype: 'success' | 'error'
      error?: string
      inputTokens?: number
      outputTokens?: number
      cachedInputTokens?: number
    }
  ): void {
    this.h.onMessage(session.id, {
      type: 'result',
      total_cost_usd: 0,
      num_turns: session.turn,
      usage: {
        input_tokens: result.inputTokens ?? 0,
        output_tokens: result.outputTokens ?? 0,
        cache_read_input_tokens: result.cachedInputTokens ?? null
      },
      stop_reason: null,
      subtype: result.subtype,
      ...(result.error ? { errors: [result.error] } : {})
    } as unknown as SDKMessage)
  }

  private sessionForThread(threadId: string | undefined): ActiveCodexSession | null {
    if (!threadId) return null
    const sessionId = this.threadToSession.get(threadId)
    return sessionId ? (this.sessions.get(sessionId) ?? null) : null
  }

  private requireSession(sessionId: string): ActiveCodexSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)
    return session
  }
}

const turnWaiters = new Map<
  string,
  {
    sessionId: string
    resolve: () => void
    reject: (error: Error) => void
    cleanup: () => void
  }
>()

function buildThreadOptions(session: ActiveCodexSession): Record<string, unknown> {
  const permission = codexPermission(session.permissionMode)
  return {
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    approvalPolicy: permission.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: permission.sandbox
  }
}

function buildTurnOptions(session: ActiveCodexSession): Record<string, unknown> {
  const permission = codexPermission(session.permissionMode)
  return {
    ...(session.model ? { model: session.model } : {}),
    approvalPolicy: permission.approvalPolicy,
    approvalsReviewer: 'user',
    sandboxPolicy: permission.sandboxPolicy
  }
}

function codexPermission(mode: string | undefined): {
  approvalPolicy: string
  sandbox: string
  sandboxPolicy: Record<string, unknown>
} {
  if (mode === 'bypassPermissions' || mode === 'dontAsk') {
    return {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    }
  }
  if (mode === 'plan') {
    return {
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      sandboxPolicy: { type: 'readOnly', networkAccess: false }
    }
  }
  return {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  }
}

function contentToPrompt(content: string | unknown[]): PromptPayload {
  if (typeof content === 'string') {
    return { input: [{ type: 'text', text: content, text_elements: [] }], images: [] }
  }
  const input: Array<Record<string, unknown>> = []
  const images: string[] = []
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
      const path = writeTempImage(typed.source.data, typed.source.media_type)
      images.push(path)
      input.push({ type: 'localImage', path })
    }
  }
  if (text.length) input.unshift({ type: 'text', text: text.join('\n'), text_elements: [] })
  if (!input.length) input.push({ type: 'text', text: '', text_elements: [] })
  return { input, images }
}

function writeTempImage(data: string, mediaType?: string): string {
  const ext = mediaType?.includes('jpeg') ? 'jpg' : mediaType?.includes('webp') ? 'webp' : 'png'
  const dir = join(tmpdir(), 'forge-codex-images')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${cryptoId()}.${ext}`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

function cleanupFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path)
    } catch {
      /* ignore */
    }
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

export function readCodexDefaultModel(): string | undefined {
  try {
    const config = readFileSync(join(codexHome(), 'config.toml'), 'utf8')
    return config.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]
  } catch {
    return undefined
  }
}

function codexModel(model: string | undefined): string | undefined {
  if (!model || /^claude/i.test(model) || model === DEFAULT_CODEX_MODEL_ID) return undefined
  return model
}

function isMissingCodexRolloutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no rollout found/i.test(message) || /thread .*not found/i.test(message)
}

function toComposerModel(raw: unknown): ComposerModel | null {
  const model = asRecord(raw)
  if (!model) return null
  const id = asString(model.id) ?? asString(model.model)
  if (!id) return null
  return {
    id,
    label: asString(model.displayName) ?? asString(model.name) ?? id
  }
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

function toMcpEntry(raw: unknown): McpServerEntry {
  const status = asRecord(raw) ?? {}
  const tools = asRecord(status.tools)
  const authStatus = asString(status.authStatus)
  return {
    name: asString(status.name) ?? 'mcp',
    status: authStatus === 'notLoggedIn' ? 'needs-auth' : tools ? 'connected' : 'pending',
    scope: 'user',
    serverInfo: asRecord(status.serverInfo) as McpServerEntry['serverInfo'],
    tools: tools
      ? Object.entries(tools).map(([name, tool]) => ({
          name,
          description: asString(asRecord(tool)?.description)
        }))
      : [],
    config: { type: 'stdio' }
  }
}

function toSkillInfo(raw: unknown): SkillInfo | null {
  const skill = asRecord(raw)
  if (!skill) return null
  const name = asString(skill.name)
  if (!name) return null
  const iface = asRecord(skill.interface)
  return {
    name,
    description:
      asString(iface?.shortDescription) ??
      asString(skill.shortDescription) ??
      asString(skill.description) ??
      name
  }
}

function toCodexMarketplacePlugins(response: CodexPluginListResponse): MarketplacePlugin[] {
  const out: MarketplacePlugin[] = []
  const marketplaces = Array.isArray(response.marketplaces) ? response.marketplaces : []
  for (const rawMarketplace of marketplaces) {
    const marketplace = asRecord(rawMarketplace)
    if (!marketplace) continue
    const iface = asRecord(marketplace['interface'])
    const marketplaceName =
      asString(iface?.displayName) ?? asString(marketplace.name) ?? 'Codex marketplace'
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
    for (const rawPlugin of plugins) {
      const plugin = toCodexMarketplacePlugin(rawPlugin, marketplaceName)
      if (plugin) out.push(plugin)
    }
  }

  if (!out.length && Array.isArray(response.data)) {
    for (const rawPlugin of response.data) {
      const plugin = toCodexMarketplacePlugin(rawPlugin, 'Codex')
      if (plugin) out.push(plugin)
    }
  }

  const seen = new Set<string>()
  return out.filter((plugin) => {
    const key = `${plugin.marketplace}\0${plugin.name}\0${plugin.sourceUrl ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toCodexMarketplacePlugin(raw: unknown, marketplace: string): MarketplacePlugin | null {
  const plugin = asRecord(raw)
  if (!plugin) return null
  const iface = asRecord(plugin['interface'])
  const source = asRecord(plugin.source)
  const name =
    asString(iface?.displayName) ??
    asString(plugin.name) ??
    asString(plugin.id) ??
    asString(plugin.remotePluginId)
  if (!name) return null
  const sourceUrl = asString(source?.url) ?? asString(source?.path)
  return {
    name,
    description:
      asString(iface?.shortDescription) ??
      asString(iface?.longDescription) ??
      asString(plugin.description) ??
      '',
    agentBackend: 'codex',
    author: asString(iface?.developerName) ?? undefined,
    category: asString(iface?.category) ?? undefined,
    homepage: asString(iface?.websiteUrl) ?? undefined,
    sourceUrl,
    marketplace,
    installed: asBoolean(plugin.installed),
    enabled: asBoolean(plugin.enabled)
  }
}

function permissionToolName(method: string, params: Record<string, unknown>): string {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') return 'shell'
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') return 'apply_patch'
  if (method === 'item/permissions/requestApproval') return 'permissions'
  if (method === 'mcpServer/elicitation/request') return 'mcp'
  if (method === 'item/tool/requestUserInput') return 'user_input'
  const explicitTool = asString(params.toolName) ?? asString(params.tool) ?? asString(params.name)
  if (explicitTool && /^(bash|shell|commandExecution|execCommand)$/i.test(explicitTool)) return 'shell'
  if (explicitTool && /^(apply_patch|applyPatch|fileChange)$/i.test(explicitTool)) return 'apply_patch'
  if (explicitTool) return explicitTool
  const lower = method.toLowerCase()
  if (lower.includes('command') || lower.includes('exec') || params.command) return 'shell'
  if (lower.includes('file') || lower.includes('patch') || params.changes) return 'apply_patch'
  if (lower.includes('permission')) return 'permissions'
  if (lower.includes('elicitation') || lower.includes('mcp')) return 'mcp'
  return method
}

function permissionInput(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === 'item/commandExecution/requestApproval' || isCommandApproval(method, params)) {
    return {
      command: params.command ?? params.commandLine ?? params.cmd,
      cwd: params.cwd ?? params.workingDirectory,
      reason: params.reason,
      commandActions: params.commandActions
    }
  }
  if (method === 'item/fileChange/requestApproval' || isFileApproval(method, params)) {
    return {
      reason: params.reason,
      grantRoot: params.grantRoot,
      changes: params.changes
    }
  }
  return params
}

function isPermissionRequest(method: string): boolean {
  if ([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
    'item/tool/requestUserInput',
    'applyPatchApproval',
    'execCommandApproval'
  ].includes(method)) return true

  const lower = method.toLowerCase()
  if (lower.includes('requestapproval') || lower.includes('request_approval')) return true
  if (lower.includes('approval') && (lower.includes('command') || lower.includes('exec') || lower.includes('file') || lower.includes('patch') || lower.includes('tool'))) return true
  if (lower.includes('permission') && lower.includes('request')) return true
  return lower.includes('elicitation') && lower.includes('request')
}

function permissionResponseFor(
  method: string,
  params: Record<string, unknown>,
  resp: PermissionResponsePayload
): Record<string, unknown> {
  const allow = resp.behavior === 'allow'
  if (method === 'item/commandExecution/requestApproval' || (isCommandApproval(method, params) && method !== 'execCommandApproval')) {
    return { decision: allow ? 'accept' : 'decline' }
  }
  if (method === 'item/fileChange/requestApproval' || (isFileApproval(method, params) && method !== 'applyPatchApproval')) {
    return { decision: allow ? 'accept' : 'decline' }
  }
  if (method === 'item/permissions/requestApproval') {
    const permissions = asRecord(params.permissions) ?? {}
    return { permissions: allow ? permissions : {}, scope: 'turn' }
  }
  if (method === 'mcpServer/elicitation/request') {
    return { action: allow ? 'accept' : 'decline', content: null, _meta: null }
  }
  if (method === 'item/tool/requestUserInput') {
    return { answers: allow ? (resp.answers ?? {}) : {} }
  }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return { decision: allow ? 'approved' : 'denied' }
  }
  if (method.toLowerCase().includes('approval')) {
    return { decision: allow ? 'accept' : 'decline' }
  }
  return {}
}

function isCommandApproval(method: string, params: Record<string, unknown>): boolean {
  const lower = method.toLowerCase()
  return lower.includes('approval') && (lower.includes('command') || lower.includes('exec') || !!params.command)
}

function isFileApproval(method: string, params: Record<string, unknown>): boolean {
  const lower = method.toLowerCase()
  return lower.includes('approval') && (lower.includes('file') || lower.includes('patch') || !!params.changes)
}

function previewJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 600)
  } catch {
    return String(value).slice(0, 600)
  }
}

function stringifyToolResult(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function cryptoId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'codex-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
