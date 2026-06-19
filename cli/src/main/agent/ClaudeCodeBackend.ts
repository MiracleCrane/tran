import type {
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  PermissionUpdate,
  McpServerStatus,
  SlashCommand
} from '@anthropic-ai/claude-agent-sdk'
import type {
  StartSessionOptions,
  PermissionRequestPayload,
  PermissionResponsePayload,
  McpServerEntry,
  SkillInfo,
  ComposerModel,
  MarketplacePlugin
} from '../../shared/ipc'
import { DEFAULT_CLAUDE_MODELS } from '../../shared/models'
import { log } from '../logger'
import { getActiveProvider } from '../providers'
import { getPreferences } from '../preferences'
import { listClaudeMarketplacePlugins } from '../marketplace'
import { spawnClaudeViaWsl } from '../wslClaude'
import { resolveWindowsClaudeCommand, spawnClaudeViaWindowsPath } from '../windowsClaude'

/**
 * The Claude Agent SDK is ESM-only and relies on `import.meta.url` to locate its
 * bundled native binary, so it must load as real ESM. We load it with a dynamic
 * import (allowed from this CJS main) and cache the module promise.
 */
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
let sdkPromise: Promise<SdkModule> | null = null
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

export interface AgentBackendHandlers {
  onMessage: (sessionId: string, message: SDKMessage) => void
  onEnded: (sessionId: string, error?: string) => void
  onPermissionRequest: (req: PermissionRequestPayload) => void
}

interface ActiveSession {
  id: string
  // deno-lint-ignore no-explicit-any
  query: any
  push: (content: string | unknown[]) => void
  close: () => void
}

interface CanUseToolCtx {
  signal: AbortSignal
  toolUseID: string
  suggestions?: PermissionUpdate[]
  decisionReason?: string
  agentID?: string
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
}
const pendingPermissions = new Map<string, PendingPermission>()

/**
 * Owns the Claude Agent SDK query handles, one per active session. Each session
 * uses streaming-input mode (a long-lived query fed by a push-controller) so the
 * renderer can send follow-up messages and call interrupt() without respawning.
 */
export class ClaudeCodeBackend {
  readonly id = 'claude-code' as const
  private sessions = new Map<string, ActiveSession>()

