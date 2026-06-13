import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

let logPath: string | null = null

function ensurePath(): string {
  if (logPath) return logPath
  // In dev, process.cwd() is the project root (where package.json lives),
  // so logs/ lands at d:\localproject\codecli\logs.
  const dir = resolve(process.cwd(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  logPath = resolve(dir, 'main.log')
  return logPath
}

export function log(scope: string, msg: unknown): void {
  const ts = new Date().toISOString()
  const body = typeof msg === 'string' ? msg : safeStringify(msg)
  const line = `[${ts}] [${scope}] ${body}\n`
  try {
    appendFileSync(ensurePath(), line)
  } catch {
    /* best effort */
  }
  process.stderr.write(line)
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
