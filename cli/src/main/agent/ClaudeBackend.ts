import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
  SDKMessage,
  SessionUsageInfo,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import type { AgentBackendHandlers } from './AgentBridge'
import { log } from '../logger'

/**
 * Claude Code 后端（与 Kimi 后端并存，互不影响）。
 *
 * 走 Claude Code CLI 的 stream-json 双向流：
 *   claude --print --output-format stream-json --input-format stream-json --verbose
 * 输入每行一条 `{"type":"user","message":{role,content}}`，输出每行一条消息。
 *
 * **消息几乎直通**：Tran 内部的 SDKMessage 本来就是照 Claude Agent SDK 的形状
 * 定的（`system/init`、`assistant`、`result`、`stream_event`），Kimi 那边是把
 * ACP 翻译成这个形状；到了 Claude 这里反而不需要翻译层，原样转发即可。这也是
 * 渲染层一行都不用改的原因——两个后端在 IPC 面上说同一种话。
 *
 * 与 KimiBackend 的分工：本文件只实现 AgentBackendAdapter 契约，不碰任何
 * Kimi 代码路径。
 */

/** 权限模式映射：Tran 的四档 → Claude Code 的 --permission-mode。 */
const PERMISSION_MODE_MAP: Record<string, string> = {
  default: 'default',
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions'
}

/** Composer 下拉的默认模型清单（用户可在设置里覆盖）。 */
const DEFAULT_CLAUDE_MODELS: ComposerModel[] = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

interface ActiveClaudeSession {
  /** 桥接 id（Tran 侧稳定 id，IPC 全程用它）。 */
  id: string
  cwd: string
  model?: string
  permissionMode: string
  child: ChildProcessWithoutNullStreams
  rl: ReadlineInterface
  /** Claude 侧的 session_id（system/init 下发；resume 用）。 */
  claudeSessionId: string | null
  running: boolean
  /** 进程已被主动关闭：close 事件不再当成异常上报。 */
  closing: boolean
  stderr: string
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  /** 进程还没吐出 init 之前排队的用户消息。 */
  queue: string[]
  started: boolean
}

/** stderr 只留尾部用于报错，避免长会话把内存吃掉（同 AcpClient 的取舍）。 */
const MAX_STDERR = 8000

