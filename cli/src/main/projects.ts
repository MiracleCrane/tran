import { basename } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { log } from './logger'
import type { Project } from '../shared/ipc'

/**
 * Saved working directories ("projects") for the sidebar switcher. Each is just
 * a path + display name; the session list is scoped by cwd at the renderer.
 */

function sortedList(s: { projects?: Project[] }): Project[] {
  return (s.projects ?? []).slice().sort((a, b) => a.addedAt - b.addedAt)
}

function display(name: string | undefined, path: string): string {
  return name?.trim() || basename(path) || path
}

export function listProjects(): Project[] {
  return sortedList(loadSettings())
}

export function addProject(path: string, name?: string): Project[] {
  const s = loadSettings()
  const list = s.projects ? [...s.projects] : []
  if (!list.some((p) => p.path === path)) {
    list.push({ path, name: display(name, path), addedAt: Date.now() })
    s.projects = list
  }
  s.lastProjectPath = path
  saveSettings(s)
  log('projects', `added "${path}"`)
  return sortedList(s)
}

export function removeProject(path: string): Project[] {
  const s = loadSettings()
  s.projects = (s.projects ?? []).filter((p) => p.path !== path)
  if (s.lastProjectPath === path) s.lastProjectPath = s.projects[0]?.path
  saveSettings(s)
  return sortedList(s)
}

export function renameProject(path: string, name: string): Project[] {
  const s = loadSettings()
  const list = s.projects ?? []
  const p = list.find((x) => x.path === path)
  if (p) p.name = display(name, path)
  s.projects = list
  saveSettings(s)
  return sortedList(s)
}

export function setLastProject(path: string): void {
  const s = loadSettings()
  s.lastProjectPath = path
  saveSettings(s)
}

export function getStartupProject(): Project | null {
  const list = listProjects()
  if (!list.length) return null
  const last = loadSettings().lastProjectPath
  if (last) {
    const found = list.find((p) => p.path === last)
    if (found) return found
  }
  return list[0]
}
