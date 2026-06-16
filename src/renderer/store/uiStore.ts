import { create } from 'zustand'
import type { UserAttachment } from '../types'

/** Which top-level view the main column shows. Separate from sessionStore so
 *  session state and UI navigation don't entangle. Add settings, diffs, etc.
 *  here as the app grows. */
export type View =
  | 'chat'
  | 'mcp'
  | 'providers'
  | 'skills'
  | 'translate'
  | 'settings'
  | 'wslHealth'
  | 'help'

interface UiStore {
  view: View
  setView: (view: View) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  /** Footer tool nav (skills/mcp/providers/translate/settings) collapsed. */
  navCollapsed: boolean
  toggleNav: () => void
  attachmentPreview: UserAttachment | null
  openAttachmentPreview: (attachment: UserAttachment) => void
  closeAttachmentPreview: () => void
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  navCollapsed: false,
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
  attachmentPreview: null,
  openAttachmentPreview: (attachment) => set({ attachmentPreview: { ...attachment } }),
  closeAttachmentPreview: () => set({ attachmentPreview: null })
}))
