import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger'

/** 本地会话标题兜底：kimi 的 session/list 对未命名会话只回 "New Session"，
 *  Tran 在首条用户消息发出时记录本地标题，列表渲染时兜底显示。 */

const MAX_TITLE_LEN = 60

let cache: Record<string, string> | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'session-titles.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as unknown
    cache = raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
  } catch {
    cache = {}
  }
  return cache
}

/** 记录会话的首条用户消息作为本地标题（已存在则不覆盖）。 */
export function recordSessionTitle(sessionId: string, text: string): void {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN)
  if (!sessionId || !title) return
  const map = load()
  if (map[sessionId]) return
  map[sessionId] = title
  try {
    mkdirSync(dirname(storePath()), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(map, null, 1), 'utf8')
  } catch (error) {
    log('titles', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function localSessionTitle(sessionId: string): string | undefined {
  return load()[sessionId]
}

/** 会话删除后清掉本地标题记录。 */
export function removeSessionTitle(sessionId: string): void {
  const map = load()
  if (!(sessionId in map)) return
  delete map[sessionId]
  try {
    mkdirSync(dirname(storePath()), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(map, null, 1), 'utf8')
  } catch (error) {
    log('titles', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  removeManualTitle(sessionId)
}

/** --- 手动重命名（用户编辑的标题，优先级最高，AI/兜底都不覆盖） --- */

let manualCache: Record<string, string> | null = null

function manualStorePath(): string {
  return join(app.getPath('userData'), 'session-titles-manual.json')
}

function loadManual(): Record<string, string> {
  if (manualCache) return manualCache
  try {
    const raw = JSON.parse(readFileSync(manualStorePath(), 'utf8')) as unknown
    manualCache = raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
  } catch {
    manualCache = {}
  }
  return manualCache
}

function saveManual(): void {
  try {
    mkdirSync(dirname(manualStorePath()), { recursive: true })
    writeFileSync(manualStorePath(), JSON.stringify(loadManual(), null, 1), 'utf8')
  } catch (error) {
    log('titles', `save manual failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 记录用户手动重命名（覆盖式，用户改几次都以最后一次为准）。 */
export function recordManualTitle(sessionId: string, title: string): void {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN)
  if (!sessionId || !clean) return
  loadManual()[sessionId] = clean
  saveManual()
}

export function manualSessionTitle(sessionId: string): string | undefined {
  return loadManual()[sessionId]
}

function removeManualTitle(sessionId: string): void {
  const map = loadManual()
  if (!(sessionId in map)) return
  delete map[sessionId]
  saveManual()
}
