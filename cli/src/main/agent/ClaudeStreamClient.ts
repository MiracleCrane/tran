import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { log } from '../logger'
import { resolveWindowsClaudeCommand } from '../windowsClaude'

/**
 * Claude Code CLI 的 stream-json 通道。
 *
 * 与 AcpClient（JSON-RPC 请求/响应）不同，这里是**单向消息流**：
 * stdin 逐行喂 user 消息，stdout 逐行吐 SDK 消息，没有 id 配对、没有响应。
 * 所以本类只做三件事：拉起进程、NDJSON 分帧、把消息交给回调。
 *
 * 命令行形态（`claude --help` 实证，v2.1.x）：
 *
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --forward-subagent-text \
 *          --replay-user-messages --verbose \
 *          --session-id <uuid> [--resume <id>] [--model <m>] \
 *          [--permission-mode <mode>] [--add-dir <dir>...]
 *
 * 几个关键开关的作用：
 * - `--include-partial-messages`：给出 `stream_event` 增量帧，渲染层的
 *   streamBatcher 正是按这个形状做限速的（Tran 的消息形状本就照 Agent SDK 建）
 * - `--forward-subagent-text`：子代理文本带 `parent_tool_use_id`，直接对上
 *   Tran 的 `parentToolUseId` 分层渲染
 * - `--replay-user-messages`：stdin 进来的用户消息回显到 stdout，用作「已收到」
 *   的确认信号（对齐 KimiBackend 的 unacked 台账思路）
 */

/** stderr 只在退出时用于拼错误信息，保留尾部即可（同 AcpClient）。 */
const STDERR_KEEP_CHARS = 64 * 1024

export interface ClaudeSpawnOptions {
  cwd: string
  sessionId: string
  resume?: string
  model?: string
  permissionMode?: string
  addDirs?: string[]
  /** 注入的环境变量（provider 切换用）。 */
  env?: Record<string, string>
}

export interface ClaudeStreamHandlers {
  /** 一条完整的 SDK 消息（type: system/assistant/user/result/stream_event…）。 */
  onMessage: (message: Record<string, unknown>) => void
  /** 进程退出。error 为空表示正常结束。 */
  onClose: (error?: string) => void
}

export class ClaudeStreamClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private stderr = ''
  private closed = false

  private constructor(
    private readonly logTag: string,
    private readonly handlers: ClaudeStreamHandlers
  ) {}

  static async start(
    options: ClaudeSpawnOptions,
    handlers: ClaudeStreamHandlers,
    logTag = 'claude'
  ): Promise<ClaudeStreamClient> {
    const client = new ClaudeStreamClient(logTag, handlers)
    await client.spawn(options)
    return client
  }

  private async spawn(options: ClaudeSpawnOptions): Promise<void> {
    const resolved = await resolveWindowsClaudeCommand()
    const args = [
      ...resolved.argsPrefix,
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--replay-user-messages',
      '--verbose',
      '--session-id',
      options.sessionId
    ]
    if (options.resume) args.push('--resume', options.resume)
    if (options.model) args.push('--model', options.model)
    if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
    for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)

    log(this.logTag, `spawn ${resolved.displayPath} (cwd=${options.cwd})`)

    const child = spawn(resolved.command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...options.env }
    }) as ChildProcessWithoutNullStreams
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
      if (this.stderr.length > STDERR_KEEP_CHARS) {
        this.stderr = this.stderr.slice(-STDERR_KEEP_CHARS)
      }
      const trimmed = chunk.trim()
      if (trimmed) log(`${this.logTag}-stderr`, trimmed)
    })

    // 无监听的 stdin 流错误（进程已退出时写入触发 EPIPE）会掀掉主进程。
    child.stdin.on('error', (error) => {
      log(this.logTag, `stdin error: ${error.message}`)
    })

    child.on('error', (error) => {
      this.finish(`无法启动 Claude Code：${error.message}`)
    })
    child.on('close', (code) => {
      const tail = this.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
      this.finish(code === 0 ? undefined : `Claude Code 退出（code=${code}）${tail ? `：${tail}` : ''}`)
    })
  }

  /** 发一条用户消息。形状是 Agent SDK 的 user 消息信封。 */
  send(content: string | unknown[]): void {
    this.write({
      type: 'user',
      message: { role: 'user', content }
    })
  }

  /** 写一行 NDJSON。进程已退出属于正常竞态，记录即可，不能抛给调用方。 */
  private write(payload: Record<string, unknown>): void {
    const child = this.child
    if (this.closed || !child) {
      log(this.logTag, 'write skipped: 进程未运行')
      return
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (error) {
      log(this.logTag, `write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 关闭 stdin：Claude Code 在 stdin 结束后收尾当前轮并退出。 */
  endInput(): void {
    try {
      this.child?.stdin.end()
    } catch {
      /* 关闭路径尽力而为 */
    }
  }

  close(): void {
    // 同步置位并断开引用：'close' 事件是异步的，在它到达前守卫必须已经生效，
    // 否则会往已 kill 的进程写 stdin（AcpClient 踩过这个坑）。
    this.closed = true
    const child = this.child
    this.child = null
    try {
      child?.stdin.end()
    } catch {
      /* ignore */
    }
    child?.kill()
  }

  private finish(error?: string): void {
    if (this.closed) return
    this.closed = true
    this.child = null
    this.handlers.onClose(error)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let index = this.stdoutBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Claude Code 偶尔会往 stdout 打非 JSON 的提示行，记录后跳过。
      log(this.logTag, `non-json stdout: ${line.slice(0, 240)}`)
      return
    }
    if (typeof msg.type !== 'string') return
    this.handlers.onMessage(msg)
  }
}
