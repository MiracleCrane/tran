import { app } from 'electron'
import { join } from 'node:path'
import { log } from './logger'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'

/**
 * 会话归档（2026-08 用户功能）：归档 = Tran 侧的一个标记，会话数据原地不动
 * （kimi 的会话目录/索引不碰），列表只是不再显示。删除仍然只在归档页里发生
 * （多选后真删，走 forge:deleteSession）。
 *
 * 存档形状：`Record<sessionId, archivedAtMs>`。读盘失败后本次运行禁止写入——
 * 空表写回等于把用户的归档清单抹掉（与 settings/titles 同一约定）。
 */

let cache: Record<string, number> | null = null
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'archived-sessions.json')
}

function load(): Record<string, number> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('archive', `archived-sessions.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('archive', 'archived-sessions.json 内容不是对象，本次运行不再写入')
    cache = {}
    loadFailed = true
    return cache
  }
  cache = (raw as Record<string, number> | null) ?? {}
  return cache
}

function save(): void {
  if (loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('archive', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function getArchivedSessions(): Record<string, number> {
  return { ...load() }
}

/** 存档文件损坏（只读模式）时抛错：此前只改内存并静默"成功"，重启后本次
 *  所有归档操作蒸发且无任何提示。抛出让渲染层回滚乐观更新并提示用户。 */
function assertWritable(): void {
  if (loadFailed) {
    throw new Error('归档存档文件损坏，本次运行归档功能只读（重启 Tran 可尝试重建）')
  }
}

export function archiveSession(sessionId: string): void {
  load()
  assertWritable()
  load()[sessionId] = Date.now()
  save()
}

export function unarchiveSession(sessionId: string): void {
  const store = load()
  if (!(sessionId in store)) return
  assertWritable()
  delete store[sessionId]
  save()
}

/** 真删会话后的清理：归档表里的残留一并去掉。只读模式下静默跳过——
 *  这里是删除链路的附带清理，不能让它把已成功的删除炸成失败。 */
export function dropArchivedSession(sessionId: string): void {
  try {
    unarchiveSession(sessionId)
  } catch {
    /* 只读模式，残留标记等重启后处理 */
  }
}
