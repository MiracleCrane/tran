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
   * 展开态侧栏的宽度（px）。拖右边缘可调，持久化到 localStorage——用户手动
   * 调过的尺寸，重启后弹回默认值会显得像 bug。收起态是固定的图标条宽度，
   * 不受这个值影响。
   */
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
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

const SIDEBAR_WIDTH_KEY = 'tran.sidebarWidth'
/** 默认 256px = 原先写死的 Tailwind w-64，改成可调后保持同一个初值。 */
export const SIDEBAR_WIDTH_DEFAULT = 256
export const SIDEBAR_WIDTH_MIN = 180
export const SIDEBAR_WIDTH_MAX = 480

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    // 存过的值也要过一遍 clamp：改过 MIN/MAX 之后，旧值可能已经越界。
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_WIDTH_DEFAULT
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'chat',
  setView: (view) => set({ view }),
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  sidebarWidth: readSidebarWidth(),
  setSidebarWidth: (width) => {
    const next = clampSidebarWidth(width)
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
    } catch {
      /* 隐私模式/存储满：不持久化也要让本次生效 */
    }
    set({ sidebarWidth: next })
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
