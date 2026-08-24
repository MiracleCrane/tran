import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { log } from '../logger'

export type AcpRpcId = number | string

/** stderr 只用于 close 时拼错误信息，保留尾部即可（见 spawn 里的截断）。 */
const STDERR_KEEP_CHARS = 64 * 1024

export interface AcpRpcMessage {
  jsonrpc?: '2.0'
  id?: AcpRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** timeoutMs <= 0 的请求无硬超时（#41 用户轮长任务），此字段缺省。 */
  timeout?: NodeJS.Timeout
}

interface ClientHandlers {
  onNotification: (client: AcpClient, msg: AcpRpcMessage) => void
  onServerRequest: (client: AcpClient, msg: AcpRpcMessage) => void
  onClose: (client: AcpClient, error?: string) => void
}

export interface AcpClientOptions {
  /** Resolved executable (see windowsKimi.ts). */
  command: string
  /** Extra args that must precede the subcommand (e.g. cmd.exe /d /s /c wrapper). */
  argsPrefix?: string[]
  /** Subcommand args, e.g. ['acp']. */
  args: string[]
  /** displayPath used in logs. */
  displayPath?: string
  /** Log tag for the ACP stdout/stderr lines. */
  logTag: string
  clientInfo: { name: string; title: string; version: string }
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean }
    terminal?: boolean
  }
  /** 额外注入 ACP 子进程的环境变量（在 process.env 之上覆盖）。 */
  extraEnv?: Record<string, string>
}

/** JSON-RPC error with the ACP error code attached (e.g. -32000 authRequired). */
export class AcpRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRequestError'
  }
}

