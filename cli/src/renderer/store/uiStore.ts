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
  /**
   * 侧栏「完全隐藏」——与 sidebarCollapsed 是**两套独立机制**：
   * - collapsed：收成 w-14 图标条，还占位，手动点箭头切换
   * - autoHidden：宽度归零、彻底不见，靠拖拽侧栏右边缘往左拉触发，
   *   之后鼠标移到窗口左边缘才浮层滑出
   * 默认关闭；不主动拖就永远是原来的样子。持久化到 localStorage——它是用户
   * 明确拖出来的状态，重启后弹回去会显得像 bug。
   */
  sidebarAutoHidden: boolean
  setSidebarAutoHidden: (hidden: boolean) => void
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

const AUTO_HIDE_KEY = 'tran.sidebarAutoHidden'

function readAutoHidden(): boolean {
  try {
    return localStorage.getItem(AUTO_HIDE_KEY) === '1'
  } catch {
    return false
  }
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  sidebarAutoHidden: readAutoHidden(),
  setSidebarAutoHidden: (hidden) => {
    try {
      localStorage.setItem(AUTO_HIDE_KEY, hidden ? '1' : '0')
    } catch {
      /* 隐私模式/存储满：不持久化也要让本次生效 */
    }
    set({ sidebarAutoHidden: hidden })
  },
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
