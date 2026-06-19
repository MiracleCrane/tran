import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { log } from '../logger'
import { resolveWindowsHermesCommand } from '../windowsHermes'

export type HermesRpcId = number | string

export interface HermesRpcMessage {
  jsonrpc?: '2.0'
  id?: HermesRpcId
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
  onNotification: (msg: HermesRpcMessage) => void
  onServerRequest: (msg: HermesRpcMessage) => void
  onClose: (error?: string) => void
}

export class HermesAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private stdoutBuffer = ''
  private stderr = ''
  private closed = false
  private closing = false
  private readonly pending = new Map<HermesRpcId, PendingRequest>()

  private constructor(private handlers: ClientHandlers) {}

  static async start(handlers: ClientHandlers): Promise<HermesAcpClient> {
    const client = new HermesAcpClient(handlers)
    await client.spawn()
    return client
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 180000): Promise<T> {
    if (this.closed || !this.child) throw new Error('Hermes ACP server is not running.')
    const id = this.nextId++
    const message: HermesRpcMessage = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Hermes ACP request timed out: ${method}`))
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
    const message: HermesRpcMessage = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    this.write(message)
  }

  respond(id: HermesRpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: HermesRpcId, message: string, code = -32000): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  close(): void {
    this.closing = true
    this.child?.kill()
    this.rejectAll(new Error('Hermes ACP server closed.'))
  }

  private async spawn(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Hermes backend currently supports Windows only.')
    const resolved = resolveWindowsHermesCommand()
    const args = [...resolved.argsPrefix, 'acp', '--accept-hooks']
    log('hermes', `spawn ACP ${resolved.displayPath}`)
    const child = spawn(resolved.command, args, {
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
      if (trimmed) log('hermes-stderr', trimmed)
    })
    child.on('error', (error) => {
      this.closed = true
      this.rejectAll(error)
      this.handlers.onClose(error.message)
    })
    child.on('close', (code) => {
      this.closed = true
      const detail = this.stderr.trim() || (code == null ? 'Hermes ACP server stopped.' : `Hermes ACP server exited with code ${code}.`)
      this.rejectAll(new Error(detail))
      if (!this.closing) this.handlers.onClose(detail)
    })

    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: 'forge', title: 'Forge', version: '1.0.4' }
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
    let msg: HermesRpcMessage
    try {
      msg = JSON.parse(line) as HermesRpcMessage
    } catch {
      log('hermes', `non-json ACP stdout: ${line.slice(0, 240)}`)
      return
    }

    if (msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error)) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timeout)
      if (msg.error) pending.reject(new Error(msg.error.message || `${pending.method} failed`))
      else pending.resolve(msg.result)
      return
    }

    if (msg.method && msg.id !== undefined) {
      this.handlers.onServerRequest(msg)
    } else if (msg.method) {
      this.handlers.onNotification(msg)
    }
  }

  private write(message: HermesRpcMessage): void {
    if (this.closed || !this.child) throw new Error('Hermes ACP server is not running.')
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
