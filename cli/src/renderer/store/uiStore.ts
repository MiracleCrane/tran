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
  | 'settings'
  | 'wslHealth'
  | 'help'
  | 'archived'

export interface BlockingOverlayState {
  id: string
  label: string
}

interface UiStore {
  view: View
  setView: (view: View) => void
  /** 设置页 deep-link（2026-08-27）：打开设置时顺带指定分类（如运行状态条的
   *  摘要故障提示 → 'assistant'）。设置页懒加载、挂载晚于跳转，走 store 而
   *  不是事件；SettingsPanel 消费后调 clearSettingsCategory 清掉。 */
  settingsCategory: string | null
  openSettings: (category?: string) => void
  clearSettingsCategory: () => void
  /** 隐藏侧栏（Codex 风开/关两态）。Alt+Q / Ctrl+B 都绑这档；图标条模式
   *  2026-08-18 用户拍板整体砍掉。 */
  sidebarHidden: boolean
  toggleSidebarHidden: () => void
  /**
   * 展开态侧栏的宽度（px）。拖右边缘可调，持久化到 localStorage——用户手动
   * 调过的尺寸，重启后弹回默认值会显得像 bug。
   */
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  /** Footer tool nav (skills/mcp/providers/settings) collapsed. */
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
  /** 右侧停靠面板（2026-08-17 zcode 式布局）：待办 / 目标 从右缘滑出。Git 工具
   *  2026-08-18 回正文顶部常驻，不再占 dock。null = 收起。 */
  rightDock: 'plan' | 'goal' | null
  setRightDock: (dock: 'plan' | 'goal' | null) => void
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
  settingsCategory: null,
  openSettings: (category) => set({ view: 'settings', settingsCategory: category ?? null }),
  clearSettingsCategory: () => set({ settingsCategory: null }),
  // 启动一律可见（2026-08-12 用户改口：打开默认不要收起侧边栏——Codex 同款）。
  // 隐藏改为会话内动作，不再跨启动持久化：持久化的隐藏态会让"上次随手隐藏"
  // 的人每次启动都找不到会话列表。
  sidebarHidden: false,
  toggleSidebarHidden: () => set((s) => ({ sidebarHidden: !s.sidebarHidden })),
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
  // 默认收起：工具区是低频入口，常驻展开只是把五行图标怼在侧栏底部。
  // 鼠标移到底部就浮出来，够用（2026-08 用户要求）。
  navCollapsed: true,
  toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
  attachmentPreview: null,
  openAttachmentPreview: (attachment) => {
    // 图片不走右侧详情面板：直接开一个独立窗口（2026-08-14 用户要求）。
    // 文本/目录预览仍走面板。
    if (attachment.kind === 'image' && attachment.dataUrl) {
      void window.api.openImageWindow(attachment.dataUrl, attachment.name)
      return
    }
    set({ attachmentPreview: { ...attachment } })
  },
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
  setUsageOpen: (open) => set({ usageOpen: open }),
  rightDock: null,
  setRightDock: (dock) => set({ rightDock: dock })
}))
