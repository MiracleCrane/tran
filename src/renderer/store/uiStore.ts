import { create } from 'zustand'

/** Which top-level view the main column shows. Separate from sessionStore so
 *  session state and UI navigation don't entangle. Add settings, diffs, etc.
 *  here as the app grows. */
export type View = 'chat' | 'mcp' | 'providers' | 'skills'

interface UiStore {
  view: View
  setView: (view: View) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))
}))
