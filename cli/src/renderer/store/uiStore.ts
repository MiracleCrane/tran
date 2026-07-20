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

export interface BlockingOverlayState {
  id: string
  label: string
}

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
  blockingOverlay: BlockingOverlayState | null
  showBlockingOverlay: (label?: string) => string
  hideBlockingOverlay: (id: string) => void
  /** 用量预览卡钉住开关（UsageRings；/usage 命令或点击圆环钉住，点别处关闭）。 */
  usageOpen: boolean
  setUsageOpen: (open: boolean) => void
}

function overlayId(): string {
  return crypto.randomUUID()
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
  closeAttachmentPreview: () => set({ attachmentPreview: null }),
  blockingOverlay: null,
  showBlockingOverlay: (label = '正在等待资源管理器响应...') => {
    const id = overlayId()
    set({ blockingOverlay: { id, label } })
    return id
  },
  hideBlockingOverlay: (id) =>
    set((s) => (s.blockingOverlay?.id === id ? { blockingOverlay: null } : {})),
  usageOpen: false,
  setUsageOpen: (open) => set({ usageOpen: open })
}))
