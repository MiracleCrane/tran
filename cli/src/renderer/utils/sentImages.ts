import { useSessionStore } from '../store/sessionStore'
import type { TranscriptItem, UserAttachment } from '../types'

/** #45 已发送图片附件的渲染层持久化。kimi 把图片以 blobref 存进自己的会话
 *  目录，但 ACP session/load 历史重放只合成文本块（user_message_chunk per
 *  text part），图片不带回；渲染层因此在发送成功时把图片 dataUrl 存进
 *  IndexedDB（按 sdkSessionId 分桶），历史重放时按消息文本顺序匹配补回
 *  缩略图。只管已发送消息——草稿附件不持久化（#31 的取舍）。 */

export interface SentImageRecord {
  sessionKey: string
  /** 发送时的展示文本（不含 Swarm 隐藏前缀；重放文本可能带，匹配时兼容）。 */
  text: string
  atts: UserAttachment[]
  at: number
}

interface StoredRecord extends SentImageRecord {
  key?: number
}

const DB_NAME = 'tran-sent-attachments'
const DB_VERSION = 1
const STORE_NAME = 'sentImages'
const MAX_RECORDS_PER_SESSION = 100

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key', autoIncrement: true })
        store.createIndex('sessionKey', 'sessionKey', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function readRecords(db: IDBDatabase, sessionKey: string): Promise<StoredRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).index('sessionKey').getAll(sessionKey)
    req.onsuccess = () =>
      resolve((req.result as StoredRecord[]).sort((a, b) => (a.key ?? 0) - (b.key ?? 0)))
    req.onerror = () => reject(req.error)
  })
}

/** 发送成功的用户消息里的图片附件落盘（fire-and-forget；失败只影响历史
 *  缩略图，不打断发送）。 */
export async function recordSentImages(
  sessionKey: string,
  text: string,
  attachments: UserAttachment[]
): Promise<void> {
  const atts = attachments.filter((a) => a.kind === 'image' && !!a.dataUrl)
  if (!sessionKey || atts.length === 0) return
  try {
    const db = await openDb()
    const addTx = db.transaction(STORE_NAME, 'readwrite')
    addTx.objectStore(STORE_NAME).add({ sessionKey, text, atts, at: Date.now() } satisfies SentImageRecord)
    await txDone(addTx)
    const records = await readRecords(db, sessionKey)
    const overflow = records.length - MAX_RECORDS_PER_SESSION
    if (overflow > 0) {
      const pruneTx = db.transaction(STORE_NAME, 'readwrite')
      for (const r of records.slice(0, overflow)) {
        if (r.key !== undefined) pruneTx.objectStore(STORE_NAME).delete(r.key)
      }
      await txDone(pruneTx)
    }
  } catch {
    // IndexedDB 不可用（隐私模式等）：历史不显示缩略图，功能不炸。
  }
}

/** 取该会话全部已发送图片记录（按写入顺序）。 */
export async function loadSentImages(sessionKey: string): Promise<SentImageRecord[]> {
  try {
    const db = await openDb()
    return await readRecords(db, sessionKey)
  } catch {
    return []
  }
}

/** 重放文本 = 实际发给 agent 的原文（Swarm 模式带隐藏前缀），记录文本 = 展示
 *  原文——先精确匹配，再 endsWith 兼容前缀；同文本多条按发送顺序消费。 */
function recordMatches(sentText: string, replayText: string): boolean {
  const sent = sentText.trim()
  if (!sent) return false
  return replayText === sent || replayText.endsWith(sent)
}

/** 历史重放的用户消息（无附件）按顺序匹配已发送记录，返回 itemId → 附件。 */
export function matchHistoryImages(
  items: TranscriptItem[],
  records: SentImageRecord[]
): Map<string, UserAttachment[]> {
  const result = new Map<string, UserAttachment[]>()
  if (records.length === 0) return result
  const used = new Set<number>()
  for (const item of items) {
    if (item.kind !== 'user' || !item.isHistory || item.attachments?.length) continue
    const text = item.text.trim()
    if (!text) continue
    const exact = records.findIndex((r, i) => !used.has(i) && r.text.trim() === text)
    const idx =
      exact >= 0 ? exact : records.findIndex((r, i) => !used.has(i) && recordMatches(r.text, text))
    if (idx < 0) continue
    used.add(idx)
    result.set(item.id, records[idx].atts)
  }
  return result
}

/** 订阅 store：发送成功的用户消息（items 里带图片附件的非历史 user item）
 *  自动落盘。Transcript 挂载时调用一次即可（内部幂等）。 */
const recordedItemIds = new Set<string>()
let recording = false
/** 上次扫描过的 items 引用：store 任何字段更新都会触发订阅回调，
 *  items 没换引用就不用重扫（流式批量更新之外的高频更新全部短路）。 */
let lastScannedItems: unknown = null
export function initSentImageRecording(): void {
  if (recording) return
  recording = true
  const scan = (): void => {
    const s = useSessionStore.getState()
    if (s.items === lastScannedItems) return
    const sessionKey = s.meta?.sdkSessionId ?? s.meta?.sessionId
    // meta 未就绪先不落盘也不记指纹：等 meta 到位后同一批 items 还能补扫。
    if (!sessionKey) return
    lastScannedItems = s.items
    for (const item of s.items) {
      if (item.kind !== 'user' || item.isHistory || recordedItemIds.has(item.id)) continue
      const atts = item.attachments ?? []
      if (!atts.some((a) => a.kind === 'image' && !!a.dataUrl)) continue
      recordedItemIds.add(item.id)
      void recordSentImages(sessionKey, item.text, atts)
    }
    // 超限只淘汰已不在 items 里的 id：整个 clear 会让仍在场的带图消息下次
    // 扫描被重复落盘（IndexedDB 重复条目会让历史匹配错位吞掉后续匹配）。
    if (recordedItemIds.size > 5000) {
      const alive = new Set(s.items.map((i) => i.id))
      for (const id of recordedItemIds) {
        if (!alive.has(id)) recordedItemIds.delete(id)
      }
    }
  }
  scan()
  useSessionStore.subscribe(scan)
}
