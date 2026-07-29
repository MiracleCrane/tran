import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { ClaudeStreamClient } from './ClaudeStreamClient'
import type {
  ComposerModel,
  PermissionMode,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
  SDKMessage,
  SessionUsageInfo,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import type { AgentBackendHandlers } from './AgentBridge'

/**
 * Claude Code CLI 后端（stream-json 通道）。
 *
 * 与 KimiBackend 的根本差别：KimiBackend 要把 ACP 的事件**合成**成 Agent SDK
 * 的消息形状（Tran 的渲染层就是照那个形状建的），而 Claude Code 原生就吐这个
 * 形状——所以这里绝大多数消息直接透传，不做翻译。
 *
 * 进程模型也不同：ACP 是一个长连接多会话，Claude Code 的 `-p --input-format
 * stream-json` 是**一个进程一个会话**。因此这里每个会话各持一个子进程。
 *
 * 当前实现范围（阶段 1）：会话生命周期、消息收发、中断、模型/权限档、
 * 用量。MCP / 技能 / 会话历史 / 子代理面板留待阶段 2（见各方法注释）。
 */

interface ActiveClaudeSession {
  id: string
  cwd: string
  model?: string
  permissionMode?: PermissionMode
  /** Claude 侧会话 id（--session-id 传入的 uuid；resume 时为被恢复的 id）。 */
  claudeSessionId: string
  client: ClaudeStreamClient | null
  /** 进程尚未就绪时的排队消息。 */
  queue: Array<string | unknown[]>
  running: boolean
  startedAt?: number
  closed: boolean
  ready: Promise<void>
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

/** Tran 的权限档 → Claude Code 的 --permission-mode（`claude --help` 实证值）。 */
const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'manual',
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions'
}

/** 上下文窗口缺省值（Claude Code 的 result 帧不上报窗口上限）。 */
const CLAUDE_CONTEXT_SIZE = 200_000

/** Composer 下拉的默认模型（别名形式，Claude Code 自行解析到具体版本）。 */
const CLAUDE_MODELS: ComposerModel[] = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export class ClaudeBackend {
  readonly id = 'claude' as const
  private sessions = new Map<string, ActiveClaudeSession>()

  constructor(private readonly h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    const sessionId = opts.bridgeSessionId ?? randomUUID()
    // resume 时沿用原 id；新会话自己生成一个 uuid 交给 --session-id，
    // 这样 Tran 在 system/init 到达之前就已经知道会话 id 了。
    const claudeSessionId = opts.resume ?? randomUUID()

    const session: ActiveClaudeSession = {
      id: sessionId,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      claudeSessionId,
      client: null,
      queue: [],
      running: false,
      closed: false,
      ready: Promise.resolve()
    }
    this.sessions.set(sessionId, session)

    session.ready = this.spawnFor(session, opts).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      log('claude', `会话启动失败：${message}`)
      this.h.onEnded(sessionId, message)
      this.sessions.delete(sessionId)
      throw error
    })
    // 启动失败已在上面处理，这里吞掉拒绝避免未处理拒绝。
    session.ready.catch(() => {})

    return sessionId
  }

  private async spawnFor(session: ActiveClaudeSession, opts: StartSessionOptions): Promise<void> {
    const client = await ClaudeStreamClient.start(
      {
        cwd: session.cwd,
        sessionId: session.claudeSessionId,
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(session.model ? { model: session.model } : {}),
        ...(session.permissionMode
          ? { permissionMode: PERMISSION_MODE_MAP[session.permissionMode] ?? 'manual' }
          : {})
      },
      {
        onMessage: (message) => this.handleMessage(session, message),
        onClose: (error) => this.handleClose(session, error)
      },
      `claude-${session.id.slice(0, 8)}`
    )
    if (session.closed) {
      client.close()
      return
    }
    session.client = client
    this.drain(session)
  }

  /**
   * Claude Code 的消息形状与 Tran 的渲染层一致（Tran 本就是照 Agent SDK 建的），
   * 所以这里只做三件事：抽会话状态、透传、维护 running 标记。
   */
  private handleMessage(session: ActiveClaudeSession, message: Record<string, unknown>): void {
    if (session.closed) return
    const type = message.type

    if (type === 'system' && message.subtype === 'init') {
      // Claude 回报的 session_id 是权威值（resume 时可能与请求的不同）。
      const reported = asString(message.session_id)
      if (reported) session.claudeSessionId = reported
      this.markRunning(session, false)
    }

    if (type === 'stream_event' || type === 'assistant') {
      // 有输出即视为该轮在跑（Claude Code 不单独推 turn 开始信号）。
      if (!session.running) this.markRunning(session, true)
    }

    if (type === 'result') {
      const usage = asRecord(message.usage)
      if (usage) {
        session.lastUsage = {
          ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {})
        }
      }
      this.markRunning(session, false)
    }

    this.h.onMessage(session.id, message as unknown as SDKMessage)
  }

  private markRunning(session: ActiveClaudeSession, running: boolean): void {
    if (session.running === running) return
    session.running = running
    if (running) session.startedAt = Date.now()
    else delete session.startedAt
    this.h.onSessionRunning?.(
      session.id,
      running,
      session.claudeSessionId,
      running ? session.startedAt : undefined
    )
  }

  private handleClose(session: ActiveClaudeSession, error?: string): void {
    session.client = null
    this.markRunning(session, false)
    if (session.closed) return
    this.h.onEnded(session.id, error)
    this.sessions.delete(session.id)
  }

  send(sessionId: string, content: string | unknown[]): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) return
    session.queue.push(content)
    this.drain(session)
  }

  private drain(session: ActiveClaudeSession): void {
    const client = session.client
    if (!client) return
    while (session.queue.length > 0) {
      const next = session.queue.shift()
      if (next === undefined) break
      client.send(next)
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // stream-json 通道没有「取消当前轮」的控制消息：关掉进程即中断。
    // 会话内容已落盘，下一条消息会以 --resume 重新拉起（见 restart）。
    session.client?.close()
    session.client = null
    this.markRunning(session, false)
    await this.restart(session)
  }

  /** 用同一个 claudeSessionId 以 resume 方式重新拉起进程（中断/进程死亡后）。 */
  private async restart(session: ActiveClaudeSession): Promise<void> {
    if (session.closed) return
    session.ready = this.spawnFor(session, {
      cwd: session.cwd,
      resume: session.claudeSessionId,
      ...(session.model ? { model: session.model } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {})
    }).catch((error: unknown) => {
      log('claude', `重启失败：${error instanceof Error ? error.message : String(error)}`)
    })
    await session.ready
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.model = model
    // --model 是启动参数，改它要重开进程；会话内容靠 resume 保留。
    session.client?.close()
    session.client = null
    await this.restart(session)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.permissionMode = mode as PermissionMode
    session.client?.close()
    session.client = null
    await this.restart(session)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.closed = true
    session.client?.close()
    session.client = null
    this.sessions.delete(sessionId)
  }

  /** 切走后台化：Claude Code 一进程一会话，进程留着继续跑即可。 */
  background(_sessionId: string): void {
    /* 不做任何事：进程本就独立于前台状态 */
  }

  runningAcpSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.running) ids.add(session.claudeSessionId)
    }
    return ids
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.closed = true
      session.client?.close()
    }
    this.sessions.clear()
  }

  // --- 阶段 2 待实现（先返回空值，不影响会话主流程） ---

  /** TODO(阶段 2)：`claude mcp list --json` 或 stream-json 的 system/init
   *  里的 mcp_servers 字段。 */
  async listMcpServers(_sessionId: string): Promise<McpServerEntry[]> {
    return []
  }

  async refreshMcpServers(_sessionId: string): Promise<McpServerEntry[]> {
    return []
  }

  async toggleMcpServer(_sessionId: string, _name: string, _enabled: boolean): Promise<void> {
    /* TODO(阶段 2) */
  }

  async backgroundTask(_sessionId: string, _toolUseId?: string): Promise<boolean> {
    return false
  }

  /** TODO(阶段 2)：system/init 会带 slash_commands 列表。 */
  async listSkills(_sessionId: string): Promise<SkillInfo[]> {
    return []
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const session = this.sessions.get(sessionId)
    const usage = session?.lastUsage
    return {
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      // TODO(阶段 2)：按模型查表。Claude Code 的 result 帧不带窗口上限。
      contextSize: CLAUDE_CONTEXT_SIZE,
      ...(session?.model ? { model: session.model } : {})
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    return [...CLAUDE_MODELS]
  }

  async listMarketplacePlugins(_cwd?: string): Promise<MarketplacePlugin[]> {
    return []
  }

  /** TODO(阶段 2)：接 `--permission-prompt-tool` 或 canUseTool 回调。
   *  当前依赖 --permission-mode 由 CLI 侧自行决策，Tran 不弹窗。 */
  respondPermission(_resp: PermissionResponsePayload): boolean {
    return false
  }
}
