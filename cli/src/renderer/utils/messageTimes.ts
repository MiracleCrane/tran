import { useSessionStore } from '../store/sessionStore'

/** #43 消息时间戳：wire 事件与 session/load 历史重放都不带消息级时间
 *  （kimi ACP 重放只合成文本/工具块通知），live 消息在渲染层打 Reception
 *  时间；历史重放消息无事件时间，诚实缺省（不显示，同 ToolBlock.startedAt
 *  的取舍）。 */

const times = new Map<string, number>()
const MAX_ENTRIES = 5000

function stamp(items: readonly { id: string; isHistory?: boolean }[]): void {
  const now = Date.now()
  for (const item of items) {
    if (!item || item.isHistory || times.has(item.id)) continue
    times.set(item.id, now)
  }
  if (times.size > MAX_ENTRIES) {
    // Map 迭代序即插入序：淘汰最旧的一批，防长会话无界增长。
    let drop = Math.ceil(MAX_ENTRIES / 5)
    for (const key of times.keys()) {
      times.delete(key)
      if (--drop <= 0) break
    }
  }
}

let subscribed = false
function ensureSubscription(): void {
  if (subscribed) return
  subscribed = true
  stamp(useSessionStore.getState().items)
  useSessionStore.subscribe((s) => stamp(s.items))
}

/** live 消息的接收时间（首次出现在 items 时打上）；历史消息返回 undefined。 */
export function messageTime(itemId: string): number | undefined {
  ensureSubscription()
  return times.get(itemId)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** #43 悬停浮出用的短格式：HH:mm:ss 小字（live 消息几乎都是当天，日期放 title 里）。 */
export function formatTimeShort(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** #43 悬停用的完整时间：绝对年月日 + 时分秒，不做相对化。 */
export function formatTimeFull(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`
}

/** Kimi Web 风：今天 HH:mm；昨天 "昨天 HH:mm"；今年内 M月D日 HH:mm；跨年带年。 */
export function formatMessageTime(at: number): string {
  const d = new Date(at)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const now = new Date()
  if (sameDay(d, now)) return hm
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}
