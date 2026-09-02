import type { Project, SessionListItem } from '../../shared/ipc'
import { isScratchCwd, matchProjectByCwd } from '../../shared/projectMatch'

/** 主进程 forge:listSessions 在 scope='all' 下把 limit 钉死在 200（见
 *  main/ipc.ts），要全量只能按 offset 翻页；上限只是防死循环的保险。 */
const ALL_SESSIONS_PAGE = 200
const ALL_SESSIONS_MAX_PAGES = 500

/** 单条会话是否算「该项目名下」——口径与 Sidebar 会话归组（isProjectSession）
 *  一致：归属覆盖优先（id→路径两级解析，同 assignmentOf），覆盖为 null =
 *  显式「不在项目中工作」；垃圾覆盖回退 cwd 最长前缀匹配；scratch 目录会话
 *  豁免（主目录被注册为项目后，Documents/Tran 下的 scratch 不该挡项目删除，
 *  2026-09-01 匹配层豁免的同一规则）。 */
function sessionBelongsToProject(
  s: SessionListItem,
  project: Project,
  projects: Project[],
  projectById: Map<string, Project>,
  assignments: Record<string, string | null>,
  scratchRoots: string[]
): boolean {
  const key = `${s.runtimeBackend ?? 'windows'}:${s.sessionId}`
  const a = assignments[key]
  if (a === null) return false
  if (a !== undefined) {
    const resolved = projectById.get(a) ?? matchProjectByCwd(a, projects)
    if (resolved) return resolved.id === project.id
    // 垃圾覆盖（指向已删除项目的旧条目）：视同无覆盖，落 cwd 判定（同侧栏）。
  }
  if (!s.cwd || isScratchCwd(s.cwd, scratchRoots)) return false
  return matchProjectByCwd(s.cwd, projects)?.id === project.id
}

/** 删除项目前的占用检查（2026-09-02 用户：「项目也要能够支持我手动去删除
 *  （有会话不可以删除）」）。守卫放渲染层：主进程 removeProject 保持纯数据
 *  删除。侧栏 orderedSessions 受 scope/分页限制，这里经 IPC 翻页拉全量再判。
 *  返回 null = 拉取失败（调用方按「不确定就不删」处理并报错，宁可误挡不可
 *  误删）。 */
export async function countProjectSessions(
  project: Project,
  projects: Project[]
): Promise<number | null> {
  try {
    const [assignments, scratchRoots] = await Promise.all([
      window.api.getSessionProjectAssignments().catch(() => ({}) as Record<string, string | null>),
      window.api.getScratchRoots().catch(() => [] as string[])
    ])
    const projectById = new Map(projects.map((p) => [p.id, p]))
    let count = 0
    let offset = 0
    for (let page = 0; page < ALL_SESSIONS_MAX_PAGES; page += 1) {
      const batch = await window.api.listSessions('', {
        scope: 'all',
        limit: ALL_SESSIONS_PAGE,
        offset
      })
      for (const s of batch) {
        if (sessionBelongsToProject(s, project, projects, projectById, assignments, scratchRoots)) {
          count += 1
        }
      }
      if (batch.length < ALL_SESSIONS_PAGE) break
      offset += ALL_SESSIONS_PAGE
    }
    return count
  } catch {
    return null
  }
}
