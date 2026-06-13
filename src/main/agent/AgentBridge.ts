import type {
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  PermissionUpdate
} from '@anthropic-ai/claude-agent-sdk'
import type {
  StartSessionOptions,
  PermissionRequestPayload,
  PermissionResponsePayload
} from '../../shared/ipc'
import { log } from '../logger'

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

export interface AgentBridgeHandlers {
  onMessage: (sessionId: string, message: SDKMessage) => void
  onEnded: (sessionId: string, error?: string) => void
  onPermissionRequest: (req: PermissionRequestPayload) => void
}

interface ActiveSession {
  id: string
  // deno-lint-ignore no-explicit-any
  query: any
  push: (text: string) => void
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
export class AgentBridge {
  private sessions = new Map<string, ActiveSession>()

  constructor(private h: AgentBridgeHandlers) {}

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      cwd: opts.cwd,
      model: opts.model ?? 'claude-opus-4-8',
      effort: opts.effort ?? 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      includePartialMessages: true,
      stderr: (data: string) => log('claude-stderr', data.trimEnd()),
      settingSources: ['user', 'project', 'local'],
      permissionMode: opts.permissionMode ?? 'default',
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        ctx: CanUseToolCtx
      ) => this.handlePermission(toolName, input, ctx),
      env: { ...process.env, ...(opts.apiKey ? { ANTHROPIC_API_KEY: opts.apiKey } : {}) },
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
    try {
      for await (const msg of q) {
        count++
        const sub = (msg as { subtype?: string }).subtype
        let extra = ''
        if (msg.type === 'stream_event') {
          const ev = (msg as { event?: { type?: string; message?: { id?: string } } }).event
          if (ev?.type === 'message_start') extra = ` msgId=${ev.message?.id}`
        } else if (msg.type === 'assistant') {
          const mm = msg as { message?: { id?: string }; uuid?: string }
          extra = ` msg.id=${mm.message?.id} uuid=${mm.uuid}`
        }
        log('drain', `msg #${count} type=${msg.type}${sub ? '/' + sub : ''}${extra}`)
        this.h.onMessage(sessionId, msg)
      }
      log('drain', `generator completed normally after ${count} msgs`)
      this.h.onEnded(sessionId)
    } catch (e) {
      log('drain', `THREW after ${count} msgs: ${e instanceof Error ? e.stack : String(e)}`)
      this.h.onEnded(sessionId, e instanceof Error ? e.message : String(e))
    } finally {
      log('drain', `finally: deleting session=${sessionId} (remaining=${this.sessions.size})`)
      this.sessions.delete(sessionId)
    }
  }

  send(sessionId: string, text: string): void {
    log('bridge', `send session=${sessionId} sessionsKnown=${this.sessions.size} text=${JSON.stringify(text.slice(0, 80))}`)
    const s = this.sessions.get(sessionId)
    if (!s) {
      log('bridge', `send FAILED: session not found ${sessionId}`)
      throw new Error(`session not found: ${sessionId}`)
    }
    s.push(text)
  }

  async interrupt(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.query) return
    await s.query.interrupt?.().catch(() => {})
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.query) return
    await s.query.setModel?.(model).catch(() => {})
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

  respondPermission(resp: PermissionResponsePayload): void {
    log('bridge', `permission respond id=${resp.toolUseID} behavior=${resp.behavior}`)
    const pending = pendingPermissions.get(resp.toolUseID)
    if (!pending) return
    pendingPermissions.delete(resp.toolUseID)
    pending.resolve(
      // claude.exe validates an `allow` with a Zod schema that requires
      // updatedInput to be a record — pass the (unchanged) input back through.
      resp.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: resp.message ?? 'denied' }
    )
  }
}

/** Push-controller-backed async iterable for streaming-input mode. */
function makeInputStream(): {
  iterable: AsyncIterable<SDKUserMessage>
  push: (text: string) => void
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
    push(text: string) {
      if (closed) return
      queue.push({
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: text }
      })
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
