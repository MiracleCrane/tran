import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { log } from '../logger'

export type AcpRpcId = number | string

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
  timeout: NodeJS.Timeout
}

interface ClientHandlers {
  onNotification: (msg: AcpRpcMessage) => void
  onServerRequest: (msg: AcpRpcMessage) => void
  onClose: (error?: string) => void
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

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 180000): Promise<T> {
    if (this.closed || !this.child) throw new Error(`ACP server (${this.options.logTag}) is not running.`)
    const id = this.nextId++
    const message: AcpRpcMessage = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      })
      this.write(message)
    })
  }

  notify(method: string, params?: unknown): void {
    const message: AcpRpcMessage = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.write(message)
  }

  respond(id: AcpRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: AcpRpcId, message: string, code = -32000): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  close(): void {
    this.closing = true
    this.child?.kill()
    this.rejectAll(new Error(`ACP server (${this.options.logTag}) closed.`))
  }

  private async spawn(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('ACP backends currently support Windows only.')
    const { command, argsPrefix = [], args, displayPath, logTag } = this.options
    const fullArgs = [...argsPrefix, ...args]
    log(logTag, `spawn ACP ${displayPath ?? command} ${args.join(' ')}`)
    const child = spawn(command, fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk
      const trimmed = chunk.trim()
      if (trimmed) log(`${logTag}-stderr`, trimmed)
    })
    child.on('error', (error) => {
      this.closed = true
      this.rejectAll(error)
      this.handlers.onClose(error.message)
    })
    child.on('close', (code) => {
      this.closed = true
      const detail = this.stderr.trim() || (code == null ? 'ACP server stopped.' : `ACP server exited with code ${code}.`)
      this.rejectAll(new Error(detail))
      if (!this.closing) this.handlers.onClose(detail)
    })

    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true, ...this.options.clientCapabilities?.fs },
        terminal: this.options.clientCapabilities?.terminal ?? false
      },
      clientInfo: this.options.clientInfo
    }, 60000)
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
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timeout)
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
      this.handlers.onServerRequest(msg)
    } else if (msg.method) {
      this.handlers.onNotification(msg)
    }
  }

  private write(message: AcpRpcMessage): void {
    if (this.closed || !this.child) throw new Error(`ACP server (${this.options.logTag}) is not running.`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
