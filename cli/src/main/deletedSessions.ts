import { app } from 'electron'
import { join } from 'node:path'
import { log } from './logger'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'

/**
 * 已删会话墓碑（2026-08-14「删不掉」实测根因）：Tran 删除会话 = 移除索引行 +
 *  删目录，但 kimi 自己的 query-store/search-index 缓存还把这条会话吐给
 *  session/list——删除后第一次刷新它就"复活"（要 kimi 自己加载失败才会清掉
 *  那条缓存）。所以删除成功后在这里记账，listKimiSessions 一律过滤。
 *
 *  sessionId 是 UUID 不会复用，墓碑永久有效。文件损坏走只读防线（与
 *  归档/标题同一约定：读失败禁止写，防止空表覆写真值）。
 */

let cache: Record<string, number> | null = null
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'deleted-sessions.json')
}

function load(): Record<string, number> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('session-delete', `deleted-sessions.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {}
  return cache
}

export function markSessionDeleted(sessionId: string): void {
  load()
  if (loadFailed) return
  load()[sessionId] = Date.now()
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('session-delete', `tombstone save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function isSessionDeleted(sessionId: string): boolean {
  return sessionId in load()
}
