import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore, type View } from '../store/uiStore'
import Collapse from './Collapse'
import ConfirmDialog from './ConfirmDialog'
import { AppLogo } from './AppLogo'
import ProjectSwitcher from './ProjectSwitcher'
import type { ClaudeExecutionBackend, SessionListItem, SessionPreview } from '../../shared/ipc'
import { normalizeCwdForCompare } from '../../shared/paths'
import { relTime } from '../utils/format'
import { useArchiveStore } from '../store/archiveStore'
import { onForgeEvent, emitForgeEvent } from '../events'

type SessionGroupMode = 'time' | 'project'
type SessionListTransitionPhase = 'idle' | 'exiting' | 'loading' | 'entering'
type WslNavRevealPhase = 'hidden' | 'opening' | 'visible' | 'closing'
/** section: Codex 式布局的合成段（置顶/最近）——纯文本组头、不参与 cwd 折叠。 */
type SessionGroup = { label: string; items: SessionListItem[]; section?: boolean }
type AnimatedSessionItem = { session: SessionListItem; exiting: boolean }
type AnimatedSessionGroup = { label: string; items: AnimatedSessionItem[]; section?: boolean }
type SessionListSnapshot = {
  activeSessionId: string | null
  groups: SessionGroup[]
  showRuntimeBadges: boolean
}

const PINNED_SESSIONS_KEY = 'forge.pinnedSessions.v1'

const DAY = 86_400_000
const GROUP_ORDER = ['今天', '昨天', '本周', '更早'] as const
const SESSION_LIST_WSL_EXIT_MS = 220
const SESSION_LIST_WSL_ENTER_MS = 360
const WSL_OPEN_SESSION_STAGE_MS = 320
const WSL_NAV_REVEAL_OPEN_MS = 540
const WSL_NAV_REVEAL_CLOSE_MS = 420
const SESSION_ROW_INSERT_MS = 420
const SESSION_ROW_EXIT_MS = 360
const SESSION_CACHE_IDLE_RELEASE_MS = 5_000
const SESSION_PREFETCH_RESUME_MS = 180
const SESSION_PREFETCH_FAST_SCROLL_PX_PER_MS = 1.15
const SESSION_LOAD_MORE_THRESHOLD_PX = 180
/** 悬停预览卡的摆位夹取参数（宽度与 w-64 一致，高度按内容上限估）。 */
const PREVIEW_WIDTH_PX = 256
const PREVIEW_MAX_HEIGHT_PX = 168
const PREVIEW_GAP_PX = 10
/** 悬停预览的出现延迟：350→650ms（2026-08-24 用户：扫过会话列表误出）。
 *  停住才出，扫读不触发。 */
const PREVIEW_SHOW_DELAY_MS = 650
/** 行/侧栏移出后的收卡宽限（指针跨隙上卡用，见 scheduleHidePreview）。 */
const PREVIEW_HIDE_GRACE_MS = 150

/** 悬停预览卡的数据。状态由 SessionPreviewCard 独立持有（模块级 setter 注入），
 *  不进 Sidebar 的 state——否则每次悬停/移开都整列表重渲染。 */
interface SessionPreviewData {
  key: string
  top: number
  left: number
  summary: string
  cwd?: string
  lastModified: number
  firstPrompt?: string
  /** 会话动作集中营（2026-08-20 用户：「这几个功能都加上图标，和归档放到一个
   *  地方去」）：置顶/重命名/删除/归档全部收进预览卡底部图标排。 */
  session: SessionListItem
  /** 置顶态（图钉高亮用，悬停时刻快照即可）。 */
  pinned: boolean
  /** 输出中的会话不支持归档（按钮禁用并说明）。 */
  running: boolean
}

let previewSetter: ((p: SessionPreviewData | null) => void) | null = null

function showSessionPreview(p: SessionPreviewData | null): void {
  previewSetter?.(p)
}

function SessionPreviewCard({
  onHoldOpen,
  onClose,
  onPin,
  onRename,
  onDelete,
  onArchive
}: {
  onHoldOpen: () => void
  onClose: () => void
  onPin: (session: SessionListItem) => void
  onRename: (key: string, currentSummary: string) => void
  onDelete: (key: string) => void
  onArchive: (sessionId: string) => void
}): JSX.Element | null {
  const [preview, setPreview] = useState<SessionPreviewData | null>(null)
  useEffect(() => {
    previewSetter = setPreview
    return () => {
      if (previewSetter === setPreview) previewSetter = null
    }
  }, [])
  if (!preview) return null
  // Codex 式预览卡（2026-08-17 用户给的参照图）：标题 + 时间一行，文件夹
  // 图标 + 项目名（路径末段）一行，首条消息摘要垫底。
  const projectName = preview.cwd ? preview.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null
  return createPortal(
    <div
      className="glass-panel tran-enter fixed z-[90] w-64 rounded-2xl p-3 shadow-2xl"
      style={{ top: preview.top, left: preview.left }}
      onPointerEnter={onHoldOpen}
      onPointerLeave={onClose}
    >
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">{preview.summary}</div>
        <div className="shrink-0 text-[10px] text-zinc-600">{relTime(preview.lastModified)}</div>
      </div>
      {projectName && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-zinc-400" title={preview.cwd}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-500" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{projectName}</span>
        </div>
      )}
      {preview.firstPrompt && (
        <div className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-zinc-500">
          {preview.firstPrompt}
        </div>
      )}
      {/* 会话动作集中营（2026-08-20 用户：「这几个功能都加上图标，和归档放到
          一个地方去」）：置顶/重命名/删除/归档收进预览卡底部一排图标；行内悬停
          操作组随之删除（它贴着行右缘淡入、光标就在按钮上，是误触之源）。预览卡
          要悬停停留才出现，点这里面的都是有意动作，无需二次确认。输出中的会话
          不支持归档：禁用并说明。 */}
      <div className="mt-2 flex items-center justify-end gap-0.5 border-t border-white/[0.06] pt-2">
        <button
          type="button"
          onClick={() => {
            onClose()
            onPin(preview.session)
          }}
          className={`flex h-6 w-6 items-center justify-center rounded-lg transition ${
            preview.pinned ? 'text-accent hover:bg-white/[0.06]' : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
          }`}
          title={preview.pinned ? '取消置顶' : '置顶'}
        >
          <PinIcon active={preview.pinned} />
        </button>
        <button
          type="button"
          onClick={() => {
            onClose()
            onRename(preview.key, preview.summary)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
          title="重命名"
        >
          <EditIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            onClose()
            onDelete(preview.key)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
          title="删除"
        >
          <TrashIcon />
        </button>
        <button
          type="button"
          disabled={preview.running}
          onClick={() => {
            onClose()
            onArchive(preview.session.sessionId)
          }}
          className="flex h-6 items-center gap-1 rounded-lg px-1.5 text-[11px] text-zinc-400 transition enabled:hover:bg-white/[0.06] enabled:hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
          title={preview.running ? '正在输出中的会话不支持归档' : '归档（从列表收起，归档页可找回）'}
        >
          <ArchiveIcon />
          归档
        </button>
      </div>
    </div>,
    document.body
  )
}
const BACKEND_SORT_ORDER: Record<ClaudeExecutionBackend, number> = { windows: 0, wsl: 1 }

function bucketOf(ts: number): string {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= todayStart) return '今天'
  if (ts >= todayStart - DAY) return '昨天'
  if (ts >= todayStart - 7 * DAY) return '本周'
  return '更早'
}

function sessionKey(session: SessionListItem): string {
  return `${session.runtimeBackend ?? 'windows'}:${session.sessionId}`
}

function pathName(path: string | undefined): string {
  if (!path) return 'Unknown project'
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? clean
}

function backendLabel(backend: ClaudeExecutionBackend | undefined): string {
  return backend === 'wsl' ? 'WSL' : 'Windows'
}

function readPinnedSessions(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PINNED_SESSIONS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writePinnedSessions(keys: Set<string>): void {
  window.localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify([...keys]))
}

function groupSessionsByTime(
  sessions: SessionListItem[]
): SessionGroup[] {
  const map = new Map<string, SessionListItem[]>()
  for (const s of sessions) {
    const b = bucketOf(s.lastModified)
    const arr = map.get(b)
    if (arr) arr.push(s)
    else map.set(b, [s])
  }
  return GROUP_ORDER.filter((b) => map.has(b)).map((label) => ({ label, items: map.get(label)! }))
}

