import type { TranscriptItem } from './types'

/**
 * 「改动目标仓库」推导（2026-09-02）：会话改动文件可能落在会话 cwd 之外的
 * 仓库（cwd 是无项目 scratch 目录，或 agent 改了另一个仓库）。这里提供
 * 纯函数部分：路径折算 + 从 turnChanges 条目收集文件 + 多数派计票。
 * 触发时机与结果落地在 sessionStore（changesGitRoot）。
 *
 * 注意：改动文件路径来自 agent 工具输入，绝对/相对混杂，相对路径的基准是
 * 会话 cwd；Windows 上大小写、正反斜杠都可能不一致，比较一律走归一化。
 */

/** 归一化：统一正斜杠、折叠重复斜杠（保留 UNC 前导 //）、去尾斜杠。 */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/')
  const unc = out.startsWith('//')
  out = out.replace(/\/{2,}/g, '/')
  if (unc) out = '/' + out
  return out.replace(/\/+$/, '')
}

/** 绝对路径判定：Windows 盘符 / UNC / POSIX 根（WSL 路径）都算。 */
export function isAbsolutePath(p: string): boolean {
  const n = normalizePath(p)
  return /^[A-Za-z]:\//.test(n) || n.startsWith('//') || n.startsWith('/')
}

/** 解析 `.` / `..` 段（不触盘，纯字符串；越过根的 .. 直接丢弃）。 */
function resolveSegments(p: string): string {
  const n = normalizePath(p)
  const isRootAbs = n.startsWith('/')
  const parts = n.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') {
      // 首段空串（绝对路径）或盘符段要保留
      if (out.length === 0 && part === '' && isRootAbs) out.push('')
      continue
    }
    if (part === '..') {
      // 盘符（C:）或根之上不能再退
      if (out.length > 1 || (out.length === 1 && out[0] !== '' && !/^[A-Za-z]:$/.test(out[0]))) out.pop()
      continue
    }
    out.push(part)
  }
  if (out.length === 0) return isRootAbs ? '/' : '.'
  if (out.length === 1 && out[0] === '') return '/'
  return out.join('/')
}

/** 相对路径按会话 cwd 转绝对（已是绝对的直接归一化返回）。 */
export function toAbsolutePath(p: string, cwd: string): string {
  if (isAbsolutePath(p)) return resolveSegments(p)
  const base = normalizePath(cwd)
  return resolveSegments(base ? `${base}/${p}` : p)
}

/** 目录名（最后一段之前；根/无斜杠返回空串）。 */
export function dirnameOf(p: string): string {
  const n = normalizePath(p)
  const idx = n.lastIndexOf('/')
  if (idx <= 0) return ''
  return n.slice(0, idx)
}

/** abs 折成 root 的相对路径（大小写不敏感）；不在 root 内返回 null。 */
export function relativePathTo(root: string, abs: string): string | null {
  const r = normalizePath(root).toLowerCase()
  const a = normalizePath(abs)
  const al = a.toLowerCase()
  if (al === r) return ''
  if (al.startsWith(r + '/')) return a.slice(r.length + 1)
  return null
}

export interface ChangeFileEntry {
  /** 折算后的绝对路径（归一化）。 */
  abs: string
  /** 第几张 turnChanges 卡（从 1 起），平票时取最近一轮用。 */
  turn: number
}

/** 从会话 items 的 turnChanges 条目收集改动文件（绝对路径 + 轮次序号）。 */
export function collectChangeFileEntries(items: TranscriptItem[], cwd: string): ChangeFileEntry[] {
  const entries: ChangeFileEntry[] = []
  let turn = 0
  for (const it of items) {
    if (it.kind !== 'turnChanges') continue
    turn++
    for (const f of it.files) {
      if (!f.path) continue
      entries.push({ abs: toAbsolutePath(f.path, cwd), turn })
    }
  }
  return entries
}

/** 改动文件按仓库根的分组（2026-09-02 分组改动面板）。 */
export interface ChangesGitGroup {
  /** 仓库根（绝对路径）；null = 这组文件不在任何 git 仓库。 */
  root: string | null
  /** 组内改动文件（绝对路径，归一化、去重、按路径排序）。 */
  files: string[]
}

/** 多数派计票：文件数最多的仓库根胜出；平票取最近一轮有改动的。
 *  rootForDir 返回 null（不在任何 git 仓库）的文件不参与计票。 */
export function pickMajorityRepoRoot(
  entries: ChangeFileEntry[],
  rootForDir: (dir: string) => string | null
): string | null {
  const tally = new Map<string, { root: string; count: number; lastTurn: number }>()
  for (const e of entries) {
    const root = rootForDir(dirnameOf(e.abs))
    if (!root) continue
    const key = normalizePath(root).toLowerCase()
    const t = tally.get(key) ?? { root, count: 0, lastTurn: 0 }
    t.count += 1
    if (e.turn > t.lastTurn) t.lastTurn = e.turn
    tally.set(key, t)
  }
  let best: { root: string; count: number; lastTurn: number } | null = null
  for (const t of tally.values()) {
    if (!best || t.count > best.count || (t.count === best.count && t.lastTurn > best.lastTurn)) best = t
  }
  return best?.root ?? null
}

/**
 * 改动文件按仓库根分组（2026-09-02 分组改动面板）：会话改动同时落在多个
 * git 工作区时，改动面板按组渲染、每组用自己的 root 出 diff。与
 * pickMajorityRepoRoot 吃同一份 entries + rootForDir（同一趟 gitRepoRoots
 * IPC 的结果），majorityRoot 传多数派计票的结果。
 *
 * 排序：多数派仓库在最前；其余仓库按文件数降序（平数取最近一轮有改动的
 * 在前）；root=null（不在任何 git 仓库）固定垫底。
 */
export function groupChangeFilesByRepoRoot(
  entries: ChangeFileEntry[],
  rootForDir: (dir: string) => string | null,
  majorityRoot: string | null
): ChangesGitGroup[] {
  const groups = new Map<string, { root: string | null; files: Set<string>; lastTurn: number }>()
  for (const e of entries) {
    const root = rootForDir(dirnameOf(e.abs))
    // root=null 归到同一组（key 空串）；仓库根比较大小写不敏感（Windows）
    const key = root ? normalizePath(root).toLowerCase() : ''
    const g = groups.get(key) ?? { root, files: new Set<string>(), lastTurn: 0 }
    g.files.add(e.abs)
    if (e.turn > g.lastTurn) g.lastTurn = e.turn
    groups.set(key, g)
  }
  const majorityKey = majorityRoot ? normalizePath(majorityRoot).toLowerCase() : null
  const list = [...groups.values()]
  list.sort((a, b) => {
    const aMaj = majorityKey !== null && a.root !== null && normalizePath(a.root).toLowerCase() === majorityKey
    const bMaj = majorityKey !== null && b.root !== null && normalizePath(b.root).toLowerCase() === majorityKey
    if (aMaj !== bMaj) return aMaj ? -1 : 1
    if ((a.root === null) !== (b.root === null)) return a.root === null ? 1 : -1
    if (a.files.size !== b.files.size) return b.files.size - a.files.size
    return b.lastTurn - a.lastTurn
  })
  return list.map((g) => ({ root: g.root, files: [...g.files].sort((x, y) => x.localeCompare(y)) }))
}
