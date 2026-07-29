import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { ClaudeStreamClient } from './ClaudeStreamClient'
import { listClaudeSessions } from '../claudeHistory'
import type {
  ComposerModel,
  PermissionMode,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
  SDKMessage,
  SessionListItem,
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
  /** system/init 上报的上下文窗口（result.modelUsage 里才有真值，见 handleMessage）。 */
  contextSize?: number
  /** system/init 的 mcp_servers / slash_commands 快照。 */
  mcpServers: McpServerEntry[]
  skills: SkillInfo[]
  /** 最近一帧 rate_limit_event 的原始信息（额度面板用）。 */
  rateLimit?: Record<string, unknown>
}

/** Tran 的权限档 → Claude Code 的 --permission-mode（`claude --help` 实证值）。 */
const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'manual',
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions'
}

/** 首个 result 帧到达前的兜底窗口值。真值来自 result.modelUsage
 *  （实测 claude-sonnet-5 为 1_000_000）。 */
const CLAUDE_CONTEXT_FALLBACK = 200_000

/** system/init 的 mcp_servers → Tran 的 McpServerEntry。CLI 只给 name/status，
 *  不给工具明细，面板据此显示。 */
function parseInitMcpServers(value: unknown): McpServerEntry[] {
  if (!Array.isArray(value)) return []
  const out: McpServerEntry[] = []
  for (const raw of value) {
    const rec = asRecord(raw)
    const name = rec ? asString(rec.name) : undefined
    if (!name) continue
    const status = rec ? asString(rec.status) : undefined
    out.push({
      name,
      status:
        status === 'connected' || status === 'failed' || status === 'needs-auth' || status === 'disabled'
          ? status
          : 'pending'
    })
  }
  return out
}

/** slash_commands（字符串数组）或 commands（对象数组）→ SkillInfo。 */
function parseInitSkills(value: unknown): SkillInfo[] {
  if (!Array.isArray(value)) return []
  const out: SkillInfo[] = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      out.push({ name: raw, description: '' })
      continue
    }
    const rec = asRecord(raw)
    const name = rec ? asString(rec.name) : undefined
    if (!name) continue
    out.push({
      name,
      description: (rec ? asString(rec.description) : undefined) ?? '',
      ...(rec && asString(rec.argumentHint) ? { argumentHint: asString(rec.argumentHint) as string } : {})
    })
  }
  return out
}

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
      mcpServers: [],
      skills: [],
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
      session.mcpServers = parseInitMcpServers(message.mcp_servers)
      session.skills = parseInitSkills(message.slash_commands)
      this.markRunning(session, false)
    }

    // 实测：turn 起止有明确信号，不必从 stream_event 反推。
    //   {"type":"system","subtype":"status","status":"requesting"}
    if (type === 'system' && message.subtype === 'status') {
      if (asString(message.status) === 'requesting') this.markRunning(session, true)
    }

    // 实测：--replay-user-messages 的回显带 isReplay:true。它只是「已收到」的
    // 确认信号，转发给渲染层会变成重复的用户气泡。
    if (type === 'user' && message.isReplay === true) return

    // 实测：斜杠命令是单独一帧推的（system/commands_changed），不只在 init 里。
    if (type === 'system' && message.subtype === 'commands_changed') {
      session.skills = parseInitSkills(message.commands)
    }

    // 实测：每轮开始时推一帧配额信息（five_hour 窗口 + 重置时间戳）。
    // 这是 Claude 后端唯一的额度来源（没有 kimi 那套 /usage 隐藏轮）。
    if (type === 'rate_limit_event') {
      const info = asRecord(message.rate_limit_info)
      if (info) session.rateLimit = info
    }

    if (type === 'result') {
      const usage = asRecord(message.usage)
      if (usage) {
        const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
        const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
        session.lastUsage = {
          ...(input !== undefined ? { inputTokens: input } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
          ...(input !== undefined && output !== undefined ? { totalTokens: input + output } : {})
        }
      }
      // 实测：result.modelUsage.<model>.contextWindow 才是真实窗口
      //（sonnet-5 实测 1_000_000），不要按模型名猜。
      const modelUsage = asRecord(message.modelUsage)
      if (modelUsage) {
        for (const entry of Object.values(modelUsage)) {
          const rec = asRecord(entry)
          const window = rec && typeof rec.contextWindow === 'number' ? rec.contextWindow : undefined
          if (window) {
            session.contextSize = window
            break
          }
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

  /** system/init 的 mcp_servers 快照（实测该字段存在，形如
   *  [{name, status}]；工具明细 CLI 不给，面板显示为无工具列表）。 */
  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    const session = this.sessions.get(sessionId)
    await session?.ready.catch(() => {})
    return [...(session?.mcpServers ?? [])]
  }

  /** CLI 侧没有「重连 MCP」的通道，只能返回最近一次 init 的快照。 */
  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.listMcpServers(sessionId)
  }

  async toggleMcpServer(_sessionId: string, _name: string, _enabled: boolean): Promise<void> {
    /* TODO(阶段 2) */
  }

  async backgroundTask(_sessionId: string, _toolUseId?: string): Promise<boolean> {
    return false
  }

  /** system/init 与 system/commands_changed 都会带命令列表（实测）。 */
  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const session = this.sessions.get(sessionId)
    await session?.ready.catch(() => {})
    return [...(session?.skills ?? [])]
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const session = this.sessions.get(sessionId)
    const usage = session?.lastUsage
    return {
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      contextSize: session?.contextSize ?? CLAUDE_CONTEXT_FALLBACK,
      ...(session?.model ? { model: session.model } : {})
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    return [...CLAUDE_MODELS]
  }

  async listMarketplacePlugins(_cwd?: string): Promise<MarketplacePlugin[]> {
    return []
  }

  /** 会话历史：直读 ~/.claude/projects/<cwd 编码>/*.jsonl（实测布局）。 */
  listSessions(cwd: string, opts?: { limit?: number; offset?: number; scope?: 'project' | 'all' }): SessionListItem[] {
    return listClaudeSessions(cwd, opts ?? {})
  }

  /** 最近一帧配额信息（rate_limit_event）。 */
  getRateLimit(sessionId: string): Record<string, unknown> | null {
    return this.sessions.get(sessionId)?.rateLimit ?? null
  }

  /** TODO(阶段 2)：接 `--permission-prompt-tool` 或 canUseTool 回调。
   *  当前依赖 --permission-mode 由 CLI 侧自行决策，Tran 不弹窗。 */
  respondPermission(_resp: PermissionResponsePayload): boolean {
    return false
  }
}
