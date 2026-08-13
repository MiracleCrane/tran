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
  McpServerStatusKind,
  PermissionResponsePayload,
  PermissionUpdate,
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
  // Tran 的档位语义见 Composer.tsx：
  //   yolo =「自动通过」自动批准工具、关键问题仍会问  → acceptEdits
  //   auto =「完全自主」完全无人值守、什么都不问      → bypassPermissions
  // 这两个此前接反了：选「自动通过」这个中间档，实际拿到的是 Claude 最危险的
  // bypassPermissions（连权限询问通道都一并绕开）；而标着「慎用」的「完全自主」
  // 反倒是更保守的 acceptEdits。
  yolo: 'acceptEdits',
  auto: 'bypassPermissions'
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
  /** 会话被用户关掉了——close 之后不再懒重启。 */
  disposed: boolean
  stderr: string
  lastUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  /** 待用户裁决的权限询问：toolUseId → { CLI 的 control request_id, 原始入参 }。
   *  入参必须留着——allow 的回执要原样回传 updatedInput，回空对象等于把工具的
   *  参数抹掉。 */
  pendingPermissions: Map<string, { requestId: string; input: Record<string, unknown> }>
  /** 已发出的 interrupt control request id（等 control_response）。 */
  interruptRequestId: string | null
  interruptTimer: ReturnType<typeof setTimeout> | null
  /** system/init 里带的技能名与 MCP 服务器状态（只读展示用）。 */
  skills: string[]
  mcpServers: McpServerEntry[]
  /** 隐藏 `/context` 轮进行中：这一轮的所有消息都不推给渲染层。 */
  hiddenTurn: boolean
  hiddenText: string
  /** `/context` 解析出的真实上下文占用与窗口上限。 */
  contextInfo?: { used: number; total: number; model?: string }
}

/** `**Tokens:** 29.3k / 1m (3%)` → { used: 29300, total: 1000000 }。 */
function parseContextUsage(text: string): { used: number; total: number; model?: string } | null {
  const m = text.match(/\*\*Tokens:\*\*\s*([\d.]+)\s*([kmKM]?)\s*\/\s*([\d.]+)\s*([kmKM]?)/)
  if (!m) return null
  const scale = (unit: string): number => (unit.toLowerCase() === 'm' ? 1e6 : unit.toLowerCase() === 'k' ? 1e3 : 1)
  const used = Math.round(Number(m[1]) * scale(m[2] ?? ''))
  const total = Math.round(Number(m[3]) * scale(m[4] ?? ''))
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null
  const modelMatch = text.match(/\*\*Model:\*\*\s*(\S+)/)
  return { used, total, ...(modelMatch?.[1] ? { model: modelMatch[1] } : {}) }
}

/** stderr 只留尾部用于报错，避免长会话把内存吃掉（同 AcpClient 的取舍）。 */
const MAX_STDERR = 8000

