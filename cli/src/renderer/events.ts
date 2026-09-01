export const FORGE_RENDERER_EVENTS = {
  agentBackendChanged: 'forge:agent-backend-changed',
  closePrefsChanged: 'forge:close-prefs-changed',
  modelOptionsChanged: 'forge:model-options-changed',
  providerChanged: 'forge:provider-changed',
  commandAliasesChanged: 'forge:command-aliases-changed',
  wslSupportChanged: 'forge:wsl-support-changed',
  /** 项目列表增删改（ProjectSwitcher → Sidebar 分组口径刷新）。 */
  projectsChanged: 'forge:projects-changed',
  /** worktree 台账增删（2026-09-01 第 4 期：侧栏 wt 徽章/删除联动刷新）。 */
  worktreesChanged: 'forge:worktrees-changed',
  /** 打开会话搜索面板（侧栏搜索图标 / Ctrl+K → SessionSearchPalette）。 */
  openSessionSearch: 'forge:open-session-search',
  /** 打开改动面板（轮次改动卡的「审核」→ GitToolbar 的 ChangesPanel）。 */
  openChangesPanel: 'forge:open-changes-panel'
} as const

export type ForgeRendererEventKey = keyof typeof FORGE_RENDERER_EVENTS

export interface OpenChangesPanelDetail {
  path?: string
}

export function emitForgeEvent(key: ForgeRendererEventKey): void {
  window.dispatchEvent(new Event(FORGE_RENDERER_EVENTS[key]))
}

export function onForgeEvent(key: ForgeRendererEventKey, listener: () => void): () => void {
  const eventName = FORGE_RENDERER_EVENTS[key]
  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}

export function openChangesPanel(path?: string): void {
  window.dispatchEvent(new CustomEvent<OpenChangesPanelDetail>(FORGE_RENDERER_EVENTS.openChangesPanel, {
    detail: path ? { path } : {}
  }))
}

export function onOpenChangesPanel(listener: (detail: OpenChangesPanelDetail) => void): () => void {
  const eventName = FORGE_RENDERER_EVENTS.openChangesPanel
  const handler = (event: Event): void => {
    listener((event as CustomEvent<OpenChangesPanelDetail>).detail ?? {})
  }
  window.addEventListener(eventName, handler)
  return () => window.removeEventListener(eventName, handler)
}
