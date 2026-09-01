import { normalizeCwdForCompare } from './paths'
import type { Project } from './ipc'

/**
 * cwd → 项目归属匹配（2026-09-01 第 1.5 期「归属匹配升级」），主进程/渲染层
 * 共用一份语义，别处不得再自写前缀/精确比对。
 *
 * 归一化沿用 normalizeCwdForCompare（正反斜杠/大小写/尾斜杠），对每个项目的
 * 每个 rootPath 做「cwd === root 或 cwd 在 root 之下」的前缀匹配，**取最长
 * 匹配**——嵌套项目（root 互为前缀）时内层项目赢。
 * 全部不中返回 null（调用方按「无项目」处理）。
 */
export function matchProjectByCwd(cwd: string, projects: Project[]): Project | null {
  const target = normalizeCwdForCompare(cwd)
  if (!target) return null
  let best: Project | null = null
  let bestLen = -1
  for (const project of projects) {
    for (const root of project.rootPaths) {
      const r = normalizeCwdForCompare(root)
      if (!r) continue
      if (target === r || target.startsWith(`${r}/`)) {
        if (r.length > bestLen) {
          best = project
          bestLen = r.length
        }
      }
    }
  }
  return best
}

/** cwd 是否落在给定 rootPaths 之一（同一套归一化 + 前缀规则）。只关心
 *  「属不属于这个项目」、不需要跨项目比长短的场景用（listSessions 过滤）。 */
export function cwdWithinRootPaths(cwd: string, rootPaths: string[]): boolean {
  const target = normalizeCwdForCompare(cwd)
  if (!target) return false
  return rootPaths.some((root) => {
    const r = normalizeCwdForCompare(root)
    return !!r && (target === r || target.startsWith(`${r}/`))
  })
}