function groupSessionsByProject(
  sessions: SessionListItem[],
  fallbackCwd: string
): SessionGroup[] {
  const map = new Map<string, SessionListItem[]>()
  for (const session of sessions) {
    const label = pathName(session.cwd ?? fallbackCwd)
    const arr = map.get(label)
    if (arr) arr.push(session)
    else map.set(label, [session])
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map(([label, items]) => ({ label, items }))
}

/** 「全部」视图：按完整 cwd 分组，组间按组内最新会话倒序（组内已按时间倒序）。
 *  分组键用归一化路径（正反斜杠/盘符大小写殊途同归），label 取首个原始写法——
 *  否则同一项目的会话会按路径拼写拆成两个组（2026-08-14 实测：C:\ 与 C:/ 并存）。 */
function groupSessionsByCwd(
  sessions: SessionListItem[],
  fallbackCwd: string
): SessionGroup[] {
  const map = new Map<string, { label: string; items: SessionListItem[] }>()
  for (const session of sessions) {
    const raw = session.cwd ?? fallbackCwd
    const key = normalizeCwdForCompare(raw)
    const entry = map.get(key)
    if (entry) entry.items.push(session)
    else map.set(key, { label: raw, items: [session] })
  }
  return [...map.values()]
    .sort((a, b) => (b.items[0]?.lastModified ?? 0) - (a.items[0]?.lastModified ?? 0))
    .map(({ label, items }) => ({ label, items }))
}

function toAnimatedSessionGroups(
  groups: SessionGroup[],
  exitingKeys: Set<string> = new Set()
): AnimatedSessionGroup[] {
  return groups
    .map((group) => ({
      label: group.label,
      ...(group.section ? { section: true } : {}),
      items: group.items.map((session) => ({
        session,
        exiting: exitingKeys.has(sessionKey(session))
      }))
    }))
    // 空组过滤只针对合成段（置顶/最近，本就不会有空的）——**项目组不过滤**：
    // 空项目（会话删光/还没开过会话）要保留组头（2026-08-19 用户：「项目下面
    // 的对话删除完了项目就没了」——这条 filter 把 v1.1.22 加进来的空项目组
    // 又悄悄滤掉了）。
    .filter((group) => group.items.length > 0 || !group.section)
}

/* --- icons --- */
const PlusIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)
const SearchIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)
/** 段标配色（2026-08-19 用户：置顶/项目/最近各自一种颜色 + 淡淡流光）：
 *  置顶=金（图钉感）、项目=紫、最近=青。走 seg-shimmer（慢速呼吸扫过）。 */
const SECTION_LABEL_SHIMMER: Record<string, string> = {
  置顶: 'seg-shimmer seg-shimmer-bash',
  项目: 'seg-shimmer seg-shimmer-edit',
  最近: 'seg-shimmer seg-shimmer-read'
}

const FolderIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
)
const ArchiveIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="4" width="18" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)
const EditIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
const TrashIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const PinIcon = ({ active = false }: { active?: boolean }): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'}>
    <path
      d="M9 3h6l-1 5 4 4v2h-5v7l-1 1-1-1v-7H6v-2l4-4-1-5z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
)
/** 头部/多选工具条图标（2026-08-20 侧栏图标化整理）：与 SearchIcon 同款 12px
 *  描边风格。 */
const SparkleIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
const ChecklistIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path d="m3.5 6 1.5 1.5L8 4.5M3.5 12.5 5 14l3-3M3.5 19 5 20.5l3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M11 6h9M11 12.5h9M11 19h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
)
const RefreshIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const CheckAllIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path d="m4 12.5 4 4L18 6.5M10 16.5l1 1 10-10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const XIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)
const ShieldIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7l7-4z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
const McpIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <rect x="9" y="9" width="6" height="6" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
  </svg>
)
const SkillsIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)
const GearIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
  </svg>
)

const TerminalIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M4 6h16v12H4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M7 10l3 2-3 2M12 15h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)



const HelpIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M9.7 9a2.35 2.35 0 0 1 4.55.8c0 1.65-1.25 2.25-2.05 2.85-.55.4-.75.75-.75 1.35"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M12 17h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

const LanguageIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
    <path d="M3 12h18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path
      d="M12 3c-3 3-4.5 6-4.5 9s1.5 6 4.5 9c3-3 4.5-6 4.5-9s-1.5-6-4.5-9z"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
)

/** The footer tool tabs, in display order. Drives both the icon rail
 *  (collapsed sidebar) and the collapsible nav (expanded sidebar).
 *  TODO(legacy): providers(运营商) 深度绑定旧 Claude 后端、wslHealth 与 MCP
 *  面板的增删改写的是 Claude 配置文件 —— kimi-only 阶段先从导航隐藏，后续
 *  接入 kimi 对应能力后再恢复。 */
const NAV_ITEMS: { view: View; label: string; icon: () => JSX.Element }[] = [
  { view: 'skills', label: '技能', icon: SkillsIcon },
  { view: 'translate', label: 'AI 辅助', icon: LanguageIcon },
  { view: 'archived', label: '归档', icon: ArchiveIcon },
  { view: 'settings', label: '设置', icon: GearIcon },
  { view: 'help', label: '说明', icon: HelpIcon }
]

/**
 * @param forceExpanded 强制按展开态渲染。仅供 SidebarShell 的「隐藏态悬停浮出」
 *   使用：侧栏隐藏时鼠标移上左缘触发带，要在浮层里画一份完整面板——浮层的
 *   意义就是快速触达各入口，工具区也随之永远展开（不再要求二次悬停）。
 */