/**
 * Generic ACP (Agent Client Protocol) client: spawns an agent CLI in ACP mode
 * and speaks newline-delimited JSON-RPC over stdio. Agent-agnostic — concrete
 * backends (Kimi today, others later) provide the spawn spec + clientInfo.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private stdoutBuffer = ''
  private stderr = ''
  private closed = false
  private closing = false
  private readonly pending = new Map<AcpRpcId, PendingRequest>()

  private constructor(
    private options: AcpClientOptions,
    private handlers: ClientHandlers
  ) {}

  static async start(options: AcpClientOptions, handlers: ClientHandlers): Promise<AcpClient> {
    const client = new AcpClient(options, handlers)
    await client.spawn()
    return client
  }

  /**
   * @param timeoutMs 硬超时毫秒数；传 <= 0 表示不设硬超时（#41：用户轮长任务
   *   由调用方的活动监督/静默分级介入负责兜底，握手与隐藏轮仍传正值）。
   * @param onTimeout 硬超时触发时、reject 之前调用（如给该会话补发 session/cancel，
   *   避免 agent 侧 turn 空跑、后续请求撞 "another turn in progress"）。回调内
   *   异常被吞掉并记日志——不能掩盖原始超时错误。
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 180000, onTimeout?: () => void): Promise<T> {
    // 返回 rejected promise 而不是同步 throw：调用方普遍用 .catch() 兜错
    // （如 setModel / setPermissionMode），同步 throw 会绕过这些 .catch，
    // 把本可吞掉的错误一路抛到 prepareSession，拆掉整个会话。
    if (this.closed || !this.child) {
      return Promise.reject(new Error(`ACP server (${this.options.logTag}) is not running.`))
    }
    const id = this.nextId++
    const message: AcpRpcMessage = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            if (onTimeout) {
              try {
                onTimeout()
              } catch (error) {
                log(this.options.logTag, `onTimeout hook failed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            reject(new Error(`ACP request timed out: ${method}`))
          }, timeoutMs)
        : undefined
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        ...(timeout ? { timeout } : {})
      })
      this.write(message)
    })
  }

  /** 即发即忘的写入：进程已退出属于正常竞态（如关闭时补发 session/cancel），
   *  记录即可，不能把异常抛给没有 try/catch 的调用方。 */
  private writeQuiet(message: AcpRpcMessage): void {
    try {
      this.write(message)
    } catch (error) {
      log(this.options.logTag, `write skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  notify(method: string, params?: unknown): void {
    const message: AcpRpcMessage = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.writeQuiet(message)
  }

  respond(id: AcpRpcId, result: unknown): void {
    this.writeQuiet({ jsonrpc: '2.0', id, result })
  }

  respondError(id: AcpRpcId, message: string, code = -32000): void {
    this.writeQuiet({ jsonrpc: '2.0', id, error: { code, message } })
  }

  /**
   * 同步置位 closed 并断开 child 引用：'close' 事件是异步到达的，在它到达
   * 之前 request()/notify()/respond() 的守卫（this.closed || !this.child）
   * 会放行，把数据写进刚被 kill 的进程 stdin，触发 EPIPE。
   *
   * Windows 下 kimi 常经 cmd.exe 包装启动（见 windowsKimi.ts），child.kill()
   * 只能杀到 cmd 本体、杀不掉 kimi 孙进程（实测泄漏 ~300MB/个）。这里先收
   * stdin 给孙进程 EOF（其 acp 模式读到 EOF 会自行退出），再用 taskkill /T
   * 终止整棵进程树兜底（同 kimiServerApi.killServerChild 的写法）；非 Windows
   * 维持 SIGTERM。进程已退出时全程静默——close 可能在 'close' 事件后被调用。
   */
  close(): void {
    this.closing = true
    this.closed = true
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.stdin.end()
      } catch {
        /* 进程可能刚退出：尽力而为 */
      }
      try {
        if (process.platform === 'win32' && child.pid) {
          // 'error' 事件必须挂监听：spawn 失败（杀软 EPERM/PATH 异常）是异步
          // 事件，外层 try/catch 抓不到，没监听器会直接掀掉主进程。
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          killer.on('error', () => { /* 关闭路径尽力而为 */ })
          killer.unref()
        } else {
          child.kill('SIGTERM')
        }
      } catch {
        /* 关闭路径尽力而为 */
      }
    }
    this.rejectAll(new Error(`ACP server (${this.options.logTag}) closed.`))
  }

  private async spawn(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('ACP backends currently support Windows only.')
    const { command, argsPrefix = [], args, displayPath, logTag } = this.options
    const fullArgs = [...argsPrefix, ...args]
    log(logTag, `spawn ACP ${displayPath ?? command} ${args.join(' ')}`)
    const child = spawn(command, fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.options.extraEnv ? { env: { ...process.env, ...this.options.extraEnv } } : {})
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
      // 只保留尾部：stderr 仅在 close 时用于拼错误信息，长会话里
      // 无限累积会让主进程堆随日志量线性增长。
      if (this.stderr.length > STDERR_KEEP_CHARS) {
        this.stderr = this.stderr.slice(-STDERR_KEEP_CHARS)
      }
      const trimmed = chunk.trim()
      if (trimmed) log(`${logTag}-stderr`, trimmed)
    })
    // stdin 的 'error'（进程已死时写入触发 EPIPE）没有监听器会成为
    // 未处理的流错误，直接掀掉 Electron 主进程。
    child.stdin.on('error', (error) => {
      log(logTag, `stdin error: ${error.message}`)
    })
    child.on('error', (error) => {
      this.closed = true
      this.rejectAll(error)
      this.handlers.onClose(this, error.message)
    })
    child.on('close', (code) => {
      this.closed = true
      const detail = this.stderr.trim() || (code == null ? 'ACP server stopped.' : `ACP server exited with code ${code}.`)
      this.rejectAll(new Error(detail))
      if (!this.closing) this.handlers.onClose(this, detail)
    })

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true, ...this.options.clientCapabilities?.fs },
          terminal: this.options.clientCapabilities?.terminal ?? false
        },
        clientInfo: this.options.clientInfo
      }, 60000)
    } catch (error) {
      // 初始化失败：start() 抛错后实例对外不可达，close() 永远不会被调用——
      // 这里必须自己 kill 已 spawn 的子进程，否则进程泄漏。
      this.close()
      throw error
    }
  }

  /** 按原值找 pending，找不到再按数字/字符串互转找一次。 */
  private resolvePendingKey(id: AcpRpcId): AcpRpcId | undefined {
    if (this.pending.has(id)) return id
    if (typeof id === 'string') {
      const numeric = Number(id)
      if (Number.isFinite(numeric) && this.pending.has(numeric)) return numeric
    } else if (typeof id === 'number' && this.pending.has(String(id))) {
      return String(id)
    }
    return undefined
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
    let msg: AcpRpcMessage
    try {
      msg = JSON.parse(line) as AcpRpcMessage
    } catch {
      log(this.options.logTag, `non-json ACP stdout: ${line.slice(0, 240)}`)
      return
    }

    if (msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error)) {
      // 请求 id 一律是数字，但对端可能回成字符串（"1" vs 1）。Map 键类型不匹配
      // 会查不到 pending，响应被丢掉、请求一直挂到超时——这里做一次归一。
      const key = this.resolvePendingKey(msg.id)
      if (key === undefined) return
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      if (pending.timeout) clearTimeout(pending.timeout)
      if (msg.error) {
        pending.reject(new AcpRequestError(
          msg.error.message || `${pending.method} failed`,
          msg.error.code,
          msg.error.data
        ))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.method && msg.id !== undefined) {
      this.handlers.onServerRequest(this, msg)
    } else if (msg.method) {
      this.handlers.onNotification(this, msg)
    }
  }

  private write(message: AcpRpcMessage): void {
    if (this.closed || !this.child) throw new Error(`ACP server (${this.options.logTag}) is not running.`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
