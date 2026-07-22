import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { log } from './logger'
import { resolveWindowsKimiCommand } from './windowsKimi'

/**
 * kimi 本地 server（REST + WebSocket + web UI 后端）连接管理。
 *
 * 实证事实：
 * - 启动方式：`kimi server run`（后台 daemon；--foreground 前台）。默认端口
 *   固定 58627；token 启动时打印并持久化到 ~/.kimi-code/server.token。
 * - 发现机制：~/.kimi-code/server/lock 是 JSON {pid, host, port, started_at}，
 *   直接读它拿端口；再读 server.token 做 Bearer 认证。
 * - tasks API：GET /api/v1/sessions/<sessionId>/tasks → {data:{items:[{id,
 *   session_id, kind: "bash"|"subagent", description, status, created_at,
 *   started_at, completed_at, command?}]}}。无分页（limit 参数被忽略，全量返回）。
 * - tasks/<id> 详情与列表项同形；没有子代理"最近动态"接口（web 卡片那行走
 *   WebSocket，REST 拿不到）——Tran 只渲染 description + status。
 *
 * 连接失败一律静默降级（返回 null），绝不影响聊天主链路。
 */

const PROBE_TIMEOUT_MS = 4000
const SERVER_BOOT_TIMEOUT_MS = 10000
const TASKS_TIMEOUT_MS = 8000

export interface KimiTaskInfo {
  id: string
  kind: string
  description?: string
  status?: string
  command?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
}

interface ServerHandle {
  baseUrl: string
  token: string
}

function lockPath(): string {
  return join(homedir(), '.kimi-code', 'server', 'lock')
}

function tokenPath(): string {
  return join(homedir(), '.kimi-code', 'server.token')
}

function readToken(): string | null {
  try {
    const token = readFileSync(tokenPath(), 'utf8').trim()
    return token || null
  } catch {
    return null
  }
}

/** 从 server/lock 读端口（拿不到就用默认 58627——kimi server run 的固定默认）。 */
function readLockPort(): number {
  try {
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8')) as { port?: unknown }
    if (typeof lock.port === 'number' && lock.port > 0) return lock.port
  } catch {
    /* lock 不存在或损坏 → 默认端口 */
  }
  return 58627
}

async function probe(baseUrl: string, token: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

let cachedHandle: ServerHandle | null = null
let spawnPromise: Promise<ServerHandle | null> | null = null

/** 拉起 kimi server daemon（detached，不等标准输出；靠轮询 probe 判活）。 */
async function spawnServer(): Promise<ServerHandle | null> {
  const token = readToken()
  if (!token) {
    log('kimi-server', 'no server.token, cannot start/probe server')
    return null
  }
  try {
    const resolved = resolveWindowsKimiCommand()
    log('kimi-server', `spawning kimi server run (${resolved.displayPath})`)
    const child = spawn(resolved.command, [...resolved.argsPrefix, 'server', 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
  } catch (error) {
    log('kimi-server', `spawn failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  // daemon 起来需要一两秒：轮询 probe 直到可用或超时。
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    const handle = { baseUrl: `http://127.0.0.1:${readLockPort()}`, token }
    if (await probe(handle.baseUrl, handle.token)) return handle
  }
  log('kimi-server', 'server did not come up in time')
  return null
}

/** 拿可用的 server 句柄：先探测现有实例（lock 端口），不行就自己拉起一次。 */
export async function ensureKimiServer(): Promise<ServerHandle | null> {
  const token = readToken()
  if (!token) return null
  const baseUrl = `http://127.0.0.1:${readLockPort()}`
  if (await probe(baseUrl, token)) {
    cachedHandle = { baseUrl, token }
    return cachedHandle
  }
  if (cachedHandle && (await probe(cachedHandle.baseUrl, cachedHandle.token))) {
    return cachedHandle
  }
  if (!spawnPromise) {
    spawnPromise = spawnServer().finally(() => {
      spawnPromise = null
    })
  }
  const handle = await spawnPromise
  if (handle) cachedHandle = handle
  return handle
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** 拉取某会话的全部 tasks（无分页，全量）。server 不可用返回 null（降级）。 */
export async function getSessionTasks(sessionId: string): Promise<KimiTaskInfo[] | null> {
  const handle = await ensureKimiServer()
  if (!handle) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TASKS_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${handle.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      { headers: { authorization: `Bearer ${handle.token}` }, signal: controller.signal }
    )
    if (!response.ok) {
      // token 失效（可能被 rotate）：清缓存下次重探测。
      if (response.status === 401 || response.status === 403) cachedHandle = null
      return null
    }
    const payload = (await response.json()) as unknown
    const items = asRecord(asRecord(payload)?.data)?.items
    if (!Array.isArray(items)) return []
    const tasks: KimiTaskInfo[] = []
    for (const raw of items) {
      const entry = asRecord(raw)
      const id = asString(entry?.id)
      const kind = asString(entry?.kind)
      if (!id || !kind) continue
      tasks.push({
        id,
        kind,
        ...(asString(entry?.description) ? { description: asString(entry?.description) } : {}),
        ...(asString(entry?.status) ? { status: asString(entry?.status) } : {}),
        ...(asString(entry?.command) ? { command: asString(entry?.command) } : {}),
        ...(asString(entry?.created_at) ? { createdAt: asString(entry?.created_at) } : {}),
        ...(asString(entry?.started_at) ? { startedAt: asString(entry?.started_at) } : {}),
        ...(asString(entry?.completed_at) ? { completedAt: asString(entry?.completed_at) } : {})
      })
    }
    return tasks
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function kimiServerLockExists(): boolean {
  return existsSync(lockPath())
}
