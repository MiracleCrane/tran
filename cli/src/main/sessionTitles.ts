import { app } from 'electron'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { join } from 'node:path'
import { log } from './logger'

/** 本地会话标题兜底：kimi 的 session/list 对未命名会话只回 "New Session"，
 *  Tran 在首条用户消息发出时记录本地标题，列表渲染时兜底显示。 */

const MAX_TITLE_LEN = 60

let cache: Record<string, string> | null = null
/** 读盘失败（不是"文件不存在"）后禁止落盘：底下压着的可能是完整的标题表，
 *  空对象写回去等于把用户所有会话名一次性抹掉。见 settings.ts 的同款处理。 */
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'session-titles.json')
}

/** 读一个 `Record<string, string>` 存档；读失败时置 failed 标记并返回空表。 */
function loadRecord(
  path: string,
  tag: string
): { value: Record<string, string>; failed: boolean } {
  const read = readJsonSafe<unknown>(path)
  if (read.status === 'failed') {
    log('titles', `${tag} 读取失败，本次运行不再写入该文件：${read.error.message}`)
    return { value: {}, failed: true }
  }
  if (read.status === 'missing') return { value: {}, failed: false }
  const raw = read.value
  // 数组也是 typeof 'object'，但不是我们要的形状——当作损坏处理。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log('titles', `${tag} 内容不是对象，本次运行不再写入该文件`)
    return { value: {}, failed: true }
  }
  return { value: raw as Record<string, string>, failed: false }
}

function load(): Record<string, string> {
  if (cache) return cache
  const { value, failed } = loadRecord(storePath(), 'session-titles.json')
  cache = value
  loadFailed = failed
  return cache
}

function save(): void {
  if (loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('titles', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 记录会话的首条用户消息作为本地标题（已存在则不覆盖）。 */
export function recordSessionTitle(sessionId: string, text: string): void {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LEN)
  if (!sessionId || !title) return
  const map = load()
  if (map[sessionId]) return
  map[sessionId] = title
  save()
}

export function localSessionTitle(sessionId: string): string | undefined {
  return load()[sessionId]
}

/** 会话删除后清掉本地标题记录。 */
export function removeSessionTitle(sessionId: string): void {
  const map = load()
  if (!(sessionId in map)) return
  delete map[sessionId]
  save()
  removeManualTitle(sessionId)
}

/** --- 手动重命名（用户编辑的标题，优先级最高，AI/兜底都不覆盖） --- */

let manualCache: Record<string, string> | null = null
let manualLoadFailed = false

function manualStorePath(): string {
  return join(app.getPath('userData'), 'session-titles-manual.json')
}

function loadManual(): Record<string, string> {
  if (manualCache) return manualCache
  const { value, failed } = loadRecord(manualStorePath(), 'session-titles-manual.json')
  manualCache = value
  manualLoadFailed = failed
  return manualCache
}

function saveManual(): void {
  // 手动重命名是用户亲手输入的，最不该被一次读失败抹掉。
  if (manualLoadFailed) return
  try {
    writeFileAtomic(manualStorePath(), JSON.stringify(loadManual(), null, 1))
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
