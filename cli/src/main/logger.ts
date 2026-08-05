import { app } from 'electron'
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
let cachedLogDir: string | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null

const LOG_FILE_NAME = 'main.log'
const LOG_ARCHIVE_PREFIX = 'main-'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_FILES = 8
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 日志目录惰性解析并缓存：基于 process.cwd() 的话，打包后 cwd 可能是
 *  System32 或只读目录，统一落到 userData/logs。app.getPath('userData')
 *  在 ready 前即可用；为防极端环境（app 尚不可用/被非主进程加载）解析
 *  失败时回退 cwd。 */
function logDir(): string {
  if (cachedLogDir) return cachedLogDir
  let dir: string
  try {
    dir = resolve(app.getPath('userData'), 'logs')
  } catch {
    dir = resolve(process.cwd(), 'logs')
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  cachedLogDir = dir
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

/** 轮转检查降频：此前每条日志都 existsSync+statSync 一遍，纯浪费。
 *  改为每 ROTATE_CHECK_EVERY 条才 stat 一次（首条立即检查）；2MB 阈值下
 *  最多多写百来条日志的量，无实际影响。文件不存在时 statSync 抛错走
 *  catch，等价于原先的 existsSync 判断。 */
const ROTATE_CHECK_EVERY = 100
let writesSinceRotateCheck = ROTATE_CHECK_EVERY

function rotateIfNeeded(path: string): void {
  writesSinceRotateCheck += 1
  if (writesSinceRotateCheck < ROTATE_CHECK_EVERY) return
  writesSinceRotateCheck = 0
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return
    const archivePath = resolve(logDir(), `${LOG_ARCHIVE_PREFIX}${timestampForFile()}.log`)
    renameSync(path, archivePath)
  } catch {
    /* 文件不存在或 stat 失败：无需轮转 */
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
  if (!existsSync(path)) return 'No Tran main log found.'
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .slice(-maxLines)
      .join('\n')
      .trim()
  } catch {
    return 'No Tran main log found.'
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
