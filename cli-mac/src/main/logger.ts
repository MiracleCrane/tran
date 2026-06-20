import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { resolve } from 'node:path'

let logPath: string | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null

const LOG_FILE_NAME = 'main.log'
const LOG_ARCHIVE_PREFIX = 'main-'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_FILES = 8
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

function logDir(): string {
  // In dev, process.cwd() is the project root (where package.json lives),
  // so logs/ lands at d:\localproject\codecli\logs.
  const dir = resolve(process.cwd(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  return dir
}

function ensurePath(): string {
  if (logPath) return logPath
  logPath = resolve(logDir(), LOG_FILE_NAME)
  return logPath
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < MAX_LOG_BYTES) return
    const archivePath = resolve(logDir(), `${LOG_ARCHIVE_PREFIX}${timestampForFile()}.log`)
    renameSync(path, archivePath)
  } catch {
    /* best effort */
  }
}

function archiveStats(): Array<{ path: string; mtimeMs: number }> {
  try {
    return readdirSync(logDir(), { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() &&
        entry.name.startsWith(LOG_ARCHIVE_PREFIX) &&
        entry.name.endsWith('.log')
      )
      .map((entry) => {
        const path = resolve(logDir(), entry.name)
        let mtimeMs = 0
        try {
          mtimeMs = statSync(path).mtimeMs
        } catch {
          /* leave zero */
        }
        return { path, mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

export function runLogMaintenance(): void {
  const now = Date.now()
  const archives = archiveStats()
  archives.forEach((archive, index) => {
    const expired = now - archive.mtimeMs > LOG_RETENTION_MS
    const overLimit = index >= MAX_ARCHIVE_FILES
    if (!expired && !overLimit) return
    try {
      unlinkSync(archive.path)
    } catch {
      /* best effort */
    }
  })
}

export function scheduleLogMaintenance(): void {
  if (maintenanceTimer !== null) return
  runLogMaintenance()
  maintenanceTimer = setInterval(runLogMaintenance, LOG_CLEANUP_INTERVAL_MS)
  maintenanceTimer.unref?.()
}

export function log(scope: string, msg: unknown): void {
  const ts = new Date().toISOString()
  const body = typeof msg === 'string' ? msg : safeStringify(msg)
  const line = `[${ts}] [${scope}] ${body}\n`
  try {
    const path = ensurePath()
    rotateIfNeeded(path)
    appendFileSync(path, line, 'utf8')
  } catch {
    /* best effort */
  }
  process.stderr.write(line)
}

export function readRecentLog(maxLines = 220): string {
  const path = ensurePath()
  if (!existsSync(path)) return 'No Forge main log found.'
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .slice(-maxLines)
      .join('\n')
      .trim()
  } catch {
    return 'No Forge main log found.'
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