export default function Sidebar({ forceExpanded = false }: { forceExpanded?: boolean } = {}): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const sessions = useSessionStore((s) => s.sessions)
  // 归档（2026-08）：侧栏过滤 + 行内归档按钮的数据源；挂载即加载一次。
  const archivedIds = useArchiveStore((s) => s.archivedIds)
  const loadArchived = useArchiveStore((s) => s.loadArchived)
  const archiveSession = useArchiveStore((s) => s.archive)
  useEffect(() => {
    void loadArchived()
  }, [loadArchived])
  // #5b 运行中会话标识：并行契约新增字段，包含当前正在跑 turn 的 sdkSessionId。
  const runningSdkSessionIds = useSessionStore((s) => s.runningSdkSessionIds)
  const loading = useSessionStore((s) => s.sessionsLoading)
  const sessionsHasMore = useSessionStore((s) => s.sessionsHasMore)
  const refresh = useSessionStore((s) => s.refreshSessions)
  const sessionScope = useSessionStore((s) => s.sessionScope)
  const setSessionScope = useSessionStore((s) => s.setSessionScope)
  const reloadForBackendSwitch = useSessionStore((s) => s.reloadForBackendSwitch)
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions)
  const newChat = useSessionStore((s) => s.newChat)
  const switchProject = useSessionStore((s) => s.switchProject)
  const openSession = useSessionStore((s) => s.openSession)
  const openSessionCrossProject = useSessionStore((s) => s.openSessionCrossProject)
  const prefetchSessionHistory = useSessionStore((s) => s.prefetchSessionHistory)
  const pruneSessionHistoryCache = useSessionStore((s) => s.pruneSessionHistoryCache)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const navCollapsed = useUiStore((s) => s.navCollapsed)
  const toggleNav = useUiStore((s) => s.toggleNav)
  /** 鼠标停在底部工具区上——临时浮出，移开即收，不写进 store。 */
  const [navHover, setNavHover] = useState(false)
  // forceExpanded（收起态侧栏的悬停浮层）永远展开工具区：浮层的意义就是快速
  // 触达这几个入口，再要求用户在浮层里二次悬停就多此一举。
  const navOpen = forceExpanded || !navCollapsed || navHover

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  /** 删除失败的显式报错（模态）。 */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Codex 式三段布局固定用 project 分组（time 分支保留给未来可能的切换）。
  const [groupMode] = useState<SessionGroupMode>('project')
  /** 「全部」视图里被折叠的 cwd 组（label = 完整路径）。 */
  const [collapsedGroupLabels, setCollapsedGroupLabels] = useState<Set<string>>(() => new Set())
  const [appVersion, setAppVersion] = useState('')
  const [aiNamingBusy, setAiNamingBusy] = useState(false)
  /** 批量命名进度（主进程逐条推送）：没进度显示就是用户眼里的"卡住"。 */
  const [aiNamingProgress, setAiNamingProgress] = useState<{ done: number; total: number } | null>(null)
  useEffect(() => window.api.onAiNamingProgress((p) => setAiNamingProgress(p)), [])
  /** 已添加项目的归一化路径集合：决定会话归「项目」段还是「最近」段。 */
  const [addedProjectPaths, setAddedProjectPaths] = useState<Set<string>>(() => new Set())
  /** 已添加项目的原始路径（listProjects 顺序）：会话被删光的项目也要保留
   *  空组头（2026-08-18 用户：「项目不能就没了吧？留着，下面不挂会话就行了」）。 */
  const [addedProjectRawPaths, setAddedProjectRawPaths] = useState<string[]>([])
  useEffect(() => {
    const load = (): void => {
      void window.api
        .listProjects()
        .then((list) => {
          setAddedProjectPaths(new Set(list.map((p) => normalizeCwdForCompare(p.path))))
          setAddedProjectRawPaths(list.map((p) => p.path))
        })
        .catch(() => {})
    }
    load()
    return onForgeEvent('projectsChanged', load)
  }, [])
  /** 主目录（归一化）：主目录不是项目——落在主目录的会话一律归「最近」
   *  （Codex 语义，2026-08-17 用户：「最近就是用来放无项目会话的」「三行字
   *  和 Codex 完全一致」），即使主目录当初被加进了项目列表。 */
  const [homePath, setHomePath] = useState('')
  useEffect(() => {
    void window.api
      .getHomeDir()
      .then((h) => setHomePath(normalizeCwdForCompare(h)))
      .catch(() => {})
  }, [])
  const previewTimerRef = useRef<number | null>(null)
  /** 行移出后的延迟收卡定时器：给指针留出跨空隙上到预览卡的时间窗
   *  （2026-08-20 用户：归档按钮在卡里，卡随行移出即消失，根本点不到）。 */
  const previewHideTimerRef = useRef<number | null>(null)
  /** 预览请求代际号（见 schedulePreview 的竞态守卫）。 */
  const previewSeqRef = useRef(0)

  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  /** 一键补全 AI 标题：当前列表里还没有 AI 标题的会话，串行生成（主进程
   *  内部间隔 ~300ms、有缓存/手动命名自动跳过；开关关闭时不发请求）。
   *  进度经 forge:aiNamingProgress 逐条推送显示在按钮上。 */
  const handleAiNaming = async (): Promise<void> => {
    if (aiNamingBusy) return
    setAiNamingBusy(true)
    setAiNamingProgress(null)
    try {
      const [aiTitles, prefs] = await Promise.all([
        window.api.getAiTitles().catch(() => ({} as Record<string, string>)),
        window.api.getPreferences().catch(() => null)
      ])
      if (prefs && prefs.aiNamingEnabled === false) return
      const ids = sessions.map((s) => s.sessionId).filter((id) => !aiTitles[id])
      if (!ids.length) return
      await window.api.generateAiTitles(ids)
      // 命名落盘不会自己刷新列表——不补这一下，用户点完看到的还是旧标题，
      // 形同"点了没用"（2026-08-19 用户：「AI命名感觉还是有问题」）。
      await refresh()
    } catch {
      // IPC 失败不能变成未捕获 rejection（本函数被 void 调用）；批量命名是
      // "有则更好"，失败静默即可，busy 复位在 finally。
    } finally {
      setAiNamingBusy(false)
      setAiNamingProgress(null)
    }
  }

  const cancelPreviewTimer = (): void => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }

  const cancelPreviewHide = (): void => {
    if (previewHideTimerRef.current !== null) {
      window.clearTimeout(previewHideTimerRef.current)
      previewHideTimerRef.current = null
    }
  }

  const schedulePreview = (key: string, s: SessionListItem, el: HTMLElement): void => {
    cancelPreviewTimer()
    // 指针从预览卡移回行：收回中的卡重新定住。
    cancelPreviewHide()
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null
      const rect = el.getBoundingClientRect()
      // 摆位要夹住两头。原先直接用 rect.right + 8：会话行是缩进的，行的右边
      // 缘在侧栏里面，于是预览卡压在侧栏自己身上（挡住项目选择器那一片）；
      // 行滚到很靠下时又会顶穿视口底部。
      // 左边界：至少推到侧栏右缘之外；右边界：不超出视口。上下同理。
      const sidebarRight = el.closest('.glass-sidebar')?.getBoundingClientRect().right ?? rect.right
      const left = Math.min(
        Math.max(rect.right + PREVIEW_GAP_PX, sidebarRight + PREVIEW_GAP_PX),
        Math.max(PREVIEW_GAP_PX, window.innerWidth - PREVIEW_WIDTH_PX - PREVIEW_GAP_PX)
      )
      const top = Math.min(
        Math.max(PREVIEW_GAP_PX, rect.top - 4),
        Math.max(PREVIEW_GAP_PX, window.innerHeight - PREVIEW_MAX_HEIGHT_PX)
      )
      // 竞态守卫：快速掠过多行时，先发的慢请求可能在新行的请求之后才返回，
      // 用旧行内容/坐标覆盖新行的预览卡。seq 记本次调度的代际，回来时不是
      // 最新一发就丢弃。
      const seq = ++previewSeqRef.current
      void window.api
        .getSessionPreview(s.sessionId)
        .catch(() => ({} as SessionPreview))
        .then((data) => {
          if (seq !== previewSeqRef.current) return
          showSessionPreview({
            key,
            top,
            left,
            summary: s.summary || '(未命名)',
            ...(s.cwd ? { cwd: s.cwd } : {}),
            lastModified: s.lastModified,
            ...(data.firstPrompt ? { firstPrompt: data.firstPrompt } : {}),
            session: s,
            pinned: pinnedSessionKeys.has(key),
            running: s.running || runningSdkSessionIds.includes(s.sessionId)
          })
        })
    }, PREVIEW_SHOW_DELAY_MS)
  }

  const hidePreview = (): void => {
    cancelPreviewTimer()
    cancelPreviewHide()
    // 作废在途请求：不然移开后才返回的 IPC 会把预览卡又弹回来。
    previewSeqRef.current++
    showSessionPreview(null)
  }

  /** 行移出不立刻收卡：留一小段给指针跨过行与卡之间的空隙上到卡上
   *  （滚动/点击/切换等显式关闭仍走 hidePreview 立即收）。
   *  2026-08-24：300→150ms（用户：移走了还赖着）。够跨 10px 空隙上卡即可，
   *  扫过列表时卡片不再一直挂在头上。 */
  const scheduleHidePreview = (): void => {
    cancelPreviewHide()
    previewHideTimerRef.current = window.setTimeout(() => {
      previewHideTimerRef.current = null
      // 另一行的预览正在排期（A→B 快速移动）：让位给新卡，别收。
      if (previewTimerRef.current !== null) return
      hidePreview()
    }, PREVIEW_HIDE_GRACE_MS)
  }

  /** 指针上到预览卡：show/hide 两个定时器都取消，卡保持常开（点归档就靠它）。 */
  const holdPreviewOpen = (): void => {
    cancelPreviewTimer()
    cancelPreviewHide()
  }
  const [pinnedSessionKeys, setPinnedSessionKeys] = useState<Set<string>>(() => readPinnedSessions())
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [wslNavRevealPhase, setWslNavRevealPhase] = useState<WslNavRevealPhase>('hidden')
  const [sessionListTransitionPhase, setSessionListTransitionPhase] =
    useState<SessionListTransitionPhase>('idle')
  const [sessionListSnapshot, setSessionListSnapshot] = useState<SessionListSnapshot | null>(null)
  const [newlyInsertedSessionKeys, setNewlyInsertedSessionKeys] = useState<Set<string>>(() => new Set())
  const [exitingSessionKeys, setExitingSessionKeys] = useState<Set<string>>(() => new Set())
  const [renderedSessionGroups, setRenderedSessionGroups] = useState<AnimatedSessionGroup[] | null>(null)
  const wslNavRevealTimeoutRef = useRef<number | null>(null)
  const wslNavRevealPhaseRef = useRef<WslNavRevealPhase>('hidden')
  const wslSupportInitializedRef = useRef(false)
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const sessionListFadeTimeoutRef = useRef<number | null>(null)
  const sessionListFadeFrameRef = useRef<number | null>(null)
  const sessionListTransitionPhaseRef = useRef<SessionListTransitionPhase>('idle')
  const sessionListTransitionIdRef = useRef(0)
  const sessionGroupsRef = useRef<SessionGroup[]>([])
  const visibleSessionKeysRef = useRef<Set<string> | null>(null)
  const previousSessionGroupsRef = useRef<SessionGroup[] | null>(null)
  const sessionInsertTimeoutRef = useRef<number | null>(null)
  const sessionExitTimeoutRef = useRef<number | null>(null)
  const visibleSessionIdsRef = useRef<Set<string>>(new Set())
  const pendingSessionPrefetchRef = useRef<Set<string>>(new Set())
  const prefetchPausedRef = useRef(false)
  const prefetchResumeTimeoutRef = useRef<number | null>(null)
  const lastSessionScrollRef = useRef({ top: 0, time: 0 })
  const sessionCacheReleaseTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (sessionListTransitionPhaseRef.current !== 'idle') return
    void refresh()
  }, [refresh, meta?.cwd])

  function clearSessionListFadeTimers(): void {
    sessionListTransitionIdRef.current += 1
    if (sessionListFadeTimeoutRef.current !== null) {
      window.clearTimeout(sessionListFadeTimeoutRef.current)
      sessionListFadeTimeoutRef.current = null
    }
    if (sessionListFadeFrameRef.current !== null) {
      window.cancelAnimationFrame(sessionListFadeFrameRef.current)
      sessionListFadeFrameRef.current = null
    }
  }

  function clearWslNavRevealTimer(): void {
    if (wslNavRevealTimeoutRef.current !== null) {
      window.clearTimeout(wslNavRevealTimeoutRef.current)
      wslNavRevealTimeoutRef.current = null
    }
  }

  function clearSessionInsertTimer(): void {
    if (sessionInsertTimeoutRef.current !== null) {
      window.clearTimeout(sessionInsertTimeoutRef.current)
      sessionInsertTimeoutRef.current = null
    }
  }

  function clearSessionExitTimer(): void {
    if (sessionExitTimeoutRef.current !== null) {
      window.clearTimeout(sessionExitTimeoutRef.current)
      sessionExitTimeoutRef.current = null
    }
  }

  function setSessionListPhase(phase: SessionListTransitionPhase): void {
    sessionListTransitionPhaseRef.current = phase
    setSessionListTransitionPhase(phase)
  }

  function setWslNavPhase(phase: WslNavRevealPhase): void {
    wslNavRevealPhaseRef.current = phase
    setWslNavRevealPhase(phase)
  }

  function finishWslNavOpening(): void {
    wslNavRevealTimeoutRef.current = null
    if (wslNavRevealPhaseRef.current === 'opening') setWslNavPhase('visible')
  }

  function finishWslNavClosing(): void {
    wslNavRevealTimeoutRef.current = null
    if (wslNavRevealPhaseRef.current === 'closing') setWslNavPhase('hidden')
  }

  function startWslNavOpening(): void {
    clearWslNavRevealTimer()
    setWslNavPhase('opening')
    wslNavRevealTimeoutRef.current = window.setTimeout(finishWslNavOpening, WSL_NAV_REVEAL_OPEN_MS)
  }

  function startWslNavClosing(): void {
    clearWslNavRevealTimer()
    if (wslNavRevealPhaseRef.current === 'hidden') return
    setWslNavPhase('closing')
    wslNavRevealTimeoutRef.current = window.setTimeout(finishWslNavClosing, WSL_NAV_REVEAL_CLOSE_MS)
  }

  function finishWslCloseEnter(transitionId: number): void {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeTimeoutRef.current = null
    setSessionListPhase('idle')
    startWslNavClosing()
  }

  function startWslCloseEnter(transitionId: number): void {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeFrameRef.current = null
    setSessionListSnapshot(null)
    setSessionListPhase('entering')
    sessionListFadeTimeoutRef.current = window.setTimeout(
      () => finishWslCloseEnter(transitionId),
      SESSION_LIST_WSL_ENTER_MS
    )
  }

  async function loadWslClosedSessions(transitionId: number): Promise<void> {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeTimeoutRef.current = null
    setSessionListPhase('loading')
    setWslSupportEnabled(false)
    try {
      await reloadForBackendSwitch()
      await refresh()
    } finally {
      if (transitionId !== sessionListTransitionIdRef.current) return
      sessionListFadeFrameRef.current = window.requestAnimationFrame(() => {
        sessionListFadeFrameRef.current = window.requestAnimationFrame(() => {
          startWslCloseEnter(transitionId)
        })
      })
    }
  }

  function finishSessionReloadEnter(transitionId: number): void {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeTimeoutRef.current = null
    setSessionListPhase('idle')
  }

  function startSessionReloadEnter(transitionId: number): void {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeFrameRef.current = null
    setSessionListSnapshot(null)
    setSessionListPhase('entering')
    sessionListFadeTimeoutRef.current = window.setTimeout(
      () => finishSessionReloadEnter(transitionId),
      SESSION_LIST_WSL_ENTER_MS
    )
  }

  async function loadSessionReload(transitionId: number): Promise<void> {
    if (transitionId !== sessionListTransitionIdRef.current) return
    sessionListFadeTimeoutRef.current = null
    setSessionListPhase('loading')
    try {
      await refresh()
    } finally {
      if (transitionId !== sessionListTransitionIdRef.current) return
      sessionListFadeFrameRef.current = window.requestAnimationFrame(() => {
        sessionListFadeFrameRef.current = window.requestAnimationFrame(() => {
          startSessionReloadEnter(transitionId)
        })
      })
    }
  }

  function startSessionRefreshTransition(): void {
    if (sessionListTransitionPhaseRef.current !== 'idle') return
    clearSessionListFadeTimers()
    clearSessionInsertTimer()
    clearSessionExitTimer()
    setNewlyInsertedSessionKeys(new Set())
    setExitingSessionKeys(new Set())
    setRenderedSessionGroups(null)
    const transitionId = sessionListTransitionIdRef.current
    setSessionListSnapshot({
      activeSessionId: meta?.sdkSessionId ?? null,
      groups: sessionGroupsRef.current,
      showRuntimeBadges: wslSupportEnabled
    })
    setSessionListPhase('exiting')
    sessionListFadeTimeoutRef.current = window.setTimeout(
      () => void loadSessionReload(transitionId),
      SESSION_LIST_WSL_EXIT_MS
    )
  }

  function startWslCloseTransition(): void {
    clearSessionListFadeTimers()
    clearSessionInsertTimer()
    clearSessionExitTimer()
    setNewlyInsertedSessionKeys(new Set())
    setExitingSessionKeys(new Set())
    setRenderedSessionGroups(null)
    const transitionId = sessionListTransitionIdRef.current
    setSessionListSnapshot({
      activeSessionId: meta?.sdkSessionId ?? null,
      groups: sessionGroupsRef.current,
      showRuntimeBadges: wslSupportEnabled
    })
    setSessionListPhase('exiting')
    sessionListFadeTimeoutRef.current = window.setTimeout(
      () => void loadWslClosedSessions(transitionId),
      SESSION_LIST_WSL_EXIT_MS
    )
  }

  function startWslOpenTransition(): void {
    clearSessionListFadeTimers()
    clearWslNavRevealTimer()
    clearSessionInsertTimer()
    clearSessionExitTimer()
    setNewlyInsertedSessionKeys(new Set())
    setExitingSessionKeys(new Set())
    setRenderedSessionGroups(null)
    setWslNavPhase('hidden')
    const transitionId = sessionListTransitionIdRef.current
    setSessionListSnapshot(null)
    setSessionListPhase('idle')
    void refresh()
    sessionListFadeTimeoutRef.current = window.setTimeout(() => {
      sessionListFadeTimeoutRef.current = null
      if (transitionId !== sessionListTransitionIdRef.current) return
      startWslNavOpening()
    }, WSL_OPEN_SESSION_STAGE_MS)
  }

  useEffect(() => {
    const refreshWslSupport = (): void => {
      void window.api.getPreferences().then(() => {
        // TODO(wsl): WSL 支持已随旧后端移除，固定按关闭处理（忽略旧版设置里
        // 可能残留的 wslSupportEnabled=true），WSL 导航保持隐藏。
        const enabled = false
        if (!wslSupportInitializedRef.current) {
          wslSupportInitializedRef.current = true
          setWslSupportEnabled(enabled)
          setWslNavPhase(enabled ? 'visible' : 'hidden')
          return
        }
        setWslSupportEnabled((previous) => {
          if (previous === enabled) {
            if (
              enabled &&
              sessionListTransitionPhaseRef.current === 'idle' &&
              wslNavRevealPhaseRef.current === 'hidden'
            ) setWslNavPhase('visible')
            return previous
          }
          if (previous && !enabled) {
            startWslCloseTransition()
            return enabled
          }
          if (!previous && enabled) {
            startWslOpenTransition()
          }
          return enabled
        })
      })
    }
    refreshWslSupport()
    return onForgeEvent('wslSupportChanged', refreshWslSupport)
  }, [refresh, reloadForBackendSwitch])

  const clearSessionCacheReleaseTimer = (): void => {
    if (sessionCacheReleaseTimeoutRef.current !== null) {
      window.clearTimeout(sessionCacheReleaseTimeoutRef.current)
      sessionCacheReleaseTimeoutRef.current = null
    }
  }

  const releaseInvisibleSessionCache = (): void => {
    sessionCacheReleaseTimeoutRef.current = null
    pruneSessionHistoryCache([...visibleSessionIdsRef.current])
  }

  const scheduleSessionCacheRelease = (): void => {
    clearSessionCacheReleaseTimer()
    sessionCacheReleaseTimeoutRef.current = window.setTimeout(
      releaseInvisibleSessionCache,
      SESSION_CACHE_IDLE_RELEASE_MS
    )
  }

  const clearPrefetchResumeTimer = (): void => {
    if (prefetchResumeTimeoutRef.current !== null) {
      window.clearTimeout(prefetchResumeTimeoutRef.current)
      prefetchResumeTimeoutRef.current = null
    }
  }

  const warmSessionWhenAllowed = (
    sessionId: string,
    backend?: ClaudeExecutionBackend
  ): void => {
    visibleSessionIdsRef.current.add(sessionId)
    if (prefetchPausedRef.current) {
      pendingSessionPrefetchRef.current.add(sessionId)
      return
    }
    void prefetchSessionHistory(sessionId, backend)
  }

  const flushPendingSessionPrefetch = (): void => {
    prefetchPausedRef.current = false
    const ids = new Set(visibleSessionIdsRef.current)
    pendingSessionPrefetchRef.current.clear()
    for (const sessionId of ids) {
      void prefetchSessionHistory(sessionId)
    }
  }

  const pauseSessionPrefetch = (): void => {
    prefetchPausedRef.current = true
    clearPrefetchResumeTimer()
    prefetchResumeTimeoutRef.current = window.setTimeout(() => {
      prefetchResumeTimeoutRef.current = null
      flushPendingSessionPrefetch()
    }, SESSION_PREFETCH_RESUME_MS)
  }

  const maybeLoadMoreSessions = (): void => {
    const root = sessionListRef.current
    if (!root || loading || !sessionsHasMore) return
    const distanceToBottom = root.scrollHeight - root.scrollTop - root.clientHeight
    if (distanceToBottom <= SESSION_LOAD_MORE_THRESHOLD_PX) {
      void loadMoreSessions()
    }
  }

  const handleSessionListScroll = (): void => {
    const root = sessionListRef.current
    if (!root) return
    hidePreview()

    scheduleSessionCacheRelease()
    maybeLoadMoreSessions()

    const now = window.performance.now()
    const previous = lastSessionScrollRef.current
    const elapsed = Math.max(now - previous.time, 1)
    const speed = Math.abs(root.scrollTop - previous.top) / elapsed
    lastSessionScrollRef.current = { top: root.scrollTop, time: now }

    if (speed >= SESSION_PREFETCH_FAST_SCROLL_PX_PER_MS) {
      pauseSessionPrefetch()
    } else if (prefetchPausedRef.current) {
      clearPrefetchResumeTimer()
      prefetchResumeTimeoutRef.current = window.setTimeout(() => {
        prefetchResumeTimeoutRef.current = null
        flushPendingSessionPrefetch()
      }, SESSION_PREFETCH_RESUME_MS)
    }
  }

  useEffect(() => {
    return () => {
      clearWslNavRevealTimer()
      clearSessionListFadeTimers()
      clearSessionInsertTimer()
      clearSessionExitTimer()
      clearSessionCacheReleaseTimer()
      clearPrefetchResumeTimer()
      cancelPreviewTimer()
      document.documentElement.classList.remove('sidebar-motion')
    }
  }, [])

  // 兜底：当前会话一变就收预览。上面 handleOpenSession 里已经收了一次，但
  // 会话也可能从别处切换（跨项目打开、恢复后台会话），那些路径不经过这里。
  useEffect(() => {
    hidePreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.sdkSessionId])

  const togglePinnedSession = (session: SessionListItem): void => {
    const key = sessionKey(session)
    setPinnedSessionKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      writePinnedSessions(next)
      return next
    })
  }

  const toggleGroupCollapsed = (label: string): void => {
    setCollapsedGroupLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  /** 项目组头上的「+」：在该项目下直接开新对话。当前项目走懒创建的 newChat；
      其他项目只能 switchProject——会话进程绑定 cwd，换目录必须在那边另起。 */
  const newChatInProject = (cwd: string): void => {
    hidePreview()
    if (meta && normalizeCwdForCompare(cwd) === normalizeCwdForCompare(meta.cwd)) {
      void newChat()
    } else {
      void switchProject(cwd)
    }
    setView('chat')
  }

  /** 「全部」视图点其他项目的会话：先切项目再 resume；本项目内直接打开。 */
  const handleOpenSession = (s: SessionListItem): void => {
    // 点下去就收预览。原先只挂在行的 onPointerLeave 上——切会话会重建列表
    // 行（列表过渡 / 快照切换），旧元素直接消失，pointerleave 根本不触发，
    // 预览卡就永远挂在那儿了。
    hidePreview()
    if (
      sessionScope === 'all' &&
      s.cwd &&
      meta &&
      normalizeCwdForCompare(s.cwd) !== normalizeCwdForCompare(meta.cwd)
    ) {
      // 第 4 个参数是这条会话所属的 agent 后端：侧栏现在 kimi 与 Claude Code
      // 的历史混排，不带上它就会拿当前会话的后端去 resume 另一家的会话。
      void openSessionCrossProject(s.sessionId, s.cwd, s.runtimeBackend, s.agentBackend)
    } else {
      void openSession(s.sessionId, s.runtimeBackend, undefined, s.agentBackend)
    }
    setView('chat')
  }

  const commitEdit = (): void => {
    if (editingId && editText.trim()) {
      const target = sessions.find((session) => sessionKey(session) === editingId)
      if (target) void renameSession(target.sessionId, editText, target.runtimeBackend)
    }
    setEditingId(null)
  }
  const doDelete = async (key: string): Promise<void> => {
    setConfirmDeleteId(null)
    const target = sessions.find((session) => sessionKey(session) === key)
    if (!target) return
    // 失败必须当面报出来（2026-08-14 用户：「不要删了没反应静默失败」）。
    const error = await deleteSession(target.sessionId, target.runtimeBackend)
    if (error) setDeleteError(error)
  }
  const confirmDeleteTarget = confirmDeleteId
    ? sessions.find((session) => sessionKey(session) === confirmDeleteId)
    : undefined

  // ---- 多选模式（批量删除）----
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const [multiMode, setMultiMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [confirmBatch, setConfirmBatch] = useState(false)

  const exitMultiMode = (): void => {
    setMultiMode(false)
    setSelectedKeys(new Set())
    setConfirmBatch(false)
  }
  const toggleSelected = (key: string): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  // 全选 = 当前过滤结果（搜索/分组照常生效）。
  const selectAllFiltered = (): void => {
    setSelectedKeys(new Set(filteredSessions.map(sessionKey)))
  }
  const doBatchDelete = async (): Promise<void> => {
    setConfirmBatch(false)
    const targets = sessions
      .filter((s) => selectedKeys.has(sessionKey(s)))
      .map((s) => ({ sessionId: s.sessionId, backend: s.runtimeBackend }))
    if (!targets.length) return
    setBatchDeleting(true)
    try {
      const { failed, deleted } = await deleteSessions(targets)
      if (failed > 0) setDeleteError(`批量删除完成：成功 ${deleted} 个，失败 ${failed} 个（失败的仍在列表里）`)
    } finally {
      setBatchDeleting(false)
      exitMultiMode()
    }
  }

  // Esc 退出多选；切换项目/视图时退出。
  useEffect(() => {
    if (!multiMode) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') exitMultiMode()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiMode])

  useEffect(() => {
    setMultiMode(false)
    setSelectedKeys(new Set())
  }, [meta?.cwd, view])

  const filteredSessions = useMemo(() => {
    // 关键词搜索已挪进 SessionSearchPalette（Ctrl+K / 搜索图标），列表本身
    // 不再做行内过滤，只保留 WSL 后端可见性这一层。
    // 2026-08：归档的会话也从这里过滤（归档页才能看到）。
    return sessions
      .filter((session) => {
        if (!wslSupportEnabled && (session.runtimeBackend ?? 'windows') === 'wsl') return false
        if (archivedIds && session.sessionId in archivedIds) return false
        return true
      })
      .slice()
      .sort((a, b) => {
        const ap = pinnedSessionKeys.has(sessionKey(a))
        const bp = pinnedSessionKeys.has(sessionKey(b))
        if (ap !== bp) return ap ? -1 : 1
        const timeDelta = b.lastModified - a.lastModified
        if (timeDelta !== 0) return timeDelta
        return (
          BACKEND_SORT_ORDER[a.runtimeBackend ?? 'windows'] -
          BACKEND_SORT_ORDER[b.runtimeBackend ?? 'windows']
        )
      })
  }, [pinnedSessionKeys, sessions, wslSupportEnabled, archivedIds])

  // 显示顺序在本次挂载期间保持稳定。
  // 上面那个排序按 lastModified 倒序——而**打开一个会话就会刷新它的 mtime**，
  // 于是每切一次会话，被点的那条就窜到列表最上面，其余整体下移：用户刚点的
  // 位置在他手底下变了，想回上一条得重新找。列表的价值是"位置可记忆"，
  // 不是"永远按最新排"。
  // 规则：置顶项永远在前（那是显式操作，就该动）；见过的会话保持上一次的
  // 相对次序；这一轮新出现的排最前（新建的会话确实该在顶上），彼此按时间。
  // 只在本次挂载内有效——重启后回到纯时间序。
  const displayOrderRef = useRef<string[]>([])
  const orderedSessions = useMemo(() => {
    const rank = new Map(displayOrderRef.current.map((key, index) => [key, index]))
    const next = filteredSessions.slice().sort((a, b) => {
      const ka = sessionKey(a)
      const kb = sessionKey(b)
      const ap = pinnedSessionKeys.has(ka)
      const bp = pinnedSessionKeys.has(kb)
      if (ap !== bp) return ap ? -1 : 1
      const ra = rank.get(ka) ?? -1
      const rb = rank.get(kb) ?? -1
      if (ra !== rb) return ra - rb
      return b.lastModified - a.lastModified
    })
    displayOrderRef.current = next.map(sessionKey)
    return next
  }, [filteredSessions, pinnedSessionKeys])

  // 三段布局（2026-08-14 用户改定稿）：置顶 → 项目（cwd 折叠组）→ 最近。
  // 项目优先：cwd 属于已添加项目的会话只出现在项目分组里，不再占「最近」；
  // 「最近」只收无项目会话（cwd 不在项目列表，含「不在项目中工作」的主目录
  // 会话），按时间倒序全量列出——它们没有别的归属，截断就再也找不到了。
  // 三段互斥（同一会话只出现一次——渲染/多选/动画都按 sessionKey 索引，
  // 重复会撞 key）。
  const sessionGroups = useMemo(() => {
    if (groupMode === 'time') return groupSessionsByTime(orderedSessions)
    const pinned = orderedSessions.filter((s) => pinnedSessionKeys.has(sessionKey(s)))
    const rest = orderedSessions.filter((s) => !pinnedSessionKeys.has(sessionKey(s)))
    // 主目录不算项目：cwd 为主目录的会话归「最近」，与 Codex 三段完全一致。
    const isProjectSession = (s: SessionListItem): boolean =>
      !!s.cwd &&
      addedProjectPaths.has(normalizeCwdForCompare(s.cwd)) &&
      (!homePath || normalizeCwdForCompare(s.cwd) !== homePath)
    const inProject = rest.filter(isProjectSession)
    const recent = rest
      .filter((s) => !isProjectSession(s))
      .sort((a, b) => b.lastModified - a.lastModified)
    const cwdGroups =
      sessionScope === 'all'
        ? groupSessionsByCwd(inProject, meta?.cwd ?? '')
        : groupSessionsByProject(inProject, meta?.cwd ?? '')
    // 空项目保留组头：会话被删光/还没开过会话的项目不消失（2026-08-18 用户
    // 拍板）。追加在有会话的组后面，保持 listProjects 顺序；主目录不算项目。
    const nonEmptyLabels = new Set(cwdGroups.map((g) => normalizeCwdForCompare(g.label)))
    const emptyProjectGroups =
      sessionScope === 'all'
        ? addedProjectRawPaths
            .filter((p) => {
              const n = normalizeCwdForCompare(p)
              return !nonEmptyLabels.has(n) && (!homePath || n !== homePath)
            })
            .map((p) => ({ label: p, items: [] as SessionListItem[], section: false }))
        : []
    return [
      ...(pinned.length ? [{ label: '置顶', items: pinned, section: true }] : []),
      ...cwdGroups,
      ...emptyProjectGroups,
      ...(recent.length ? [{ label: '最近', items: recent, section: true }] : [])
    ]
  }, [orderedSessions, groupMode, meta?.cwd, sessionScope, pinnedSessionKeys, addedProjectPaths, addedProjectRawPaths, homePath])
  sessionGroupsRef.current = sessionGroups

  const visibleSessionKeys = useMemo(
    () => sessionGroups.flatMap((group) => group.items.map(sessionKey)),
    [sessionGroups]
  )
  const visibleSessionKeysSignature = visibleSessionKeys.join('\n')

  useLayoutEffect(() => {
    if (sessionListTransitionPhase !== 'idle') {
      clearSessionInsertTimer()
      clearSessionExitTimer()
      setNewlyInsertedSessionKeys(new Set())
      setExitingSessionKeys(new Set())
      setRenderedSessionGroups(null)
      visibleSessionKeysRef.current = new Set(visibleSessionKeys)
      previousSessionGroupsRef.current = sessionGroups
      return
    }

    const previous = visibleSessionKeysRef.current
    const previousGroups = previousSessionGroupsRef.current
    if (!previous || !previousGroups) {
      visibleSessionKeysRef.current = new Set(visibleSessionKeys)
      previousSessionGroupsRef.current = sessionGroups
      setRenderedSessionGroups(null)
      return
    }

    const inserted = visibleSessionKeys.filter((key) => !previous.has(key))
    const visible = new Set(visibleSessionKeys)
    const removed = [...previous].filter((key) => !visible.has(key))
    visibleSessionKeysRef.current = new Set(visibleSessionKeys)
    previousSessionGroupsRef.current = sessionGroups

    clearSessionInsertTimer()
    clearSessionExitTimer()
    if (removed.length > 0) {
      const removedSet = new Set(removed)
      setNewlyInsertedSessionKeys(new Set())
      setExitingSessionKeys(removedSet)
      setRenderedSessionGroups(toAnimatedSessionGroups(previousGroups, removedSet))
      sessionExitTimeoutRef.current = window.setTimeout(() => {
        sessionExitTimeoutRef.current = null
        setExitingSessionKeys(new Set())
        setRenderedSessionGroups(null)
      }, SESSION_ROW_EXIT_MS)
      return
    }

    setExitingSessionKeys(new Set())
    setRenderedSessionGroups(null)
    if (inserted.length === 0) {
      setNewlyInsertedSessionKeys(new Set())
      return
    }

    setNewlyInsertedSessionKeys(new Set(inserted))
    sessionInsertTimeoutRef.current = window.setTimeout(() => {
      sessionInsertTimeoutRef.current = null
      setNewlyInsertedSessionKeys(new Set())
    }, SESSION_ROW_INSERT_MS)
  }, [sessionListTransitionPhase, sessionGroups, visibleSessionKeysSignature])

  useEffect(() => {
    visibleSessionIdsRef.current.clear()
    pendingSessionPrefetchRef.current.clear()
    prefetchPausedRef.current = false
    clearSessionCacheReleaseTimer()
    clearPrefetchResumeTimer()

    if (!meta) return

    const root = sessionListRef.current
    if (!root) return
    lastSessionScrollRef.current = { top: root.scrollTop, time: window.performance.now() }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const sessionId = (entry.target as HTMLElement).dataset.sessionId
          const backend = (entry.target as HTMLElement).dataset.sessionBackend as
            | ClaudeExecutionBackend
            | undefined
          if (!sessionId) continue
          if (entry.isIntersecting) warmSessionWhenAllowed(sessionId, backend)
          else visibleSessionIdsRef.current.delete(sessionId)
        }
      },
      { root, rootMargin: '96px 0px', threshold: 0.01 }
    )

    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-session-id]'))
    for (const row of rows) observer.observe(row)

    const frame = window.requestAnimationFrame(() => {
      const rootRect = root.getBoundingClientRect()
      const top = rootRect.top - 96
      const bottom = rootRect.bottom + 96
      for (const row of rows) {
        const sessionId = row.dataset.sessionId
        const backend = row.dataset.sessionBackend as ClaudeExecutionBackend | undefined
        if (!sessionId) continue
        const rect = row.getBoundingClientRect()
        if (rect.bottom >= top && rect.top <= bottom) warmSessionWhenAllowed(sessionId, backend)
      }
      maybeLoadMoreSessions()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      clearSessionCacheReleaseTimer()
      clearPrefetchResumeTimer()
    }
  }, [meta?.cwd, sessionGroups, prefetchSessionHistory])

  // TODO(providers): 运营商面板绑定旧 Claude 后端，kimi-only 阶段固定隐藏。
  const showProviderNav = false

  // 注意：该 effect 必须放在所有条件 return 之前，否则 hooks 顺序会随 meta 变化而漂移（React #310）。
  useEffect(() => {
    if (!showProviderNav && view === 'providers') setView('settings')
  }, [setView, showProviderNav, view])

  if (!meta) return <></>

  const wslNavRevealClass =
    wslNavRevealPhase === 'opening'
      ? 'is-enabled is-opening'
      : wslNavRevealPhase === 'visible'
        ? 'is-enabled'
        : wslNavRevealPhase === 'closing'
          ? 'is-closing'
          : ''
  const wslNavInteractive =
    wslSupportEnabled && (wslNavRevealPhase === 'opening' || wslNavRevealPhase === 'visible')

  const groups = renderedSessionGroups ?? toAnimatedSessionGroups(sessionGroups, exitingSessionKeys)
  const hasAnimatedSessionRows = renderedSessionGroups !== null
  const showSnapshotList =
    sessionListSnapshot !== null &&
    (sessionListTransitionPhase === 'exiting' || sessionListTransitionPhase === 'loading')
  const hideLiveSessionList = showSnapshotList
  const liveSessionListClass = sessionListTransitionPhase === 'entering' ? 'is-growing' : ''
  const snapshotListClass =
    sessionListTransitionPhase === 'exiting'
      ? 'is-exiting'
      : ''
  // 无框：选中态只用底色区分，不描边。glass-active 会画一圈 1px 亮边——
  // 玻璃主题下线之后，那圈边在实色侧栏里就是个孤立的方框。
  const navCls = (on: boolean): string =>
    `sidebar-tool-tab flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs ${
      on ? 'is-active bg-white/[0.07] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
    }`

  const handleSidebarPointerGlow = (event: PointerEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--tab-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--tab-y', `${event.clientY - rect.top}px`)
  }

  const renderSessionSnapshot = (snapshot: SessionListSnapshot): JSX.Element[] =>
    snapshot.groups.map((g) => (
      <div key={g.label} className="mb-2">
        {/* 组头/缩进与实时列表保持一致，否则过渡快照一换就整体位移。
            项目组的 label 是完整路径——快照原先直接渲原文，刷新过渡期间
            组头会闪出整条路径（2026-08-18 用户抓包）；与实时列表一样只
            显示末段名。 */}
        <div className="px-2 py-1 text-[13px] font-semibold text-zinc-400">
          {g.section ? (
            <span className={SECTION_LABEL_SHIMMER[g.label] ?? ''}>{g.label}</span>
          ) : (
            (g.label.split(/[\\/]/).pop() ?? g.label)
          )}
        </div>
        <div className={g.section ? '' : 'ml-[31px]'}>
        {g.items.map((s) => {
          const active = s.sessionId === snapshot.activeSessionId && view === 'chat'
          return (
            <div
              key={sessionKey(s)}
              className="group relative [content-visibility:auto] [contain-intrinsic-size:auto_34px]"
            >
              <div
                className={`sidebar-session-row relative w-full rounded-md border px-2 py-[5px] text-left ${
                  active ? 'is-active border-transparent bg-[#313131] text-zinc-100' : 'border-transparent text-[#c3c3c3]'
                }`}
              >
                {/* 单行标题（2026-08 用户定稿）：一行尽量放长，时间不再占第二行，
                    收进 hover 提示（title）。 */}
                <div className="flex items-center gap-1.5 text-sm" title={relTime(s.lastModified)}>
                  <span className="min-w-0 flex-1 truncate">{s.summary || '(未命名)'}</span>
                  <span className={`session-runtime-badge ${snapshot.showRuntimeBadges ? 'is-visible' : ''}`}>
                    {backendLabel(s.runtimeBackend)}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
        </div>
      </div>
    ))

  return (
    <div key="sidebar-expanded" onPointerLeave={scheduleHidePreview} className="sidebar-expand glass-sidebar flex h-full min-h-0 w-64 shrink-0 flex-col rounded-[18px] border">
      {/* brand + 隐藏切换（全窗口唯一品牌位，标题栏不再重复；文字挂常静流光，
          2026-08 用户点名要的动效）。头部只留一颗「隐藏侧边栏」（Alt+Q 唤回，
          左缘悬停也能浮出）——图标条模式 2026-08-18 用户拍板整体砍掉。 */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <AppLogo size={30} className="shrink-0" />
        <div className="flex-1 text-sm font-semibold">
          <span className="flow-text flow-text-violet">Tran</span>
        </div>
        <button
          onClick={() => useUiStore.getState().toggleSidebarHidden()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
          title="隐藏侧边栏（Alt+Q 唤回）"
        >
          {/* 侧栏面板图标（VS Code 式：框 + 左侧栏位）——替代原来的 ⟨| 箭头
              （2026-08-18 用户：「两个箭头太丑了」）。 */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
            <path d="M9.5 4.5v15" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        </button>
      </div>

      {/* project switcher + new chat + provider */}
      {/* 顶部这一坨整体压扁：项目选择 + 新建对话 + 「最近会话」标题 + 视图切换
          + 搜索 + 分组切换，六段东西各占一行，会话列表被推到半屏以下。
          这里收紧间距、按钮矮一档，并把「按时间/按项目」并进标题行——省掉
          一整行只放一个小按钮的浪费。 */}
      <div className="sidebar-deferred-content is-ready relative z-[70] space-y-2 px-4 pb-2 pt-2">
        <ProjectSwitcher collapsed={false} />
        <button
          onClick={() => {
            void newChat()
            setView('chat')
          }}
          className="glass-control flex h-9 w-full items-center justify-center gap-2 rounded-full px-3 text-[13px] font-medium text-zinc-300 transition hover:bg-white/[0.09]"
        >
          + 新建对话
        </button>
      </div>

      {/* 头部行：非多选 = 搜索 / AI 命名 / 多选 / 刷新一排图标（2026-08-20 侧栏
          图标化整理：全部 h-5 图标按钮 + tooltip，不再文字/图标混排）；多选 =
          操作条并进这一行（所有项 shrink-0 + nowrap，窄侧栏也不许竖排断字）。 */}
      <div className="flex items-center px-4 py-0.5">
        {multiMode ? (
          <div className="flex w-full items-center gap-1 text-[11px] text-zinc-400">
            <span className="shrink-0 whitespace-nowrap tabular-nums text-zinc-300">已选 {selectedKeys.size} 项</span>
            <button
              onClick={selectAllFiltered}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="全选（当前过滤结果）"
            >
              <CheckAllIcon />
            </button>
            <button
              onClick={() => setSelectedKeys(new Set())}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="清空选择"
            >
              <XIcon />
            </button>
            <button
              onClick={() => setConfirmBatch(true)}
              disabled={selectedKeys.size === 0 || batchDeleting}
              className="flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-red-400 transition hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-50"
              title="删除所选会话"
            >
              <TrashIcon />
              {batchDeleting ? '删除中…' : '删除'}
            </button>
            <button
              onClick={exitMultiMode}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="退出多选（Esc）"
            >
              <XIcon />
            </button>
          </div>
        ) : (
          <span className="ml-auto flex items-center gap-1">
            <button
              onClick={() => emitForgeEvent('openSessionSearch')}
              className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="搜索会话（Ctrl+K）"
            >
              <SearchIcon />
            </button>
            <button
              onClick={() => void handleAiNaming()}
              disabled={aiNamingBusy}
              className="flex h-5 items-center justify-center rounded-md px-1 text-[11px] text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-50"
              title="AI 命名：为列表里还没有 AI 标题的会话逐个生成短标题（串行、有缓存跳过）"
            >
              {aiNamingBusy
                ? aiNamingProgress
                  ? `命名中 ${aiNamingProgress.done}/${aiNamingProgress.total}`
                  : '命名中…'
                : <SparkleIcon />}
            </button>
            <button
              onClick={() => {
                // 进多选强制收预览卡：多选态悬停不出新卡（schedulePreview 有
                // multiMode 守卫），已开的也别留着（指针物理停在卡上时
                // onHoldOpen 会让它一直活着，2026-08-20 实证）。
                if (!multiMode) hidePreview()
                if (multiMode) exitMultiMode()
                else setMultiMode(true)
              }}
              className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="多选管理（批量删除）"
            >
              <ChecklistIcon />
            </button>
            <button
              onClick={startSessionRefreshTransition}
              className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200"
              title="刷新"
            >
              <RefreshIcon />
            </button>
          </span>
        )}
      </div>

      {/* 多选操作条已并进上方头部行（2026-08-19：原先独立一行，换行挤压） */}

      <div className="min-h-0 flex flex-1 flex-col">
        {/* grouped sessions */}
        {/* 「当前项目/全部」切换已删（2026-08-12 用户定稿：一律全部会话，
            Codex 同款）；搜索在 Ctrl+K 命令面板。 */}

        {/* grouped sessions */}
        <div className="relative min-h-0 flex-1">
          {showSnapshotList && sessionListSnapshot ? (
            <div className={`session-list-transition-list h-full overflow-y-auto px-3 pb-3 ${snapshotListClass}`}>
              {renderSessionSnapshot(sessionListSnapshot)}
            </div>
          ) : (
            <div
              ref={sessionListRef}
              onScroll={handleSessionListScroll}
              className={`sidebar-deferred-content is-ready session-live-list min-h-0 h-full overflow-y-auto px-3 pb-3 ${liveSessionListClass}`}
            >
        {!hideLiveSessionList && !hasAnimatedSessionRows && loading && sessions.length === 0 && (
          /* 会话列表加载骨架：灰紫条带 opacity 脉动（1.2s）。 */
          <div className="space-y-2 px-2 py-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-white/[0.05] bg-white/[0.04] px-2.5 py-2"
                style={{ animationDelay: `${i * 150}ms` }}
              >
                <div className="h-3 w-3/4 rounded bg-white/[0.07]" />
                <div className="mt-1.5 h-2 w-1/3 rounded bg-white/[0.05]" />
              </div>
            ))}
          </div>
        )}
        {!hideLiveSessionList && !hasAnimatedSessionRows && !loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">还没有对话。</div>
        )}
        {!hideLiveSessionList && !hasAnimatedSessionRows && !loading && sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">没有匹配的会话。</div>
        )}
        {groups.map((g, groupIndex) => {
          // cwd 折叠组头只在「全部 + 按项目」下启用；合成段（置顶/最近）与
          // 其余情况用纯文本组头。
          const cwdGroupHeader = !g.section && sessionScope === 'all' && groupMode === 'project'
          const groupCollapsed = cwdGroupHeader && collapsedGroupLabels.has(g.label)
          // Codex 式段标题：第一个项目组前面立一块「项目」分隔（2026-08-18
          // 用户：「项目置顶最近这几个字得有啊」——原先还要求置顶/最近段存在
          // 才显示，全是项目的列表就一个段标都没有）。
          const firstCwdIndex = groups.findIndex((x) => !x.section)
          const showProjectDivider = cwdGroupHeader && groupIndex === firstCwdIndex
          return (
          <div
            key={g.label}
            className="session-list-grow-group mb-2"
            style={{ '--session-grow-delay': `${Math.min(groupIndex * 28, 120)}ms` } as CSSProperties}
          >
            {showProjectDivider && (
              <div className="mb-0.5 mt-1 px-2 text-[13px] font-semibold text-zinc-400">
                <span className={SECTION_LABEL_SHIMMER['项目']}>项目</span>
              </div>
            )}
            {/* 组头（项目 / 时间段）。Codex 式（2026-08-18 像素对比）：项目名与会话
                行同一字重同色（普通 #c3c3c3，不再半粗白字"喊"），靠文件夹图标 +
                子行缩进区分层级；右侧计数删掉（Codex 右缘干净）。行尾悬停出「+」。
                外层用 div 不用 button：「+」是独立按钮，HTML 不允许按钮套按钮。 */}
            {cwdGroupHeader ? (
              <div className="group/projhead flex w-full items-center gap-1 px-2 py-1">
                <button
                  type="button"
                  onClick={() => toggleGroupCollapsed(g.label)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-normal text-[#c3c3c3] transition hover:text-zinc-100"
                  title={g.label}
                >
                  <span className="text-[8px] text-zinc-500">{groupCollapsed ? '▸' : '▾'}</span>
                  <span className="shrink-0 text-zinc-400"><FolderIcon /></span>
                  {/* 当前项目：不要「当前」徽章（2026-08-17 用户：「字太大了，搞个
                      流光文字就行」）——项目名本身上紫黄流光。 */}
                  {(() => {
                    const isCurrent =
                      meta && normalizeCwdForCompare(g.label) === normalizeCwdForCompare(meta.cwd)
                    return (
                      <span className={`truncate ${isCurrent ? 'seg-shimmer seg-shimmer-project' : ''}`}>
                        {g.label.split(/[\\/]/).pop()}
                      </span>
                    )
                  })()}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    newChatInProject(g.label)
                  }}
                  className="shrink-0 rounded p-0.5 text-zinc-500 opacity-0 transition hover:bg-white/10 hover:text-zinc-200 group-hover/projhead:opacity-100"
                  title="在此项目下新建对话"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-1 text-[13px] font-semibold text-zinc-400">
                <span className={`truncate ${SECTION_LABEL_SHIMMER[g.label] ?? ''}`}>{g.label}</span>
              </div>
            )}
            {!groupCollapsed && (
            // Codex 对齐（2026-08-18 像素实测）：项目下的会话行文字与项目名
            // 左边对齐——实测项目名文字 x=52、会话行自带 px-2，容器再让 31px
            // 时两边重合。图标/间距改了这里要跟着改。
            <div className={g.section ? '' : 'ml-[31px]'}>
            {g.items.map((item, rowIndex) => {
              const s = item.session
              const key = sessionKey(s)
              const active = s.sessionId === meta.sdkSessionId && view === 'chat'
              const editing = editingId === key
              const inserting = newlyInsertedSessionKeys.has(key)
              const exiting = item.exiting
              return (
                <div
                  key={key}
                  data-session-id={s.sessionId}
                  data-session-backend={s.runtimeBackend ?? 'windows'}
                  className={`session-row-shell group relative [content-visibility:auto] [contain-intrinsic-size:auto_34px] ${
                    inserting ? 'is-inserting' : ''
                  } ${exiting ? 'is-exiting' : ''
                  }`}
                  style={{
                    '--session-row-delay': `${Math.min(groupIndex * 38 + rowIndex * 18, 180)}ms`
                  } as CSSProperties}
                >
                  {editing ? (
                    <input
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        // 输入法组词中的 Enter 是确认候选，不能当成提交重命名
                        //（否则会用没上屏的半截拼音命名会话）。
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (e.key === 'Enter') commitEdit()
                        else if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={commitEdit}
                      className="w-full rounded-xl border border-accent/70 bg-bg-elev/80 px-2.5 py-2 text-xs text-zinc-100 outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        if (exiting) return
                        // 多选模式：点击行任意处 = 切换选中（不打开会话）。
                        if (multiMode) {
                          toggleSelected(key)
                          return
                        }
                        handleOpenSession(s)
                      }}
                      onPointerEnter={(e) => {
                        handleSidebarPointerGlow(e)
                        if (!multiMode) schedulePreview(key, s, e.currentTarget)
                      }}
                      onPointerMove={handleSidebarPointerGlow}
                      onPointerLeave={scheduleHidePreview}
                      className={`sidebar-session-row relative w-full rounded-md border px-2 py-[5px] text-left ${
                        // 标题全程占满行宽：行内悬停操作组已随预览卡动作集中营
                        // 删除（2026-08-20），无任何右缘遮挡。
                        multiMode ? '' : 'pr-2'
                      } ${
                        active
                          // 选中态照抄 Codex（2026-08-17 用户：「完全照抄 codex」）：
                          // 淡灰底圆角小行，不要紫色指示条、不要框。
                          ? 'is-active border-transparent bg-[#313131] text-zinc-100'
                          : multiMode && selectedKeys.has(key)
                            ? 'border-accent/40 bg-accent/[0.08] text-zinc-200'
                            : 'border-transparent text-[#c3c3c3]'
                      }`}
                      disabled={exiting}
                    >
                      <span className="flex items-start">
                        {multiMode && (
                          <span
                            className={`mr-2 mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                              selectedKeys.has(key)
                                ? 'border-accent bg-accent/70 text-white'
                                : 'border-white/25 text-transparent'
                            }`}
                          >
                            ✓
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          {/* 单行标题：时间收进 hover 提示，不再占第二行（2026-08
                              用户定稿）。运行中=标题多色流光（2026-08-19 用户：
                              「不要紫色的点了，运行中会话的流光花哨点」）。 */}
                          <div className="flex items-center gap-1.5 text-sm" title={relTime(s.lastModified)}>
                            <span
                              className={`min-w-0 flex-1 truncate ${
                                s.running || runningSdkSessionIds.includes(s.sessionId)
                                  ? 'seg-shimmer seg-shimmer-running'
                                  : ''
                              }`}
                            >
                              {s.summary || '(未命名)'}
                            </span>
                            <span className={`session-runtime-badge transition-opacity ${wslSupportEnabled ? 'is-visible' : ''}`}>
                              {backendLabel(s.runtimeBackend)}
                            </span>
                          </div>
                        </span>
                      </span>
                    </button>
                  )}

                  {/* 行内悬停操作组已删（2026-08-20 用户拍板：置顶/重命名/删除
                      和归档一起收进悬停预览卡底部图标排——行右缘淡入的按钮组是
                      归档误触之源）。标题因此全程占满行宽。 */}
                </div>
              )
            })}
            </div>
            )}
          </div>
          )
        })}
        {!hideLiveSessionList && sessions.length > 0 && (sessionsHasMore || loading) && (
          <div className="px-2 py-3 text-center text-[11px] text-zinc-600">
            继续下滑加载更多
          </div>
        )}
            </div>
          )}
        </div>
      </div>

      {/* footer nav — 融进侧栏的工具区：无卡片外框、默认收起、鼠标移到底部
          就浮出来。原先那圈 glass-panel-soft 在实色主题下是块突兀的浮起矩形，
          而里面装的只是五个低频入口，不值一个视觉层级（2026-08 用户要求）。
          点标题仍可「钉住」展开，移开鼠标也不收。 */}
      <div
        className="sidebar-deferred-content is-ready px-3 pb-4 pt-2"
        onMouseEnter={() => setNavHover(true)}
        onMouseLeave={() => setNavHover(false)}
      >
        <div>
          <button
            onClick={toggleNav}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-zinc-600 transition hover:text-zinc-400"
            title={navCollapsed ? '展开工具栏（点击钉住）' : '收起工具栏'}
          >
            <span className="flex-1">工具</span>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              className={`shrink-0 transition-transform duration-300 ease-spring ${navOpen ? '' : '-rotate-90'}`}
            >
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* grid-rows 0fr↔1fr animates height without guessing a max-height;
              the inner overflow-hidden clips the rows mid-tween. The spring
              curve + per-item stagger give the non-linear pop.
              peek 浮出（forceExpanded）时强制展开工具区：peek 的意义就是快速
              触达这四个入口，用户在展开态收起过「工具」不该让浮出态也收起
              （2026-08 用户反馈）。navHidden 同样要豁免 forceExpanded——否则
              Collapse 开了、条目还是 opacity 0，就是一个空盒子（v1.0.65 实测 bug）。 */}
          <Collapse open={navOpen}>
            <div className="mt-1">
              {NAV_ITEMS.map((item, i) => {
                const on = view === item.view
                const isWslItem = item.view === 'wslHealth'
                const isProviderItem = item.view === 'providers'
                const navHidden = !navOpen
                const button = (
                  <button
                    key={item.view}
                    onClick={() => {
                      if (isProviderItem && !showProviderNav) return
                      if (!isWslItem || wslNavInteractive) setView(on ? 'chat' : item.view)
                    }}
                    onPointerEnter={handleSidebarPointerGlow}
                    onPointerMove={handleSidebarPointerGlow}
                    className={`${navCls(on)} ${!isWslItem && i > 0 ? 'mt-1' : ''}`}
                    style={{
                      '--sidebar-tab-stagger': navHidden ? '0ms' : `${i * 55}ms`,
                      opacity: navHidden ? 0 : 1,
                      transform: navHidden ? 'translateY(-6px)' : 'translateY(0)'
                    } as CSSProperties}
                    disabled={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav)}
                    tabIndex={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav) ? -1 : 0}
                    aria-hidden={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav)}
                  >
                    {/* 图标统一 18px 列宽居中（ArchiveIcon 13px、其余 16px 原来
                        裸排，各行文字左边跟着图标宽度跑——2026-08-18 用户：
                        「字都不一样齐」）。 */}
                    <span className="flex w-[18px] shrink-0 items-center justify-center">
                      <item.icon />
                    </span>
                    {item.label}
                  </button>
                )
                if (isWslItem) {
                  return (
                    <div
                      key={item.view}
                      className={`wsl-stack-reveal wsl-nav-reveal w-full ${wslNavRevealClass}`}
                    >
                      {button}
                    </div>
                  )
                }
                if (isProviderItem) {
                  return (
                    <div
                      key={item.view}
                      className={`provider-stack-reveal provider-nav-reveal w-full ${showProviderNav ? 'is-enabled' : ''}`}
                    >
                      {button}
                    </div>
                  )
                }
                return (
                  button
                )
              })}
            </div>
          </Collapse>
        </div>
        {appVersion && (
          <div className="mt-2 text-center text-[10px] text-zinc-600">Tran v{appVersion}</div>
        )}
      </div>

      {/* 永久删除确认（红色调； ConfirmDialog 复用） */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        danger
        title="永久删除会话"
        message={`「${confirmDeleteTarget?.summary || '(未命名)'}」将被永久删除，不可恢复。`}
        confirmLabel="永久删除"
        onConfirm={() => {
          if (confirmDeleteId) doDelete(confirmDeleteId)
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />

      {/* 删除失败显式报错（原先只塞进输入框上方的小字，等于静默失败） */}
      <ConfirmDialog
        open={deleteError !== null}
        title="删除失败"
        message={deleteError ?? ''}
        confirmLabel="知道了"
        onConfirm={() => setDeleteError(null)}
        onCancel={() => setDeleteError(null)}
      />

      {/* 多选批量删除确认 */}
      <ConfirmDialog
        open={confirmBatch}
        danger
        title="批量删除会话"
        message={`将永久删除 ${selectedKeys.size} 个会话，不可恢复。`}
        confirmLabel="永久删除"
        onConfirm={() => void doBatchDelete()}
        onCancel={() => setConfirmBatch(false)}
      />

      {/* 会话条目悬停预览（零 token：标题 / 首条消息 / 更新时间 / 目录）。
          状态在 SessionPreviewCard 自己手里：悬停 setState 不再重渲染整个
          侧栏列表（几百行会话行全量重来是悬停卡顿的来源）。 */}
      <SessionPreviewCard
        onHoldOpen={holdPreviewOpen}
        onClose={hidePreview}
        onPin={togglePinnedSession}
        onRename={(key, currentSummary) => {
          setEditingId(key)
          setEditText(currentSummary === '(未命名)' ? '' : currentSummary)
        }}
        onDelete={setConfirmDeleteId}
        onArchive={(sessionId) => void archiveSession(sessionId)}
      />
    </div>
  )
}
