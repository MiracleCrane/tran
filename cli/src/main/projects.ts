import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { log } from './logger'
import { normalizeCwdForCompare } from '../shared/paths'
import type { Project, ProjectPatch } from '../shared/ipc'

/**
 * 项目（2026-09-01 一等实体化，Codex 模型）：{id, name, rootPaths[]} + 外观/
 * 置顶/排序元数据。id 是唯一键（crypto.randomUUID），路径只是 rootPaths 里的
 * 归属判定依据；会话列表仍由渲染层按 cwd 归属分组。
 */

function sortedList(s: { projects?: Project[] }): Project[] {
  // order（显式排序）优先，没有的按 createdAt——reorderProjects 一次会给全员补上
  // order，之后新增项目不带 order、靠最大的 createdAt 自然排在末尾。
  return (s.projects ?? []).slice().sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt))
}

function display(name: string | undefined, path: string): string {
  return name?.trim() || basename(path) || path
}

export function listProjects(): Project[] {
  return sortedList(loadSettings())
}

// #42 项目路径比较一律走归一化形式：session/list 返回正斜杠 cwd，用户显式
// 添加的多是反斜杠形式，裸 === 去重会把同一目录当成两个项目条目进列表。
function sameProjectPath(a: string, b: string): boolean {
  return normalizeCwdForCompare(a) === normalizeCwdForCompare(b)
}

function findByPath(list: Project[], path: string): Project | undefined {
  return list.find((p) => p.rootPaths.some((r) => sameProjectPath(r, path)))
}

/** 按目录反查项目（sessionProjects 旧覆盖值惰性迁移用）。 */
export function findProjectByPath(path: string): Project | undefined {
  return findByPath(loadSettings().projects ?? [], path)
}

export function addProject(path: string, name?: string): Project[] {
  const s = loadSettings()
  const list = s.projects ? [...s.projects] : []
  let project = findByPath(list, path)
  if (!project) {
    const now = Date.now()
    project = {
      id: randomUUID(),
      name: display(name, path),
      rootPaths: [path],
      createdAt: now,
      updatedAt: now
    }
    list.push(project)
    s.projects = list
  }
  s.lastProjectId = project.id
  saveSettings(s)
  log('projects', `added "${path}"`)
  return sortedList(s)
}

export function removeProject(id: string): Project[] {
  const s = loadSettings()
  s.projects = (s.projects ?? []).filter((p) => p.id !== id)
  if (s.lastProjectId === id) s.lastProjectId = sortedList(s)[0]?.id
  saveSettings(s)
  return sortedList(s)
}

export function renameProject(id: string, name: string): Project[] {
  const s = loadSettings()
  const list = s.projects ?? []
  const p = list.find((x) => x.id === id)
  if (p) {
    p.name = display(name, p.rootPaths[0] ?? '')
    p.updatedAt = Date.now()
  }
  s.projects = list
  saveSettings(s)
  return sortedList(s)
}

/** 部分更新项目元数据（改名/外观/置顶）。appearance 的 color/icon 传空串 =
 *  清除该字段（undefined 过不了 IPC 结构化克隆，到不了这里）。id 不存在时
 *  原样返回列表。 */
export function updateProject(id: string, patch: ProjectPatch): Project[] {
  const s = loadSettings()
  const list = s.projects ?? []
  const p = list.find((x) => x.id === id)
  if (p) {
    if (patch.name !== undefined) p.name = display(patch.name, p.rootPaths[0] ?? '')
    if (patch.appearance !== undefined) {
      const next: { color?: string; icon?: string } = { ...p.appearance }
      if (patch.appearance.color !== undefined) {
        if (patch.appearance.color) next.color = patch.appearance.color
        else delete next.color
      }
      if (patch.appearance.icon !== undefined) {
        if (patch.appearance.icon) next.icon = patch.appearance.icon
        else delete next.icon
      }
      p.appearance = next
    }
    if (patch.pinned !== undefined) p.pinned = patch.pinned
    p.updatedAt = Date.now()
    s.projects = list
    saveSettings(s)
  }
  return sortedList(s)
}

/** 显式排序：ids 按给定顺序拿 0..n-1 的 order；未列出的项目按当前顺序追加
 *  在后——保证全员同一把尺子（order 与 createdAt 混排会错序）。 */
export function reorderProjects(ids: string[]): Project[] {
  const s = loadSettings()
  const current = sortedList(s)
  const listed = new Set(ids)
  const ordered = [
    ...ids
      .map((id) => current.find((p) => p.id === id))
      .filter((p): p is Project => !!p),
    ...current.filter((p) => !listed.has(p.id))
  ]
  ordered.forEach((p, index) => {
    p.order = index
  })
  s.projects = ordered
  saveSettings(s)
  return sortedList(s)
}

export function setLastProject(id: string): void {
  const s = loadSettings()
  // id 必须指向真实项目：cwd 不属于任何项目时调用方不该记「上次项目」
  //（2026-09-01：openSessionCrossProject 打开脏目录会话不再挪动 lastProjectId）。
  if (!(s.projects ?? []).some((p) => p.id === id)) return
  s.lastProjectId = id
  saveSettings(s)
}

export function getStartupProject(): Project | null {
  const list = listProjects()
  if (!list.length) return null
  const last = loadSettings().lastProjectId
  if (last) {
    const found = list.find((p) => p.id === last)
    if (found) return found
  }
  return list[0]
}
