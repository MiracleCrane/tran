/** 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前。
 *  原先只在 Sidebar 里，空态的「最近会话」也要用，提到这里共用。 */
export function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

/** 数字紧凑格式化：1200 → 1.2k，3_400_000 → 3.4M。 */
export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}