export function resolveClaudeCommand(): { command: string; prefixArgs: string[] } {
  // 用户级安装（Windows 下 claude 装在 ~/.local/bin）优先，其次 PATH。
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (existsSync(local)) return { command: local, prefixArgs: [] }
  const localCmd = join(homedir(), '.local', 'bin', 'claude.cmd')
  if (process.platform === 'win32' && existsSync(localCmd)) {
    // .cmd 必须经 cmd.exe 启动（Node 的 spawn 不认批处理）。
    return { command: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', localCmd] }
  }
  // 都没命中就交给 PATH。Windows 上 npm 装出来的是 claude.cmd（批处理），
  // Node 的 spawn 不认，必须经 cmd.exe 起。
  if (process.platform === 'win32') {
    return { command: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', 'claude'] }
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

    const session: ActiveClaudeSession = {
      id: sessionId,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      permissionMode,
      // spawnChild 立刻覆盖，这里只是让类型闭合。
      child: null as unknown as ChildProcessWithoutNullStreams,
      rl: null as unknown as ReadlineInterface,
      claudeSessionId: opts.resume ?? null,
      running: false,
      closing: false,
      disposed: false,
      stderr: '',
      pendingPermissions: new Map(),
      interruptRequestId: null,
      interruptTimer: null,
      skills: [],
      mcpServers: [],
      hiddenTurn: false,
      hiddenText: ''
    }
    this.spawnChild(session)
    this.sessions.set(sessionId, session)
    return sessionId
  }

  /**
   * 起一个 claude 子进程并接好流。start() 与「中断/崩溃后懒重启」共用。
   * 重启时带 --resume，Claude 侧上下文接着走，用户看不出断过。
   */
  private spawnChild(session: ActiveClaudeSession): void {
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
      '--permission-mode', session.permissionMode,
      // 关键：不给这个标志，CLI 在 --print 下无处询问，凡是需要授权的工具
      // 一律直接拒绝（实测 default 模式下 Write 必失败）。给了才会把询问以
      // control_request/can_use_tool 发过来，接进 Tran 的权限弹窗。
      '--permission-prompt-tool', 'stdio'
    ]
    if (session.model) args.push('--model', session.model)
    if (session.claudeSessionId) args.push('--resume', session.claudeSessionId)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, { cwd: session.cwd, windowsHide: true, env: { ...process.env } })
    } catch (error) {
      throw new Error(
        `启动 Claude Code 失败：${error instanceof Error ? error.message : String(error)}。` +
          '请确认已安装 Claude Code CLI（claude --version 可用）。'
      )
    }

    session.child = child
    session.rl = createInterface({ input: child.stdout, terminal: false })
    session.closing = false
    session.stderr = ''
    session.pendingPermissions.clear()

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
      // 进程意外没了：先在对话流里说一声，再收尾。
      //
      // 之前这里只 onEnded，界面上**一个字都没有**——正文停在半截输出上，
      // 用户不知道是它还在想还是已经死了（真机 QA：杀掉 claude 子进程后转录区
      // 只剩数字，没有任何提示；kimi 那边一直是有断线卡片的）。
      // 下一条消息会带 --resume 自动重开，所以措辞是「可继续」而不是「已结束」。
      if (!session.disposed) {
        // detail 本身就已经是「Claude Code 进程退出（code 1）」这种整句，别再
        // 套一层同样的话（实测套出来是「进程意外退出（进程退出（code 1））」）。
        const reason = session.stderr.trim() || `退出码 ${code ?? 'null'}`
        this.emitNotice(
          session,
          `Claude Code 进程意外退出（${reason}）。这一轮已中断；` +
            '直接再发一条消息即可自动重开并接着上下文。'
        )
      }
      this.endSession(session, detail)
    })

    log(
      'claude',
      `spawn ${command} cwd=${session.cwd} model=${session.model ?? 'default'} ` +
        `mode=${session.permissionMode} resume=${session.claudeSessionId ?? 'no'}`
    )
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

    // 控制通道（权限询问、中断回执）不是会话消息，处理完就地返回，
    // 不能透传给渲染层——它只认 SDKMessage 那几种类型。
    if (msg.type === 'control_request') {
      this.handleControlRequest(session, msg)
      return
    }
    if (msg.type === 'control_response') {
      const rid = (msg['response'] as Record<string, unknown> | undefined)?.['request_id']
      if (rid && rid === session.interruptRequestId) this.settleInterrupt(session)
      return
    }

    // 记住 Claude 侧 session_id：侧栏条目、resume 都用它。
    const sid = typeof msg['session_id'] === 'string' ? (msg['session_id'] as string) : null
    if (sid && session.claudeSessionId !== sid) session.claudeSessionId = sid

    // init 里带着这个会话真实装载的技能与 MCP 服务器状态——面板据此展示，
    // 而不是一律显示「一个都没有」。
    if (msg.type === 'system' && msg['subtype'] === 'init') {
      const skills = msg['skills']
      if (Array.isArray(skills)) session.skills = skills.filter((s): s is string => typeof s === 'string')
      const servers = msg['mcp_servers']
      if (Array.isArray(servers)) {
        session.mcpServers = servers.map((raw) => {
          const s = raw as Record<string, unknown>
          const status = String(s['status'] ?? 'pending')
          return {
            name: String(s['name'] ?? '(未命名)'),
            status: (['connected', 'failed', 'needs-auth', 'pending', 'disabled'] as const).includes(
              status as McpServerStatusKind
            )
              ? (status as McpServerStatusKind)
              : 'pending',
            scope: 'claude-code'
          }
        })
      }
    }

    // 隐藏 `/context` 轮：整轮都不推给渲染层（那是一大张 markdown 表格，
    // 落进对话流就是噪声），只把文本攒起来解析，result 一到就收尾。
    // 也不能翻 running——界面会闪一下"正在运行"。
    if (session.hiddenTurn) {
      if (msg.type === 'assistant') {
        const content = (msg['message'] as { content?: unknown } | undefined)?.content
        if (Array.isArray(content)) {
          for (const raw of content) {
            const b = raw as Record<string, unknown>
            if (b['type'] === 'text' && typeof b['text'] === 'string') session.hiddenText += b['text']
          }
        }
      }
      if (msg.type === 'result') {
        const parsed = parseContextUsage(session.hiddenText)
        if (parsed) {
          session.contextInfo = parsed
          log('claude', `/context → ${parsed.used}/${parsed.total} model=${parsed.model ?? '-'}`)
        }
        session.hiddenTurn = false
        session.hiddenText = ''
      }
      return
    }

    if (msg.type === 'assistant' && !session.running) {
      session.running = true
      this.h.onSessionRunning?.(session.id, true, session.claudeSessionId ?? undefined, Date.now())
    }

    if (msg.type === 'result') {
      const usage = msg['usage'] as Record<string, number> | undefined
      if (usage) {
        // 缓存命中的 token 也占上下文窗口——只算 input+output 的话，长会话的
        // 上下文环会一直显示接近 0（实测一轮 input=2 而 cache_read=55294）。
        const input = usage['input_tokens'] ?? 0
        const cacheRead = usage['cache_read_input_tokens'] ?? 0
        const cacheWrite = usage['cache_creation_input_tokens'] ?? 0
        const output = usage['output_tokens'] ?? 0
        session.lastUsage = {
          inputTokens: input + cacheRead + cacheWrite,
          outputTokens: output,
          totalTokens: input + cacheRead + cacheWrite + output
        }
      }
      // 一轮结束，之前挂起的权限询问都作废了。
      session.pendingPermissions.clear()
      session.running = false
      this.h.onSessionRunning?.(session.id, false, session.claudeSessionId ?? undefined)
      // 每轮结束顺手刷一次真实上下文占用。`/context` 不走 API、不花钱，
      // 所以不必等用户悬停上下文环才去取。放到下一个 tick，让这条 result
      // 先推给渲染层。
      setTimeout(() => void this.requestUsageRefresh(session.id), 0)
    }

    // 直通：形状与渲染层期待的一致，不做翻译。
    this.h.onMessage(session.id, msg)
  }

  /**
   * CLI → 客户端的控制请求。目前只有权限询问需要真正应答；其余子类型（hook
   * 回调、MCP 转发等）必须回一条 error，否则 CLI 会一直等下去把会话卡死。
   */
  private handleControlRequest(session: ActiveClaudeSession, msg: Record<string, unknown>): void {
    const requestId = typeof msg['request_id'] === 'string' ? (msg['request_id'] as string) : null
    const request = (msg['request'] ?? {}) as Record<string, unknown>
    if (!requestId) return

    if (request['subtype'] !== 'can_use_tool') {
      this.writeLine(session, {
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `unsupported control request: ${String(request['subtype'])}` }
      })
      return
    }

    // tool_use_id 是 Tran 权限弹窗与工具卡片的关联键；CLI 一定会带，缺了就
    // 退化成 request_id（弹窗仍可用，只是不高亮对应的工具卡）。
    const toolUseId =
      typeof request['tool_use_id'] === 'string' ? (request['tool_use_id'] as string) : requestId
    const input = (request['input'] ?? {}) as Record<string, unknown>
    session.pendingPermissions.set(toolUseId, { requestId, input })

    const suggestions = Array.isArray(request['permission_suggestions'])
      ? (request['permission_suggestions'] as PermissionUpdate[])
      : undefined
    const description = typeof request['description'] === 'string' ? (request['description'] as string) : undefined

    this.h.onPermissionRequest({
      toolUseID: toolUseId,
      toolName: typeof request['tool_name'] === 'string' ? (request['tool_name'] as string) : 'tool',
      input,
      ...(suggestions ? { suggestions } : {}),
      ...(description ? { decisionReason: description } : {})
    })
  }

  /** 往对话流里插一张系统状态卡（与 KimiBackend 的断线通告同一个通道/形状）。 */
  private emitNotice(session: ActiveClaudeSession, text: string): void {
    this.h.onMessage(session.id, {
      type: 'system',
      subtype: 'query_result',
      query: { command: '/status', text, at: Date.now() }
    } as unknown as SDKMessage)
  }

  private writeLine(session: ActiveClaudeSession, payload: unknown): boolean {
    try {
      session.child.stdin.write(JSON.stringify(payload) + '\n')
      return true
    } catch (error) {
      log('claude', `stdin write failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private writeUser(session: ActiveClaudeSession, content: string | unknown[]): void {
    this.writeLine(session, { type: 'user', message: { role: 'user', content } })
  }

  /** 进程还活着么？中断/崩溃之后要靠它决定是否 --resume 重开。 */
  private isAlive(session: ActiveClaudeSession): boolean {
    const c = session.child
    return !!c && c.exitCode === null && c.signalCode === null && c.stdin.writable
  }

  send(sessionId: string, content: string | unknown[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // 中断/崩溃后进程可能已经没了：带 --resume 悄悄重开，上下文接着走。
    // （旧实现在这儿排队等 system/init，但 CLI 要先收到输入才吐 init，
    //   两边互等——整个后端一条消息都发不出去。）
    if (!this.isAlive(session)) {
      if (session.disposed) return
      try {
        this.spawnChild(session)
      } catch (error) {
        this.endSession(session, error instanceof Error ? error.message : String(error))
        return
      }
    }
    // 附件原样透传：渲染层拼出来的块本来就是 Anthropic API 的形状
    // （text / image + source.base64），与 Claude Code 的 stream-json 输入一致。
    // 早先这里把数组拍平成纯文本只取 text 块，图片附件直接消失。
    this.writeUser(session, content)
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !this.isAlive(session)) return
    // 优先走控制协议的优雅中断（实测 CLI 回 control_response + 一条
    // result/error_during_execution）。只有它不吭声时才退回杀进程——注意
    // 杀完不能 endSession，会话得留着，下次 send 会 --resume 重开。
    const requestId = randomUUID()
    session.interruptRequestId = requestId
    const ok = this.writeLine(session, { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } })
    if (!ok) {
      this.settleInterrupt(session)
      this.killChild(session)
      return
    }
    session.interruptTimer = setTimeout(() => {
      if (session.interruptRequestId !== requestId) return
      log('claude', 'interrupt control request timed out, killing child')
      this.settleInterrupt(session)
      this.killChild(session)
      if (session.running) {
        session.running = false
        this.h.onSessionRunning?.(session.id, false, session.claudeSessionId ?? undefined)
      }
    }, 3000)
  }

  private settleInterrupt(session: ActiveClaudeSession): void {
    session.interruptRequestId = null
    if (session.interruptTimer) {
      clearTimeout(session.interruptTimer)
      session.interruptTimer = null
    }
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.model = model
    // 控制协议支持热切（实测 CLI 回 control_response 后 init 就报新模型），
    // 与 setPermissionMode 同理。早先这里只改内存字段，而 model 只在 spawn 时
    // 用一次——Composer 里换模型对进行中的会话完全没效果。
    if (this.isAlive(session)) {
      this.writeLine(session, {
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'set_model', model }
      })
    }
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.permissionMode = PERMISSION_MODE_MAP[mode] ?? 'default'
    // 控制协议支持热切（实测 CLI 立刻回 {mode:'acceptEdits'} 并对后续工具生效），
    // 不必重开会话。进程不在就只记下来，下次 spawn 带上。
    if (this.isAlive(session)) {
      this.writeLine(session, {
        type: 'control_request',
        request_id: randomUUID(),
        request: { subtype: 'set_permission_mode', mode: session.permissionMode }
      })
    }
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.disposed = true
    this.killChild(session)
    this.sessions.delete(sessionId)
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.disposed = true
      this.killChild(session)
    }
    this.sessions.clear()
  }

  private killChild(session: ActiveClaudeSession): void {
    session.closing = true
    this.settleInterrupt(session)
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

  /** MCP 服务器：只读展示 init 下发的状态。增删改仍由 Claude Code 自己管
   *  （`claude mcp add/remove`），Tran 不代管它的配置文件。 */
  async listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.sessions.get(sessionId)?.mcpServers ?? []
  }

  async refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    // 状态只随 init 下发，会话中途没有刷新通道；返回当前已知的即可。
    return this.listMcpServers(sessionId)
  }

  async toggleMcpServer(): Promise<void> {
    throw new Error('Claude Code 的 MCP 服务器请用 `claude mcp` 命令管理，Tran 这里只做展示')
  }

  async backgroundTask(): Promise<boolean> {
    return false
  }

  async listSkills(sessionId: string): Promise<SkillInfo[]> {
    const skills = this.sessions.get(sessionId)?.skills ?? []
    return skills.map((name) => ({ name, description: 'Claude Code 内置技能' }))
  }

  /**
   * 隐藏 `/context` 轮：拿真实的上下文占用与窗口上限。
   *
   * 这条命令**完全不花钱**——实测 `num_turns: 0`、`total_cost_usd: 0`、
   * `duration_api_ms: 0`、usage 全零，是纯本地渲染，不走 API。所以悬停上下文环
   * 时随手刷一次没有任何代价。
   *
   * 只在会话空闲时跑：用户轮在途时直接放弃，不跟对话抢 stdin 的先后。
   */
  async requestUsageRefresh(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.disposed || session.running || session.hiddenTurn) return
    if (!this.isAlive(session)) return
    session.hiddenTurn = true
    session.hiddenText = ''
    if (!this.writeLine(session, { type: 'user', message: { role: 'user', content: '/context' } })) {
      session.hiddenTurn = false
    }
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const session = this.sessions.get(sessionId)
    const ctx = session?.contextInfo
    // `/context` 给的是权威值：占用和窗口都由 CLI 自己算（实测这台机器上窗口
    // 是 1m，而不是此前写死的 200k——环整整虚高了 5 倍）。拿不到时才退回
    // result 里的 usage 估算，窗口按 200k 保守计。
    return {
      inputTokens: session?.lastUsage?.inputTokens,
      outputTokens: session?.lastUsage?.outputTokens,
      totalTokens: ctx ? ctx.used : session?.lastUsage?.totalTokens,
      contextSize: ctx ? ctx.total : 200_000,
      ...(ctx?.model ?? session?.model ? { model: ctx?.model ?? session?.model } : {})
    }
  }

  async listModels(): Promise<ComposerModel[]> {
    return this.models
  }

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    return []
  }

  /**
   * 用户在权限弹窗上的裁决 → CLI 的 control_response。
   *
   * 返回 false 表示「这条不是我的」——AgentBridge 会挨个后端问过去，答错了会
   * 把 Kimi 的裁决吞掉，所以必须先按 toolUseID 认领。
   */
  respondPermission(resp: PermissionResponsePayload): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingPermissions.get(resp.toolUseID)
      if (!pending) continue
      session.pendingPermissions.delete(resp.toolUseID)
      const decision =
        resp.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: pending.input }
          : { behavior: 'deny', message: resp.message ?? '用户拒绝了这次工具调用' }
      this.writeLine(session, {
        type: 'control_response',
        response: { subtype: 'success', request_id: pending.requestId, response: decision }
      })
      return true
    }
    return false
  }
}