function resolveClaudeCommand(): { command: string; prefixArgs: string[] } {
  // 用户级安装（Windows 下 claude 装在 ~/.local/bin）优先，其次 PATH。
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (existsSync(local)) return { command: local, prefixArgs: [] }
  const localCmd = join(homedir(), '.local', 'bin', 'claude.cmd')
  if (process.platform === 'win32' && existsSync(localCmd)) {
    // .cmd 必须经 cmd.exe 启动（Node 的 spawn 不认批处理）。
    return { command: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', localCmd] }
  }
  return { command: 'claude', prefixArgs: [] }
}

export class ClaudeBackend {
  readonly id = 'claude' as const
  private sessions = new Map<string, ActiveClaudeSession>()
  private models: ComposerModel[] = DEFAULT_CLAUDE_MODELS

  constructor(private readonly h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    const sessionId = opts.bridgeSessionId ?? randomUUID()
    const permissionMode = PERMISSION_MODE_MAP[opts.permissionMode ?? 'default'] ?? 'default'
    const { command, prefixArgs } = resolveClaudeCommand()

    const args = [
      ...prefixArgs,
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      // --verbose 是 stream-json 下拿到完整事件流（含 system/init）的前提。
      '--verbose',
      // 增量 delta：渲染层的流式打字效果依赖 stream_event。
      '--include-partial-messages',
      '--permission-mode', permissionMode
    ]
    if (opts.model) args.push('--model', opts.model)
    if (opts.resume) args.push('--resume', opts.resume)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env }
      })
    } catch (error) {
      throw new Error(
        `启动 Claude Code 失败：${error instanceof Error ? error.message : String(error)}。` +
          '请确认已安装 Claude Code CLI（claude --version 可用）。'
      )
    }

    const session: ActiveClaudeSession = {
      id: sessionId,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      permissionMode,
      child,
      rl: createInterface({ input: child.stdout, terminal: false }),
      claudeSessionId: opts.resume ?? null,
      running: false,
      closing: false,
      stderr: '',
      queue: [],
      started: false
    }
    this.sessions.set(sessionId, session)

    session.rl.on('line', (line) => this.handleLine(session, line))
    child.stderr.on('data', (chunk: Buffer) => {
      session.stderr = (session.stderr + chunk.toString()).slice(-MAX_STDERR)
    })
    child.on('error', (error) => {
      log('claude', `spawn error: ${error.message}`)
      this.endSession(session, `启动 Claude Code 失败：${error.message}`)
    })
    child.on('close', (code) => {
      if (session.closing) return
      const detail =
        session.stderr.trim() ||
        (code === 0 ? undefined : `Claude Code 进程退出（code ${code ?? 'null'}）`)
      this.endSession(session, detail)
    })

    log('claude', `spawn ${command} cwd=${opts.cwd} model=${opts.model ?? 'default'} mode=${permissionMode}`)
    return sessionId
  }

  /** 输出的每一行都是一条完整 JSON 消息。 */
  private handleLine(session: ActiveClaudeSession, line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: SDKMessage & Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as SDKMessage & Record<string, unknown>
    } catch {
      // 非 JSON 行（CLI 偶发的裸日志）不该打断会话，记一笔即可。
      log('claude', `non-JSON line: ${trimmed.slice(0, 200)}`)
      return
    }

    // 记住 Claude 侧 session_id：侧栏条目、resume 都用它。
    const sid = typeof msg['session_id'] === 'string' ? (msg['session_id'] as string) : null
    if (sid && session.claudeSessionId !== sid) session.claudeSessionId = sid

    if (msg.type === 'system' && msg['subtype'] === 'init') {
      session.started = true
      // 队列里排的消息现在可以发了。
      const queued = session.queue.splice(0)
      for (const text of queued) this.writeUser(session, text)
    }

    if (msg.type === 'assistant' && !session.running) {
      session.running = true
      this.h.onSessionRunning?.(session.id, true, session.claudeSessionId ?? undefined, Date.now())
    }

    if (msg.type === 'result') {
      const usage = msg['usage'] as Record<string, number> | undefined
      if (usage) {
        session.lastUsage = {
          inputTokens: usage['input_tokens'],
          outputTokens: usage['output_tokens'],
          totalTokens: (usage['input_tokens'] ?? 0) + (usage['output_tokens'] ?? 0)
        }
      }
      session.running = false
      this.h.onSessionRunning?.(session.id, false, session.claudeSessionId ?? undefined)
    }

    // 直通：形状与渲染层期待的一致，不做翻译。
    this.h.onMessage(session.id, msg)
  }

  private writeUser(session: ActiveClaudeSession, content: string): void {
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    })
    try {
      session.child.stdin.write(payload + '\n')
    } catch (error) {
      log('claude', `stdin write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  send(sessionId: string, content: string | unknown[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // 附件等结构化内容先降级成文本：Claude Code 的 stream-json 输入接受
    // content 数组，但块类型与 Tran 的附件形状未逐一验证，v1 只保证文本可靠。
    const text =
      typeof content === 'string'
        ? content
        : content
            .map((block) => {
              const b = block as Record<string, unknown>
              return typeof b['text'] === 'string' ? (b['text'] as string) : ''
            })
            .filter(Boolean)
            .join('\n')
    if (!session.started) {
      session.queue.push(text)
      return
    }
    this.writeUser(session, text)
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // v1 用进程级中断：Claude Code 的 control 协议（interrupt_receipt_v1）
    // 需要与 CLI 实测对齐，先用可靠的做法——kill 后会话可 resume 续接。
    this.killChild(session)
    this.endSession(session, undefined)
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.model = model
    // 模型是 spawn 参数，改动在下次会话启动时生效（渲染层已有重开会话的流程）。
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session.permissionMode = PERMISSION_MODE_MAP[mode] ?? 'default'
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.killChild(session)
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.killChild(session)
    this.sessions.clear()
  }

  private killChild(session: ActiveClaudeSession): void {
    session.closing = true
    try {
      session.rl.close()
    } catch {
      /* ignore */
    }
    const child = session.child
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end()
      } catch {
        /* ignore */
      }
      try {
        // Windows 上 claude 可能经 cmd.exe 包装，必须整棵树杀（同 AcpClient）。
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
        } else {
          child.kill()
        }
      } catch {
        /* ignore */
      }
    }
  }

  private endSession(session: ActiveClaudeSession, error?: string): void {
    if (session.running) {
      session.running = false
      this.h.onSessionRunning?.(session.id, false, session.claudeSessionId ?? undefined)
    }
    this.sessions.delete(session.id)
    this.h.onEnded(session.id, error)
  }

  runningAcpSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.running && s.claudeSessionId) ids.add(s.claudeSessionId)
    }
    return ids
  }

  liveAcpSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const s of this.sessions.values()) {
      if (s.claudeSessionId) ids.add(s.claudeSessionId)
    }
    return ids
  }

  /** MCP 服务器：init 消息里带 mcp_servers，但 v1 不做增删改（Claude Code
   *  自己管理 .mcp.json），面板显示空列表比显示错误信息干净。 */
  async listMcpServers(): Promise<McpServerEntry[]> {
    return []
  }

  async refreshMcpServers(): Promise<McpServerEntry[]> {
    return []
  }

  async toggleMcpServer(): Promise<void> {
    throw new Error('Claude Code 后端暂不支持在 Tran 里开关 MCP 服务器')
  }

  async backgroundTask(): Promise<boolean> {
    return false
  }

  async listSkills(): Promise<SkillInfo[]> {
    return []
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const session = this.sessions.get(sessionId)
    return {
      inputTokens: session?.lastUsage?.inputTokens,
      outputTokens: session?.lastUsage?.outputTokens,
      totalTokens: session?.lastUsage?.totalTokens,
      // Claude 系列的上下文窗口按 200k 计（result 消息不下发窗口上限）。
      contextSize: 200_000,
      ...(session?.model ? { model: session.model } : {})
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    return this.models
  }

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    return []
  }

  respondPermission(_resp: PermissionResponsePayload): boolean {
    // v1 不接管权限询问：权限由 --permission-mode 决定（逐条确认 = Claude Code
    // 自己的 default 模式）。控制协议（can_use_tool）待与 CLI 实测对齐后再接。
    return false
  }
}
