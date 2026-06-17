import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { log } from '../logger'
import { resolveWindowsCodexCommand } from '../windowsCodex'

export type CodexRpcId = number | string

export interface CodexRpcMessage {
  id?: CodexRpcId
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
  onNotification: (msg: CodexRpcMessage) => void
  onServerRequest: (msg: CodexRpcMessage) => void
  onClose: (error?: string) => void
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private stdoutBuffer = ''
  private stderr = ''
  private closed = false
  private closing = false
  private readonly pending = new Map<CodexRpcId, PendingRequest>()

  private constructor(private handlers: ClientHandlers) {}

  static async start(handlers: ClientHandlers): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(handlers)
    await client.spawn()
    return client
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120000): Promise<T> {
    if (this.closed || !this.child) throw new Error('Codex app-server is not running.')
    const id = this.nextId++
    const message: Record<string, unknown> = { method, id }
    if (params !== undefined) message.params = params
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
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
    const message: Record<string, unknown> = { method }
    if (params !== undefined) message.params = params
    this.write(message)
  }

  respond(id: CodexRpcId, result: unknown): void {
    this.write({ id, result })
  }

  respondError(id: CodexRpcId, message: string, code = -32000): void {
    this.write({ id, error: { code, message } })
  }

  close(): void {
    this.closing = true
    this.child?.kill()
    this.rejectAll(new Error('Codex app-server closed.'))
  }

  private async spawn(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Codex app-server backend currently supports Windows only.')
    const resolved = resolveWindowsCodexCommand()
    const args = [...resolved.argsPrefix, 'app-server']
    log('codex', `spawn app-server ${resolved.displayPath}`)
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
      if (trimmed) log('codex-stderr', trimmed)
    })
    child.on('error', (error) => {
      this.closed = true
      this.rejectAll(error)
      this.handlers.onClose(error.message)
    })
    child.on('close', (code) => {
      this.closed = true
      const detail = this.stderr.trim() || (code == null ? 'Codex app-server stopped.' : `Codex app-server exited with code ${code}.`)
      this.rejectAll(new Error(detail))
      if (!this.closing) this.handlers.onClose(detail)
    })

    await this.request('initialize', {
      clientInfo: { name: 'forge', title: 'Forge', version: '1.0.0' },
      capabilities: { experimentalApi: true }
    })
    this.notify('initialized')
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
    let msg: CodexRpcMessage
    try {
      msg = JSON.parse(line) as CodexRpcMessage
    } catch {
      log('codex', `non-json app-server stdout: ${line.slice(0, 240)}`)
      return
    }

    if (msg.id !== undefined && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error)) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timeout)
      if (msg.error) {
        pending.reject(new Error(msg.error.message || `${pending.method} failed`))
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

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child) throw new Error('Codex app-server is not running.')
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
