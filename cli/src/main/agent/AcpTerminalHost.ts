import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

const DEFAULT_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024
const MAX_OUTPUT_BYTE_LIMIT = 16 * 1024 * 1024

export const ACP_TERMINAL_METHODS = new Set([
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release'
])

interface TerminalExitStatus {
  exitCode: number | null
  signal: string | null
}

interface TerminalEntry {
  id: string
  sessionId: string
  child: ChildProcess
  output: string
  outputByteLimit: number
  truncated: boolean
  exitStatus?: TerminalExitStatus
  exitPromise: Promise<TerminalExitStatus>
  released: boolean
}

type SessionCwdResolver = (sessionId: string) => string | undefined

/** Owns ACP client-side terminal processes and their bounded output/lifetime. */
export class AcpTerminalHost {
  private readonly terminals = new Map<string, TerminalEntry>()

  constructor(private readonly sessionCwd: SessionCwdResolver) {}

  async handle(method: string, rawParams: unknown): Promise<unknown> {
    if (!ACP_TERMINAL_METHODS.has(method)) throw new Error(`Unsupported ACP terminal method: ${method}`)
    const params = asRecord(rawParams)
    const sessionId = requiredString(params, 'sessionId')
    if (method === 'terminal/create') return this.create(sessionId, params)

    const terminal = this.requireTerminal(sessionId, requiredString(params, 'terminalId'))
    if (method === 'terminal/output') return this.output(terminal)
    if (method === 'terminal/wait_for_exit') return terminal.exitPromise
    if (method === 'terminal/kill') {
      await this.kill(terminal)
      return {}
    }
    await this.release(terminal)
    return {}
  }

  releaseSession(sessionId: string): void {
    for (const terminal of [...this.terminals.values()]) {
      if (terminal.sessionId === sessionId) void this.release(terminal)
    }
  }

  dispose(): void {
    for (const terminal of [...this.terminals.values()]) void this.release(terminal)
  }

  private create(sessionId: string, params: Record<string, unknown>): { terminalId: string } {
    const fallbackCwd = this.sessionCwd(sessionId)
    if (!fallbackCwd) throw new Error(`Unknown ACP session: ${sessionId}`)
    const command = requiredString(params, 'command')
    const args = stringArray(params.args, 'args')
    const cwd = params.cwd === undefined ? fallbackCwd : requiredString(params, 'cwd')
    if (!isAbsolute(cwd)) throw new Error('cwd must be an absolute path')

    const terminalId = `term_${randomUUID()}`
    const child = spawn(command, args, {
      cwd,
      env: terminalEnv(params.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settleExit!: (status: TerminalExitStatus) => void
    const exitPromise = new Promise<TerminalExitStatus>((resolve) => { settleExit = resolve })
    const terminal: TerminalEntry = {
      id: terminalId,
      sessionId,
      child,
      output: '',
      outputByteLimit: boundedOutputLimit(params.outputByteLimit),
      truncated: false,
      exitPromise,
      released: false
    }
    this.terminals.set(terminalId, terminal)

    const append = (chunk: Buffer | string): void => this.appendOutput(terminal, chunk.toString())
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => this.appendOutput(terminal, `${error.message}\n`))
    child.once('close', (code, signal) => {
      const status: TerminalExitStatus = {
        exitCode: typeof code === 'number' ? code : null,
        signal: signal == null ? null : String(signal)
      }
      terminal.exitStatus = status
      settleExit(status)
    })
    return { terminalId }
  }

  private output(terminal: TerminalEntry): Record<string, unknown> {
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {})
    }
  }

  private appendOutput(terminal: TerminalEntry, chunk: string): void {
    if (!chunk) return
    terminal.output += chunk
    const bytes = Buffer.from(terminal.output, 'utf8')
    if (bytes.length <= terminal.outputByteLimit) return
    const tail = bytes.subarray(bytes.length - terminal.outputByteLimit)
    let start = 0
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++
    terminal.output = tail.subarray(start).toString('utf8')
    terminal.truncated = true
  }

  private requireTerminal(sessionId: string, terminalId: string): TerminalEntry {
    const terminal = this.terminals.get(terminalId)
    if (!terminal || terminal.released || terminal.sessionId !== sessionId) {
      throw new Error(`Unknown ACP terminal: ${terminalId}`)
    }
    return terminal
  }

  private async kill(terminal: TerminalEntry): Promise<void> {
    const child = terminal.child
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (process.platform === 'win32' && child.pid) {
        const killedTree = await taskkillTree(child.pid)
        if (!killedTree && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* best-effort cleanup */
    }
  }

  private async release(terminal: TerminalEntry): Promise<void> {
    if (terminal.released) return
    terminal.released = true
    this.terminals.delete(terminal.id)
    await this.kill(terminal)
  }
}

function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(ok)
    }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.once('error', () => finish(false))
    killer.once('close', (code) => finish(code === 0))
    const timeout = setTimeout(() => {
      try { killer.kill() } catch { /* best-effort cleanup */ }
      finish(false)
    }, 2000)
    timeout.unref()
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ACP terminal params must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value) throw new Error(`${key} is required`)
  return value
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}

function boundedOutputLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_OUTPUT_BYTE_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('outputByteLimit must be a positive number')
  }
  return Math.min(Math.floor(value), MAX_OUTPUT_BYTE_LIMIT)
}

function terminalEnv(value: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (value === undefined) return env
  if (!Array.isArray(value)) throw new Error('env must be an array')
  for (const item of value) {
    const record = asRecord(item)
    const name = requiredString(record, 'name')
    if (typeof record.value !== 'string') throw new Error('env value must be a string')
    env[name] = record.value
  }
  return env
}