  constructor(private h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    const sessionId = opts.bridgeSessionId ?? cryptoId()
    log('bridge', `start session=${sessionId} cwd=${opts.cwd} model=${opts.model ?? 'default'} hasKey=${!!opts.apiKey} resume=${!!opts.resume}`)
    const stream = makeInputStream()

    // Register SYNCHRONOUSLY so a renderer-generated bridgeSessionId is usable
    // for sendMessage immediately. The claude.exe subprocess spawns in the
    // background; any messages pushed before it's ready simply queue in the
    // stream and are consumed once the SDK is ready. This keeps the UI unlocked.
    const session: ActiveSession = {
      id: sessionId,
      query: null,
      push: stream.push,
      close: () => stream.close()
    }
    this.sessions.set(sessionId, session)

    void this.spawn(sessionId, stream, opts).catch((e) => {
      log('bridge', `spawn failed session=${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
      this.h.onEnded(sessionId, e instanceof Error ? e.message : String(e))
      this.sessions.delete(sessionId)
    })

    return sessionId
  }

  private async spawn(
    sessionId: string,
    stream: {
      iterable: AsyncIterable<SDKUserMessage>
      push: (text: string) => void
      close: () => void
    },
    opts: StartSessionOptions
  ): Promise<void> {
    const { query } = await loadSdk()
    // Apply the active API provider + user preferences as defaults.
    const provider = getActiveProvider()
    const prefs = getPreferences()
    const useWslClaude =
      prefs.wslSupportEnabled === true &&
      prefs.claudeExecutionBackend === 'wsl' &&
      process.platform === 'win32'
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    if (provider) {
      env['ANTHROPIC_BASE_URL'] = provider.baseUrl
      if (provider.authType === 'apikey') {
        env['ANTHROPIC_API_KEY'] = provider.token
        delete env['ANTHROPIC_AUTH_TOKEN']
      } else {
        env['ANTHROPIC_AUTH_TOKEN'] = provider.token
        delete env['ANTHROPIC_API_KEY']
      }
    }
    const selectedModel = opts.model ?? provider?.model ?? 'claude-opus-4-8'
    log('bridge', `resolved model session=${sessionId} selected=${selectedModel} opts=${opts.model ?? '(none)'} provider=${provider?.model ?? '(none)'}`)
    env['ANTHROPIC_MODEL'] = selectedModel
    const windowsClaude =
      !useWslClaude && process.platform === 'win32'
        ? resolveWindowsClaudeCommand(env)
        : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      cwd: opts.cwd,
      // opts.model (synced to the active provider by the renderer) wins; fall
      // back to the provider's own default, then the hard-coded default.
      model: selectedModel,
      settings: { model: selectedModel },
      effort: opts.effort ?? prefs.defaultEffort ?? 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      includePartialMessages: true,
      stderr: (data: string) => log('claude-stderr', data.trimEnd()),
      settingSources: ['user', 'project', 'local'],
      permissionMode: opts.permissionMode ?? prefs.defaultPermissionMode ?? 'default',
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        ctx: CanUseToolCtx
      ) => this.handlePermission(toolName, input, ctx),
      env,
      ...(useWslClaude
        ? { pathToClaudeCodeExecutable: 'claude', spawnClaudeCodeProcess: spawnClaudeViaWsl }
        : process.platform === 'win32'
          ? {
              pathToClaudeCodeExecutable: windowsClaude?.command,
              spawnClaudeCodeProcess: spawnClaudeViaWindowsPath
            }
          : {}),
      ...(opts.resume ? { resume: opts.resume } : {})
    }
    const q = query({ prompt: stream.iterable, options })
    const session = this.sessions.get(sessionId)
    if (!session) {
      // Closed before spawn finished.
      q.close?.()
      return
    }
    session.query = q
    this.drain(sessionId, q)
  }

  private async drain(sessionId: string, q: AsyncIterable<SDKMessage>): Promise<void> {
    log('drain', `start session=${sessionId}`)
    let count = 0
    let sawAssistant = false
    let sawResult = false
    let sawApiRetry = false
    try {
      for await (const msg of q) {
        count++
        const sub = (msg as { subtype?: string }).subtype
        if (msg.type === 'assistant') sawAssistant = true
        if (msg.type === 'result') sawResult = true
        if (msg.type === 'system' && sub === 'api_retry') sawApiRetry = true
        let extra = ''
        if (msg.type === 'system' && sub === 'init') {
          const init = msg as { model?: string; session_id?: string }
          extra = ` model=${init.model ?? '(none)'} sdkSession=${init.session_id ?? '(none)'}`
        } else if (msg.type === 'stream_event') {
          const ev = (msg as { event?: { type?: string; message?: { id?: string } } }).event
          if (ev?.type === 'message_start') extra = ` msgId=${ev.message?.id}`
        } else if (msg.type === 'assistant') {
          const mm = msg as { message?: { id?: string }; uuid?: string }
          extra = ` msg.id=${mm.message?.id} uuid=${mm.uuid}`
        }
        log('drain', `msg #${count} type=${msg.type}${sub ? '/' + sub : ''}${extra}`)
        this.h.onMessage(sessionId, msg)
      }
      const endedError =
        !sawResult && !sawAssistant && sawApiRetry
          ? 'Claude Code 在多次 api_retry 后没有返回结果。请检查当前运营商、模型和网络。'
          : undefined
      log('drain', `generator completed normally after ${count} msgs${endedError ? ` error=${endedError}` : ''}`)
      this.h.onEnded(sessionId, endedError)
    } catch (e) {
      log('drain', `THREW after ${count} msgs: ${e instanceof Error ? e.stack : String(e)}`)
      this.h.onEnded(sessionId, e instanceof Error ? e.message : String(e))
    } finally {
      log('drain', `finally: deleting session=${sessionId} (remaining=${this.sessions.size})`)
      this.sessions.delete(sessionId)
    }
  }

  send(sessionId: string, content: string | unknown[]): void {
    log('bridge', `send session=${sessionId} sessionsKnown=${this.sessions.size} content=${typeof content === 'string' ? JSON.stringify(content.slice(0, 80)) : '(blocks)'}`)
    const s = this.sessions.get(sessionId)
    if (!s) {
      log('bridge', `send FAILED: session not found ${sessionId}`)
      throw new Error(`session not found: ${sessionId}`)
    }
    s.push(content)
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.query) return
    await s.query.interrupt?.().catch(() => {})
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const q = await this.awaitQuery(sessionId)
    log('bridge', `set model session=${sessionId} model=${model}`)
    if (typeof q.applyFlagSettings !== 'function') {
      throw new Error('当前 Claude Code SDK 不支持静默模型切换。')
    }
    await q.applyFlagSettings({ model })
    if (typeof q.getSettings === 'function') {
      const settings = await q.getSettings().catch(() => null)
      const actualModel = (settings as { model?: unknown } | null)?.model
      if (typeof actualModel === 'string' && actualModel && actualModel !== model) {
        throw new Error(`模型切换未生效：当前仍为 ${actualModel}`)
      }
    }
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.query) return
    await s.query.setPermissionMode?.(mode).catch(() => {})
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.close()
    s.query?.close?.()
    this.sessions.delete(sessionId)
  }

  /**
   * List every MCP server the active session knows about, with live connection
   * status. The query handle isn't ready until claude.exe finishes spawning, so
   * we briefly await it — the renderer's IPC call blocks during that window.
   */
  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const q = await this.awaitQuery(sessionId)
    const status = (await q.mcpServerStatus()) as McpServerStatus[]
    return status.map(toEntry)
  }

  /** Enable/disable an MCP server by name (persists to settings). */
  async toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void> {
    const q = await this.awaitQuery(sessionId)
    await q.toggleMcpServer(name, enabled)
  }

  /** Move an in-flight foreground subagent (or Bash) to the background so the
   *  main agent's turn can continue / the user can keep chatting. */
  async backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean> {
    const q = await this.awaitQuery(sessionId)
    return await q.backgroundTasks(toolUseId)
  }

  /** Skills available to the session (the SDK surfaces skills as slash commands). */
  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const q = await this.awaitQuery(sessionId)
    const cmds = (await q.supportedCommands()) as SlashCommand[]
    return cmds.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint || undefined,
      aliases: c.aliases
    }))
  }

  async listModels(): Promise<ComposerModel[]> {
    return DEFAULT_CLAUDE_MODELS
  }

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    return listClaudeMarketplacePlugins()
  }

  /**
   * Resolve the live query handle for a session, waiting up to ~5s for claude.exe
   * to finish spawning. Throws if the session is unknown or never becomes ready.
   */
  private async awaitQuery(sessionId: string): Promise<NonNullable<ActiveSession['query']>> {
    if (!this.sessions.has(sessionId)) {
      throw new Error('没有活跃的会话。请先开始一个对话,再管理 MCP 服务器。')
    }
    for (let i = 0; i < 50; i++) {
      const q = this.sessions.get(sessionId)?.query
      if (q) return q
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('会话仍在启动中,请稍后重试。')
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: CanUseToolCtx
  ): Promise<PermissionResult> {
    log('bridge', `permission request tool=${toolName} id=${ctx.toolUseID}`)
    return new Promise<PermissionResult>((resolve) => {
      pendingPermissions.set(ctx.toolUseID, { resolve, input })
      this.h.onPermissionRequest({
        toolUseID: ctx.toolUseID,
        toolName,
        input,
        suggestions: ctx.suggestions,
        decisionReason: ctx.decisionReason,
        agentID: ctx.agentID
      })
      ctx.signal.addEventListener('abort', () => {
        if (pendingPermissions.has(ctx.toolUseID)) {
          pendingPermissions.delete(ctx.toolUseID)
          resolve({ behavior: 'deny', message: 'interrupted' })
        }
      })
    })
  }

  respondPermission(resp: PermissionResponsePayload): boolean {
    log('bridge', `permission respond id=${resp.toolUseID} behavior=${resp.behavior}`)
    const pending = pendingPermissions.get(resp.toolUseID)
    if (!pending) return false
    pendingPermissions.delete(resp.toolUseID)
    pending.resolve(
      // claude.exe validates an `allow` with a Zod schema that requires
      // updatedInput to be a record — pass the (unchanged) input back through.
      resp.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: withPermissionAnswers(pending.input, resp.answers) }
        : { behavior: 'deny', message: resp.message ?? 'denied' }
    )
    return true
  }
}

