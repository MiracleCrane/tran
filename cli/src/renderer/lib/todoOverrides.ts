import type { PlanEntry } from '../types'

/** 手动勾掉待办（2026-08-26 用户：「有时候早就完成了但是不会更新」——agent 的
 *  待办列表会停滞）。ACP 的 plan 是只读推送（kimi 每次全量重写列表），写不回去，
 *  所以手动完成是**纯本地**覆盖层：按会话存 localStorage，渲染时合并进条目，
 *  服务端状态一概不动。 */

const TODO_OVERRIDES_STORAGE_KEY = 'forge.todoOverrides.v1'

/** 覆盖表：sdkSessionId → todoKey → true。只存「被手动勾掉」这一条信息——
 *  服务端已完成的条目不需要也不允许覆盖（ACP 只读，没有真值可回退）。 */
type TodoOverrideMap = Record<string, Record<string, true>>

/** 条目身份（todoKey）：PlanEntry 本身没有 id（见 types.ts），kimi 又每次全量
 *  重写列表、顺序不稳定，所以取内容文本的 FNV-1a 哈希（trim 后）。边界：两条
 *  content 逐字相同的条目会共享一个 override——kimi 生成的待办文案几乎不会
 *  逐字重复，接受这个碰撞。 */
export function todoKeyOf(content: string): string {
  let h = 0x811c9dc5
  const s = content.trim()
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function readAllTodoOverrides(): TodoOverrideMap {
  try {
    const raw = window.localStorage.getItem(TODO_OVERRIDES_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // 持久化的值不能信：只收 { string: { string: true } } 的形状。
    const out: TodoOverrideMap = {}
    for (const [sid, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
      const clean: Record<string, true> = {}
      for (const k of Object.keys(entries as Record<string, unknown>)) {
        if ((entries as Record<string, unknown>)[k] === true) clean[k] = true
      }
      if (Object.keys(clean).length > 0) out[sid] = clean
    }
    return out
  } catch {
    return {}
  }
}

function writeAllTodoOverrides(map: TodoOverrideMap): void {
  try {
    window.localStorage.setItem(TODO_OVERRIDES_STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function readTodoOverrides(sdkSessionId: string): Record<string, true> {
  return readAllTodoOverrides()[sdkSessionId] ?? {}
}

export function storeTodoOverrides(sdkSessionId: string, overrides: Record<string, true>): void {
  const all = readAllTodoOverrides()
  if (Object.keys(overrides).length === 0) delete all[sdkSessionId]
  else all[sdkSessionId] = overrides
  writeAllTodoOverrides(all)
}

/** 删会话时清掉该会话的覆盖（与权限档/草稿同一条清理路径，见 sessionStore
 *  forgetSessionLocalState：localStorage 有配额，指向已删会话的死键不能越攒越多）。 */
export function clearTodoOverrides(sdkSessionId: string): void {
  const all = readAllTodoOverrides()
  if (!(sdkSessionId in all)) return
  delete all[sdkSessionId]
  writeAllTodoOverrides(all)
}

/** 渲染合并：override 命中的未完成条目按 completed 显示。无 override 时原样
 *  返回（调用方多在 zustand selector / memo 链路里，省无效重渲染）。 */
export function mergeTodoOverrides(entries: PlanEntry[], overrides: Record<string, true>): PlanEntry[] {
  if (Object.keys(overrides).length === 0) return entries
  return entries.map((e) =>
    e.status !== 'completed' && overrides[todoKeyOf(e.content)] ? { ...e, status: 'completed' as const } : e
  )
}

/** 懒清理（2026-08-26）：kimi 每次全量重写列表，条目一旦消失基本不会原文回归，
 *  它的 override 留着只是垃圾。refreshTodos 落新列表时顺手丢弃已消失的 key。
 *  空列表不清理——那更可能是服务端没落盘/拉取异常的瞬时态，不能顺手把用户的
 *  手动勾选全抹掉。返回 null 表示无变化。 */
export function pruneVanishedTodoOverrides(
  overrides: Record<string, true>,
  entries: PlanEntry[]
): Record<string, true> | null {
  if (Object.keys(overrides).length === 0 || entries.length === 0) return null
  const live = new Set(entries.map((e) => todoKeyOf(e.content)))
  let changed = false
  const next: Record<string, true> = {}
  for (const k of Object.keys(overrides)) {
    if (live.has(k)) next[k] = true
    else changed = true
  }
  return changed ? next : null
}
