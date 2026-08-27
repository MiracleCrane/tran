import { app } from 'electron'
import { join } from 'node:path'
import { log } from './logger'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'

/**
 * 会话→项目归属（2026-08-27「移动到项目」，Codex 语义）：归属 = Tran 侧的
 * 一条元数据映射，会话的 cwd/数据原地不动——resume/加载仍走真实目录，agent
 * 继续在原目录工作。移动会话只是改这里的一行。
 *
 * 键 = 侧栏 sessionKey（`${runtimeBackend ?? 'windows'}:${sessionId}`，与
 * 未读气泡同一键格式）；值 projectPath：string = 归到该项目，
 * null = 显式「不在项目中工作」；**无条目 = 默认跟随 cwd**。
 *
 * 读盘失败走只读防线（与归档/标题同一约定：空表写回等于把用户的归属表
 * 一次性抹掉）。
 */

interface SessionProjectEntry {
  projectPath: string | null
  updatedAt: number
}

let cache: Record<string, SessionProjectEntry> | null = null
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'session-projects.json')
}

function load(): Record<string, SessionProjectEntry> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('session-projects', `session-projects.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('session-projects', 'session-projects.json 内容不是对象，本次运行不再写入')
    cache = {}
    loadFailed = true
    return cache
  }
  // 逐条校验形状：坏条目丢弃而不是连累整张表。
  const out: Record<string, SessionProjectEntry> = {}
  for (const [key, entry] of Object.entries((raw as Record<string, unknown> | null) ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { projectPath, updatedAt } = entry as Record<string, unknown>
    if (projectPath !== null && typeof projectPath !== 'string') continue
    out[key] = { projectPath, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 }
  }
  cache = out
  return cache
}

function save(): void {
  if (loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('session-projects', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 渲染层镜像的形状：sessionKey → projectPath（updatedAt 是主进程内部字段，
 *  不下发）。 */
export function getSessionProjectAssignments(): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [key, entry] of Object.entries(load())) out[key] = entry.projectPath
  return out
}

/** 存档文件损坏（只读模式）时抛错：让渲染层回滚乐观更新，而不是静默"成功"
 *  后重启蒸发（同 archivedSessions 的处理）。 */
function assertWritable(): void {
  if (loadFailed) {
    throw new Error('会话项目归属存档文件损坏，本次运行该功能只读（重启 Tran 可尝试重建）')
  }
}

/** 记录/改归属：projectPath = null 表示显式「不在项目中工作」。 */
export function setSessionProjectAssignment(sessionKey: string, projectPath: string | null): void {
  load()
  assertWritable()
  load()[sessionKey] = { projectPath, updatedAt: Date.now() }
  save()
}

/** 清除覆盖：条目删掉，回到「跟随 cwd」默认。 */
export function clearSessionProjectAssignment(sessionKey: string): void {
  const store = load()
  if (!(sessionKey in store)) return
  assertWritable()
  delete store[sessionKey]
  save()
}

/** 真删会话后的清理：键带后端前缀（`windows:`/`wsl:`），按 `:sessionId` 后缀
 *  把两种后端键一并去掉。只读模式下静默跳过——这里是删除链路的附带清理，
 *  不能让它把已成功的删除炸成失败（同 dropArchivedSession）。 */
export function dropSessionProjectAssignment(sessionId: string): void {
  try {
    const store = load()
    const suffix = `:${sessionId}`
    const keys = Object.keys(store).filter((key) => key.endsWith(suffix))
    if (!keys.length) return
    assertWritable()
    for (const key of keys) delete store[key]
    save()
  } catch {
    /* 只读模式，残留条目等重启后处理 */
  }
}