/** Push-controller-backed async iterable for streaming-input mode. */
function makeInputStream(): {
  iterable: AsyncIterable<SDKUserMessage>
  push: (content: string | unknown[]) => void
  close: () => void
} {
  const queue: SDKUserMessage[] = []
  let resolveNext: (() => void) | null = null
  let closed = false

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length) return { value: queue.shift()!, done: false }
          if (closed) return { value: undefined as unknown as SDKUserMessage, done: true }
          await new Promise<void>((r) => {
            resolveNext = r
          })
          resolveNext = null
          if (queue.length) return { value: queue.shift()!, done: false }
          return { value: undefined as unknown as SDKUserMessage, done: true }
        }
      }
    }
  }

  return {
    iterable,
    push(content: string | unknown[]) {
      if (closed) return
      queue.push({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content }
      } as unknown as SDKUserMessage)
      resolveNext?.()
      resolveNext = null
    },
    close() {
      closed = true
      resolveNext?.()
      resolveNext = null
    }
  }
}

function cryptoId(): string {
  // Prefer global crypto.randomUUID (Node 19+/Electron), fall back to a rand.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function withPermissionAnswers(
  input: Record<string, unknown>,
  answers?: Record<string, unknown>
): Record<string, unknown> {
  return answers ? { ...input, answers } : input
}

/** Trim an SDK McpServerStatus down to the serializable shape the renderer uses. */
function toEntry(s: McpServerStatus): McpServerEntry {
  // Pass the raw config through verbatim (only defaulting `type`) so advanced
  // keys (timeout, alwaysLoad, tools policy, …) survive for faithful JSON view/edit.
  const cfg = s.config as Record<string, unknown> | undefined
  return {
    name: s.name,
    status: s.status,
    scope: s.scope,
    serverInfo: s.serverInfo,
    error: s.error,
    tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
    config: cfg ? { ...cfg, type: (cfg['type'] as string | undefined) ?? 'stdio' } : undefined
  }
}
