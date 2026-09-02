import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { GitBranchInfo, GitCommit, GitStatus } from '../../shared/ipc'
import DiffView from './DiffView'
import Collapse from './Collapse'
import ConfirmDialog from './ConfirmDialog'
import ChangesPanel from './ChangesPanel'
import { onOpenChangesPanel } from '../events'
import { normalizeCwdForCompare } from '../../shared/paths'
import HoverTip from './HoverTip'

/* --- icons --- */
const BranchIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M6 3v6a3 3 0 0 0 6 0V8.5A2.5 2.5 0 0 0 9.5 6H6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="M6 3h6v4a3 3 0 0 1-3 3H6V3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
    <circle cx="18" cy="5" r="2" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M18 7v4a3 3 0 0 1-3 3h-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
)
const PullIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 3v14M5 13l7 7 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const PushIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 21V7M5 11l7-7 7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const FetchIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M4 12a8 8 0 0 1 14-5M20 4v4h-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M20 12a8 8 0 0 1-14 5M4 20v-4h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const CommitIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6"/>
    <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const StashIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M4 7h16v2H4zM4 11h16v2H4zM4 15h16v2H4z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
)
const DiffIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M9 5v14M5 9h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    <path d="M11 17h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.4" opacity="0.5"/>
  </svg>
)
const LogIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M8 6h10M8 12h10M8 18h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    <circle cx="5" cy="6" r="1.2" fill="currentColor"/>
    <circle cx="5" cy="12" r="1.2" fill="currentColor"/>
    <circle cx="5" cy="18" r="1.2" fill="currentColor"/>
  </svg>
)
const RevertIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M3 7l4 4H6a8 8 0 1 0-2.5-5.3L3 7z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const PlusIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)
const MinusIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)
const TrashIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)
const CloseIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
)

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  return `${d}天前`
}

type Drawer = 'branches' | 'commit' | 'log' | 'stash' | 'output' | 'changes' | null
type OpenDrawer = Exclude<Drawer, null>
type FileKind = 'staged' | 'unstaged' | 'untracked' | 'conflict'
const DRAWER_CLOSE_CLEAR_MS = 220
const GIT_LOG_LIMIT = 30
export const CLOSE_GIT_DRAWER_EVENT = 'forge:close-git-drawer'

export function requestCloseGitDrawer(): void {
  window.dispatchEvent(new Event(CLOSE_GIT_DRAWER_EVENT))
}

function emptyGitStatus(): GitStatus {
  return {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    clean: true,
    ahead: null,
    behind: null
  }
}

interface GitLogCacheEntry {
  commits: GitCommit[]
  loadedAt: number
}

interface GitToolbarCacheEntry {
  branch: string | null
  status: GitStatus
  branches: GitBranchInfo[]
  checked: boolean
  loadedAt: number
}

const gitLogCache = new Map<string, GitLogCacheEntry>()
const gitToolbarCache = new Map<string, GitToolbarCacheEntry>()

function cloneGitStatus(status: GitStatus): GitStatus {
  return {
    ...status,
    staged: [...status.staged],
    unstaged: [...status.unstaged],
    untracked: [...status.untracked],
    conflicts: [...status.conflicts]
  }
}

function cloneGitBranches(branches: GitBranchInfo[]): GitBranchInfo[] {
  return branches.map((branch) => ({ ...branch }))
}

function getCachedGitToolbar(cwd: string): GitToolbarCacheEntry | null {
  const cached = gitToolbarCache.get(cwd)
  if (!cached) return null
  return {
    branch: cached.branch,
    status: cloneGitStatus(cached.status),
    branches: cloneGitBranches(cached.branches),
    checked: cached.checked,
    loadedAt: cached.loadedAt
  }
}

function setCachedGitToolbar(
  cwd: string,
  branch: string | null,
  status: GitStatus,
  branches: GitBranchInfo[],
  checked = true
): void {
  gitToolbarCache.set(cwd, {
    branch,
    status: cloneGitStatus(status),
    branches: cloneGitBranches(branches),
    checked,
    loadedAt: Date.now()
  })
}

function gitLogCacheKey(cwd: string, branch: string, limit: number): string {
  return `${cwd}\n${branch}\n${limit}`
}

function getCachedGitLog(cwd: string, branch: string | null, limit: number): GitCommit[] | null {
  if (!branch) return null
  return gitLogCache.get(gitLogCacheKey(cwd, branch, limit))?.commits ?? null
}

function setCachedGitLog(cwd: string, branch: string | null, limit: number, commits: GitCommit[]): void {
  if (!branch) return
  gitLogCache.set(gitLogCacheKey(cwd, branch, limit), { commits, loadedAt: Date.now() })
}

function invalidateGitLogCache(cwd: string): void {
  for (const key of gitLogCache.keys()) {
    if (key.startsWith(`${cwd}\n`)) gitLogCache.delete(key)
  }
}

const KIND_STYLE: Record<FileKind, { dot: string; text: string; label: string }> = {
  staged: { dot: 'bg-yellow-500', text: 'text-amber-200', label: '已暂存' },
  unstaged: { dot: 'bg-blue-500', text: 'text-sky-200', label: '已改动' },
  untracked: { dot: 'bg-green-500', text: 'text-emerald-200', label: '未跟踪' },
  conflict: { dot: 'bg-red-500', text: 'text-red-200', label: '冲突' }
}

interface GitToolbarProps {
  cornerAction?: JSX.Element
  /** 右侧停靠面板形态：按钮行换行、去掉底部分隔线与右侧留白（2026-08-17）。 */
}

/** A single file row inside the commit drawer: status dot + name (click → diff)
 *  + a stage/unstage action. */
function FileRow({
  path,
  kind,
  selected,
  loading,
  onSelect,
  actionIcon,
  actionTitle,
  onAction
}: {
  path: string
  kind: FileKind
  selected: boolean
  loading: boolean
  onSelect: () => void
  actionIcon?: JSX.Element
  actionTitle?: string
  onAction?: () => void
}): JSX.Element {
  const st = KIND_STYLE[kind]
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition ${
        selected ? 'bg-accent/10' : 'hover:bg-white/[0.05]'
      }`}
    >
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.dot}`} />
        <span className={`truncate font-mono ${st.text}`}>{path}</span>
      </button>
      {onAction && (
        <button
          onClick={onAction}
          disabled={loading}
          aria-label={actionTitle}
          className="shrink-0 rounded p-0.5 text-zinc-600 opacity-60 transition hover:opacity-100 hover:text-zinc-200 disabled:opacity-30"
        >
          {/* 2026-08-25：原生 title= 太丑，统一换 HoverTip 气泡 */}
          <HoverTip tip={actionTitle ?? ''}>{actionIcon}</HoverTip>
        </button>
      )}
    </div>
  )
}

function DrawerLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2 text-[11px] text-zinc-500">
      <span className="git-loading-dot" />
      <span className="git-loading-dot [animation-delay:90ms]" />
      <span className="git-loading-dot [animation-delay:180ms]" />
      <span>{label}</span>
    </div>
  )
}

export default function GitToolbar({ cornerAction }: GitToolbarProps = {}): JSX.Element {
  // '' when there's no active project; every git call is guarded by
  // `if (!cwd)` / `if (!branch)` so the empty string never reaches git.
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  // 2026-09-02「改动目标仓库」：会话改动文件多数派所在的 git 仓库根——可能
  // 与 cwd 不同库，也可能 cwd 根本不是仓库。diff/改动面板的数据源跟它走；
  // 分支/pull/push/commit 等项目级操作仍跟 cwd（cwd 是仓库时）。
  const changesGitRoot = useSessionStore((s) => s.changesGitRoot)
  // 2026-09-02 分组改动面板：会话改动按仓库根分组，透传给 ChangesPanel
  // 分组渲染（多仓库改动全部可见，不再只显示多数派仓库）。
  const changesGitGroups = useSessionStore((s) => s.changesGitGroups)
  // 惰性初始化：getCachedGitToolbar 每次调用都深克隆 status 四个数组 +
  // branches，而结果只用作 useState 初始值（仅首渲染有效）——放组件体里
  // 等于每次渲染白克隆一遍。
  const [initialGitToolbar] = useState(() => (cwd ? getCachedGitToolbar(cwd) : null))
  const [branch, setBranch] = useState<string | null>(initialGitToolbar?.branch ?? null)
  const [gitChecked, setGitChecked] = useState(initialGitToolbar?.checked ?? false)
  const [status, setStatus] = useState<GitStatus>(initialGitToolbar?.status ?? emptyGitStatus())
  const [branches, setBranches] = useState<GitBranchInfo[]>(initialGitToolbar?.branches ?? [])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [stashList, setStashList] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 工具条全局状态（分支名/状态计数/分支列表）与所有项目级操作的目标仓库：
  // cwd 是仓库时 = cwd；cwd 非仓库但改动多数派仓库存在时 = changesGitRoot；
  // '' = 哪边都不是仓库（保持旧的「非 git 目录」极简形态）。
  const [globalCwd, setGlobalCwd] = useState<string>(initialGitToolbar?.branch ? cwd : '')

  const [drawer, setDrawer] = useState<Drawer>(null)
  const changesRequestSeqRef = useRef(0)
  const [changesTarget, setChangesTarget] = useState<{ path: string; requestKey: number } | null>(null)
  const [renderedDrawer, setRenderedDrawer] = useState<OpenDrawer | null>(null)
  const renderedDrawerRef = useRef<OpenDrawer | null>(null)
  const drawerOpenRef = useRef(false)
  const drawerShellRef = useRef<HTMLDivElement | null>(null)
  const drawerContentRef = useRef<HTMLDivElement | null>(null)
  const drawerHeightRafRef = useRef<number | null>(null)
  const drawerLoadSeqRef = useRef<Partial<Record<OpenDrawer, number>>>({})
  const mountedRef = useRef(true)
  // refresh 的取消守卫：序号 + 最新 cwd 快照（见 refresh 内注释）。
  const refreshSeqRef = useRef(0)
  const diffSeqRef = useRef(0)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  // effect 用的「上一次 cwd」：区分 cwd 真变化与 changesGitRoot 触发的重跑。
  const prevEffectCwdRef = useRef<string | null>(null)
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null)
  const [drawerLoading, setDrawerLoading] = useState<Partial<Record<OpenDrawer, boolean>>>({})
  const [commitMsg, setCommitMsg] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [pushUpstream, setPushUpstream] = useState(false)

  // Operation output (push/pull/fetch stdout+stderr) shown in the output drawer.
  const [output, setOutput] = useState<{ cmd: string; text: string } | null>(null)

  // Diff viewer state (lives inside the commit drawer).
  const [diffView, setDiffView] = useState<{
    paths: string[]
    staged: boolean
    text: string
    note?: string
    loading: boolean
  } | null>(null)

  // Pending confirmation dialog.
  const [confirm, setConfirm] = useState<{
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  const cancelDrawerHeightFrame = (): void => {
    if (drawerHeightRafRef.current !== null) {
      window.cancelAnimationFrame(drawerHeightRafRef.current)
      drawerHeightRafRef.current = null
    }
  }

  const lockDrawerVisibleHeight = (): void => {
    const shell = drawerShellRef.current
    if (!shell) return
    setDrawerHeight(Math.ceil(shell.offsetHeight || shell.getBoundingClientRect().height))
  }

  const measureDrawerTargetHeight = (): number | null => {
    const shell = drawerShellRef.current
    const content = drawerContentRef.current
    if (!shell || !content) return null

    const contentHeight = Math.ceil(content.scrollHeight || content.offsetHeight || content.getBoundingClientRect().height)
    const shellStyle = window.getComputedStyle(shell)
    const borderHeight =
      Number.parseFloat(shellStyle.borderTopWidth) + Number.parseFloat(shellStyle.borderBottomWidth)
    const measuredHeight = contentHeight + Math.ceil(borderHeight)
    const maxHeight = Number.parseFloat(shellStyle.maxHeight)
    return Number.isFinite(maxHeight) ? Math.min(measuredHeight, maxHeight) : measuredHeight
  }

  const animateDrawerHeightToContent = (): void => {
    const shell = drawerShellRef.current
    const targetHeight = measureDrawerTargetHeight()
    if (!shell || targetHeight === null) return

    const currentHeight = Math.ceil(shell.offsetHeight || shell.getBoundingClientRect().height)
    cancelDrawerHeightFrame()
    setDrawerHeight(currentHeight)
    drawerHeightRafRef.current = window.requestAnimationFrame(() => {
      drawerHeightRafRef.current = window.requestAnimationFrame(() => {
        drawerHeightRafRef.current = null
        setDrawerHeight(targetHeight)
      })
    })
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelDrawerHeightFrame()
    }
  }, [])

  useEffect(() => {
    const closeDrawer = (): void => setDrawer(null)
    window.addEventListener(CLOSE_GIT_DRAWER_EVENT, closeDrawer)
    return () => window.removeEventListener(CLOSE_GIT_DRAWER_EVENT, closeDrawer)
  }, [])

  // Refresh branch + status + branches whenever cwd changes. Also closes any
  // open drawer so stale drawer contents from the previous project don't leak.
  useEffect(() => {
    // cwd 真变化才重置抽屉与本地状态；changesGitRoot 变化（turn 结束重算落地）
    // 只补一次 refresh——cwd 非仓库时全局状态要改挂改动多数派仓库。
    const cwdChanged = prevEffectCwdRef.current !== cwd
    prevEffectCwdRef.current = cwd
    if (cwdChanged) {
      setDrawer(null)
      setDiffView(null)
      if (!cwd) {
        setBranch(null)
        setStatus(emptyGitStatus())
        setBranches([])
        setGitChecked(true)
        setGlobalCwd('')
        return
      }
      const cached = getCachedGitToolbar(cwd)
      if (cached) {
        setBranch(cached.branch)
        setStatus(cached.status)
        setBranches(cached.branches)
        setGitChecked(cached.checked)
      } else {
        setGitChecked(false)
        setBranch(null)
        setStatus(emptyGitStatus())
        setBranches([])
      }
    }
    void refresh()
  }, [cwd, changesGitRoot])

  useEffect(() => {
    renderedDrawerRef.current = renderedDrawer
  }, [renderedDrawer])

  useEffect(() => {
    if (drawer) {
      const wasOpen = drawerOpenRef.current
      drawerOpenRef.current = true
      const current = renderedDrawerRef.current
      if (wasOpen && current && current !== drawer) {
        lockDrawerVisibleHeight()
        setRenderedDrawer(drawer)
        return
      }
      setRenderedDrawer(drawer)
      return
    }

    drawerOpenRef.current = false
    const timeout = window.setTimeout(() => setRenderedDrawer(null), DRAWER_CLOSE_CLEAR_MS)
    return () => window.clearTimeout(timeout)
  }, [drawer])

  useEffect(() => {
    const el = drawerContentRef.current
    if (!el || !renderedDrawer) {
      setDrawerHeight(null)
      return
    }

    animateDrawerHeightToContent()

    const observer = new ResizeObserver(() => animateDrawerHeightToContent())
    observer.observe(el)
    return () => {
      cancelDrawerHeightFrame()
      observer.disconnect()
    }
  }, [renderedDrawer])

  const refresh = async (): Promise<void> => {
    if (!cwd) {
      setGitChecked(true)
      setGlobalCwd('')
      return
    }
    // 取消守卫：快照本次刷新的 cwd 与递增序号，await 回来后二者任一失效
    // （切了项目 / 又发起了更新的刷新 / 组件已卸载）就丢弃结果，
    // 避免旧仓库的状态覆盖新仓库的显示。
    const target = cwd
    const changesRoot = changesGitRoot
    const seq = ++refreshSeqRef.current
    const stale = (): boolean =>
      !mountedRef.current || seq !== refreshSeqRef.current || target !== cwdRef.current
    try {
      const [b, s, bl] = await Promise.all([
        window.api.gitGetCurrentBranch(target),
        window.api.gitStatus(target),
        window.api.gitListBranches(target)
      ])
      setCachedGitToolbar(target, b, s, bl)
      if (stale()) return
      if (b === null && changesRoot && normalizeCwdForCompare(changesRoot) !== normalizeCwdForCompare(target)) {
        // 2026-09-02：cwd 不是 git 仓库，但会话改动多数派落在 changesRoot——
        // 工具条全局状态（分支/状态/操作）改挂那个仓库，无项目会话也能看
        // diff、做提交。cwd 本身是仓库时不动（拍板「项目级操作跟 cwd」）。
        try {
          const [b2, s2, bl2] = await Promise.all([
            window.api.gitGetCurrentBranch(changesRoot),
            window.api.gitStatus(changesRoot),
            window.api.gitListBranches(changesRoot)
          ])
          if (stale()) return
          setBranch(b2)
          setStatus(s2)
          setBranches(bl2)
          setGlobalCwd(b2 ? changesRoot : '')
        } catch {
          if (stale()) return
          setBranch(null)
          setStatus(emptyGitStatus())
          setBranches([])
          setGlobalCwd('')
        }
        return
      }
      setBranch(b)
      setStatus(s)
      setBranches(bl)
      setGlobalCwd(b ? target : '')
    } catch {
      setCachedGitToolbar(target, null, emptyGitStatus(), [])
      if (stale()) return
      setBranch(null)
      setStatus(emptyGitStatus())
      setBranches([])
      setGlobalCwd('')
    } finally {
      if (!stale()) setGitChecked(true)
    }
  }

  /** Run a git action, then refresh. If it returns {stdout,stderr}, surface the
   *  text in the output drawer so the user sees push/pull/fetch results. */
  const runGitAction = async (
    fn: () => Promise<unknown>,
    label: string,
    opts: { invalidateLog?: boolean } = {}
  ): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const res = await fn()
      if (opts.invalidateLog) invalidateGitLogCache(gcwd)
      if (res && typeof res === 'object' && ('stdout' in res || 'stderr' in res)) {
        const { stdout, stderr } = res as { stdout: string; stderr: string }
        const text = [stdout, stderr].filter(Boolean).join('\n').trim()
        if (text) {
          setOutput({ cmd: label, text })
          setDrawer('output')
        }
      }
      await refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const setDrawerBusy = (name: OpenDrawer, busy: boolean): void => {
    setDrawerLoading((prev) => {
      const next = { ...prev }
      if (busy) next[name] = true
      else delete next[name]
      return next
    })
  }

  const afterDrawerPaint = (fn: () => void): void => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(fn)
    })
  }

  const loadDrawerData = (next: OpenDrawer): void => {
    if (!gcwd) return

    if (next === 'log') {
      const seq = (drawerLoadSeqRef.current.log ?? 0) + 1
      drawerLoadSeqRef.current.log = seq
      const logBranch = branch
      const cachedCommits = getCachedGitLog(gcwd, logBranch, GIT_LOG_LIMIT)
      if (cachedCommits) {
        setCommits(cachedCommits)
        setDrawerBusy('log', false)
        afterDrawerPaint(() => animateDrawerHeightToContent())
        return
      }
      setCommits([])
      setDrawerBusy('log', true)
      afterDrawerPaint(() => {
        void (async () => {
          try {
            const data = await window.api.gitLog(gcwd, GIT_LOG_LIMIT)
            if (mountedRef.current && drawerLoadSeqRef.current.log === seq) {
              setCachedGitLog(gcwd, logBranch, GIT_LOG_LIMIT, data)
              lockDrawerVisibleHeight()
              setCommits(data)
            }
          } catch {
            if (mountedRef.current && drawerLoadSeqRef.current.log === seq) {
              lockDrawerVisibleHeight()
              setCommits([])
            }
          } finally {
            if (mountedRef.current && drawerLoadSeqRef.current.log === seq) setDrawerBusy('log', false)
          }
        })()
      })
    } else if (next === 'stash') {
      const seq = (drawerLoadSeqRef.current.stash ?? 0) + 1
      drawerLoadSeqRef.current.stash = seq
      setStashList([])
      setDrawerBusy('stash', true)
      afterDrawerPaint(() => {
        void (async () => {
          try {
            const res = await window.api.gitStash(gcwd, 'list')
            if (mountedRef.current && drawerLoadSeqRef.current.stash === seq) {
              lockDrawerVisibleHeight()
              setStashList(res.split('\n').filter(Boolean))
            }
          } catch {
            if (mountedRef.current && drawerLoadSeqRef.current.stash === seq) {
              lockDrawerVisibleHeight()
              setStashList([])
            }
          } finally {
            if (mountedRef.current && drawerLoadSeqRef.current.stash === seq) setDrawerBusy('stash', false)
          }
        })()
      })
    }
  }

  const toggleDrawer = (next: OpenDrawer): void => {
    if (drawer === next) {
      setDrawer(null)
      return
    }
    if (next === 'changes') setChangesTarget(null)
    setDrawer(next)
    loadDrawerData(next)
  }

  // 轮次改动卡的「审核」按钮：打开工作区改动面板（对话流里点、面板在这儿开，
  // 两个组件不直接耦合，走既有的渲染层事件总线）。
  useEffect(() => {
    return onOpenChangesPanel(({ path }) => {
      setChangesTarget(path ? { path, requestKey: ++changesRequestSeqRef.current } : null)
      setDrawer('changes')
      loadDrawerData('changes')
    })
  }, [])

  const loadDiff = async (paths: string[], staged: boolean, note?: string): Promise<void> => {
    if (!gcwd) return
    // 竞态守卫：先点大文件（diff 慢）再点小文件（快），慢响应后到会覆盖，
    // 面板跳回上一个文件。用序号只让最后一次点击的结果落地。
    const seq = ++diffSeqRef.current
    setDiffView({ paths, staged, text: '', note, loading: true })
    if (note) {
      setDiffView({ paths, staged, text: '', note, loading: false })
      return
    }
    try {
      const text = await window.api.gitDiff(gcwd, { paths, staged })
      if (seq !== diffSeqRef.current) return
      setDiffView({ paths, staged, text, loading: false })
    } catch (e: unknown) {
      if (seq !== diffSeqRef.current) return
      setDiffView({ paths, staged, text: '', note: e instanceof Error ? e.message : String(e), loading: false })
    }
  }

  const stageFile = (path: string): Promise<void> => runGitAction(() => window.api.gitAdd(gcwd, [path]), '暂存')
  const unstageFile = (path: string): Promise<void> => runGitAction(() => window.api.gitReset(gcwd, [path]), '取消暂存')

  const doCommit = async (): Promise<void> => {
    const msg = commitMsg.trim()
    if (!msg) { setError('请输入提交信息'); return }
    await runGitAction(async () => {
      await window.api.gitCommit(gcwd, msg)
      setCommitMsg('')
      setDiffView(null)
    }, '提交', { invalidateLog: true })
  }

  // 非 git 目录（gitChecked 后 branch 仍是 null）：工具条本体不渲染，但「改动」
  // 抽屉的宿主必须在——轮次卡/会话 pill 的 openChangesPanel 监听在上面的 hook
  // 里照常挂着，此前这条早退路径没有抽屉 DOM，非 git 会话点了等于没点
  // （2026-08-25 用户抓包：「本会话 N 个文件已更改」是死按钮）。补一个极简
  // 抽屉：只认 changes，里面是一句诚实说明（复用 ChangesPanel 的空态样式），
  // 不挂 ChangesPanel 本体，免得 gitWorkingChanges 在非 git 目录空转报错。
  // 2026-09-02：cwd 非仓库但改动多数派仓库（changesGitRoot）存在时走不到
  // 这里——refresh 已把 branch/globalCwd 挂到那个仓库，按正常工具条渲染。
  if (!branch) {
    if (gitChecked) {
      const changesOpen = renderedDrawer === 'changes'
      if (!cornerAction && !changesOpen) return <></>
      return (
        <div className="relative z-30 shrink-0 border-b border-white/[0.06]">
          {cornerAction ? (
            <>
              <div className="h-5" aria-hidden="true" />
              <div className="git-toolbar-corner-action">{cornerAction}</div>
            </>
          ) : null}
          <Collapse
            open={drawer === 'changes'}
            className={`git-drawer-collapse absolute left-0 right-0 top-full z-40 shadow-[0_24px_60px_rgba(0,0,0,0.28)] ${
              drawer === 'changes' ? 'pointer-events-auto' : 'pointer-events-none'
            }`}
          >
            <div className="git-drawer-shell max-h-[46vh] overflow-y-auto border-b border-t border-t-white/[0.06] border-b-white/[0.18] bg-[#090a0e]/[0.98] text-zinc-300 shadow-[0_18px_44px_rgba(0,0,0,0.24)]">
              <div className="git-drawer-content px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">工作区改动</span>
                  <button onClick={() => setDrawer(null)} className="rounded px-1 py-0.5 text-zinc-600 transition hover:text-zinc-300">
                    ✕
                  </button>
                </div>
                <div className="py-6 text-center text-[11px] text-zinc-500">
                  该目录不是 Git 仓库，查看不了工作区改动
                </div>
              </div>
            </div>
          </Collapse>
        </div>
      )
    }
    return (
      <div className="relative z-30 shrink-0 border-b border-white/[0.06]">
        <div className="flex h-8 items-center gap-1.5 px-2.5 pr-10 text-[11px] text-zinc-500">
          <BranchIcon />
          <span className="font-medium">Git 状态加载中...</span>
        </div>
        {cornerAction && <div className="git-toolbar-corner-action">{cornerAction}</div>}
      </div>
    )
  }

  // 全局状态目标仓库：branch 非 null 时 globalCwd 必有值（cwd 或改动多数派
  // 仓库）。所有项目级 git 操作与抽屉数据源都用它，不再直接用 cwd。
  const gcwd = globalCwd || cwd
  const gcwdRepoName = gcwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  const showingChangesRepo =
    !!globalCwd && normalizeCwdForCompare(globalCwd) !== normalizeCwdForCompare(cwd)
  const btnCls =
    'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40'
  const dotCls = 'h-1.5 w-1.5 shrink-0 rounded-full'
  const dirty = !status.clean
  const totalChanges = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length
  const activeBtn = (d: Drawer): string => (drawer === d ? 'bg-white/[0.08] text-zinc-100' : '')
  const drawerShellOverflow = renderedDrawer === 'branches' ? 'overflow-hidden' : 'overflow-y-auto'
  const drawerShellMaxHeight = renderedDrawer === 'branches' ? 'max-h-none' : 'max-h-[46vh]'

  return (
    <div className="relative z-30 shrink-0 border-b border-white/[0.06]">
      {/* --- toolbar row --- */}
      <div className="flex items-center gap-1.5 px-2.5 py-1 pr-10 text-zinc-400">
        {/* Branch + ahead/behind */}
        <button
          onClick={() => toggleDrawer('branches')}
          className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 transition hover:bg-white/[0.06] ${activeBtn('branches')}`}
        >
          <BranchIcon />
          <span className="max-w-[160px] truncate font-mono">{branch}</span>
          {showingChangesRepo && (
            <HoverTip tip={`会话改动所在的仓库：${gcwd}`}>
              <span className="max-w-[120px] truncate text-[10px] text-zinc-500">· {gcwdRepoName}</span>
            </HoverTip>
          )}
          {status.ahead ? <span className="text-[10px] font-semibold text-emerald-400">↑{status.ahead}</span> : null}
          {status.behind ? <span className="text-[10px] font-semibold text-amber-400">↓{status.behind}</span> : null}
        </button>

        {/* Status dots */}
        {dirty && (
          <div className="flex items-center gap-1 pl-0.5">
            {status.staged.length > 0 && <HoverTip tip={`${status.staged.length} 已暂存`}><span className={`${dotCls} bg-yellow-500`} /></HoverTip>}
            {status.unstaged.length > 0 && <HoverTip tip={`${status.unstaged.length} 已改动`}><span className={`${dotCls} bg-blue-500`} /></HoverTip>}
            {status.untracked.length > 0 && <HoverTip tip={`${status.untracked.length} 未跟踪`}><span className={`${dotCls} bg-green-500`} /></HoverTip>}
            {status.conflicts.length > 0 && <HoverTip tip={`${status.conflicts.length} 冲突`}><span className={`${dotCls} bg-red-500`} /></HoverTip>}
          </div>
        )}

        <span className="h-3 w-px shrink-0 bg-white/[0.08]" />

        {/* Sync: fetch / pull / push */}
        <button onClick={() => runGitAction(() => window.api.gitFetch(gcwd), '拉取(fetch)')} disabled={loading} className={btnCls} aria-label="拉取远端信息(不合并)">
          <HoverTip tip="拉取远端信息(不合并)"><FetchIcon /></HoverTip>
        </button>
        <button onClick={() => runGitAction(() => window.api.gitPull(gcwd), '拉取', { invalidateLog: true })} disabled={loading} className={btnCls} aria-label="拉取并合并">
          <HoverTip tip="拉取并合并"><PullIcon /> 拉取</HoverTip>
        </button>
        <button onClick={() => runGitAction(() => window.api.gitPush(gcwd), '推送')} disabled={loading} className={btnCls} aria-label="推送">
          <HoverTip tip="推送"><PushIcon /> 推送</HoverTip>
        </button>

        <span className="h-3 w-px shrink-0 bg-white/[0.08]" />

        {/* Changes → opens aggregated working-tree diff drawer (Codex 风格) */}
        <button
          onClick={() => toggleDrawer('changes')}
          className={`${btnCls} ${activeBtn('changes')}`}
          aria-label="查看工作区全部改动"
        >
          <HoverTip tip="查看工作区全部改动"><DiffIcon /> 改动</HoverTip>
          {totalChanges > 0 && <span className="rounded bg-accent/20 px-1 text-[9px] text-accent">{totalChanges}</span>}
        </button>

        {/* Commit → opens commit drawer */}
        <button
          onClick={() => toggleDrawer('commit')}
          disabled={loading}
          className={`${btnCls} ${activeBtn('commit')}`}
          aria-label="暂存与提交"
        >
          <HoverTip tip="暂存与提交"><CommitIcon /> 提交</HoverTip>
          {status.staged.length > 0 && <span className="rounded bg-accent/20 px-1 text-[9px] text-accent">{status.staged.length}</span>}
        </button>

        {/* Stash → opens stash drawer */}
        <button
          onClick={() => toggleDrawer('stash')}
          disabled={loading || status.clean}
          className={`${btnCls} ${activeBtn('stash')}`}
          aria-label="储藏"
        >
          <HoverTip tip="储藏"><StashIcon /> 储藏</HoverTip>
        </button>

        <span className="h-3 w-px shrink-0 bg-white/[0.08]" />

        {/* Log */}
        <button onClick={() => toggleDrawer('log')} disabled={loading} className={`${btnCls} ${activeBtn('log')}`} aria-label="提交历史">
          <HoverTip tip="提交历史"><LogIcon /> 日志</HoverTip>
        </button>

        {/* Output indicator (shows after push/pull/fetch produce text) */}
        {output && (
          <button onClick={() => toggleDrawer('output')} className={`${btnCls} ${activeBtn('output')}`} aria-label="上次操作输出">
            <HoverTip tip="上次操作输出">输出</HoverTip>
          </button>
        )}

        {/* Conflict warning */}
        {status.conflicts.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
            <span className={`${dotCls} bg-red-500`} />
            {status.conflicts.length} 个冲突
          </span>
        )}

        {loading && <span className="ml-auto text-[10px] text-zinc-500 animate-pulse">处理中…</span>}
        {error && (
          <span className={`flex items-center gap-1 text-[10px] text-red-400 ${loading ? '' : 'ml-auto'}`}>
            <span className="max-w-[280px] truncate">{error}</span>
            <button onClick={() => setError(null)} className="hover:text-red-300"><CloseIcon /></button>
          </span>
        )}
      </div>
      {cornerAction && <div className="git-toolbar-corner-action">{cornerAction}</div>}

      {/* --- drawer area (one at a time) --- 工具条在正文顶部常驻，
          抽屉从它下面垂下来（2026-08-18 用户拍板「git工具去上面啊」）。 */}
      <Collapse
        open={!!drawer}
        className={`git-drawer-collapse absolute left-0 right-0 top-full z-40 shadow-[0_24px_60px_rgba(0,0,0,0.28)] ${
          drawer ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
      >
        <div
          ref={drawerShellRef}
          className={`git-drawer-shell ${drawerShellMaxHeight} ${drawerShellOverflow} border-b border-t border-t-white/[0.06] border-b-white/[0.18] bg-[#090a0e]/[0.98] text-zinc-300 shadow-[0_18px_44px_rgba(0,0,0,0.24)]`}
          style={drawerHeight === null ? undefined : { height: drawerHeight }}
        >
          <div
            ref={drawerContentRef}
            className="git-drawer-content px-3 py-2.5"
          >
          {/* Branches drawer */}
          {renderedDrawer === 'branches' && (
            <div className="git-branches-drawer flex min-h-0 flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">切换分支</span>
                <button onClick={() => setDrawer(null)} className="text-zinc-600 hover:text-zinc-300"><CloseIcon /></button>
              </div>
              <div className="git-stable-scroll min-h-0 flex-1 overflow-y-auto pr-1">
                {branches.map((b) => (
                  <div
                    key={b.name}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] transition hover:bg-white/[0.05] ${
                      b.current ? 'bg-accent/10 font-medium text-zinc-200' : 'text-zinc-400'
                    }`}
                  >
                    <button
                      onClick={() => runGitAction(() => window.api.gitCheckoutBranch(gcwd, b.name), '切换分支').then(() => setDrawer(null))}
                      disabled={loading || !!b.current}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-40"
                    >
                      {b.current && <span className={`${dotCls} bg-emerald-500`} />}
                      <span className="truncate font-mono">{b.name}</span>
                    </button>
                    {!b.current && (
                      <button
                        onClick={() => setConfirm({
                          title: '删除分支',
                          message: `确定删除本地分支 ${b.name}?`,
                          confirmLabel: '删除',
                          danger: true,
                          onConfirm: () => { const name = b.name; setConfirm(null); void runGitAction(() => window.api.gitDeleteBranch(gcwd, name, true), '删除分支') }
                        })}
                        disabled={loading}
                        className="rounded p-0.5 text-zinc-600 hover:text-red-400"
                        aria-label={`删除 ${b.name}`}
                      >
                        <HoverTip tip={`删除 ${b.name}`}><TrashIcon /></HoverTip>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {/* Create branch */}
              <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.06] pb-0.5 pt-2">
                <input
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    // 输入法组词中的 Enter 是确认候选，别拿没上屏的名字建分支。
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter' && newBranchName.trim()) void createBranch()
                  }}
                  placeholder="新分支名"
                  className="flex-1 rounded-lg border border-white/[0.1] bg-bg-elev/60 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
                <HoverTip tip="创建后推送到远端并设置上游"><label className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <input type="checkbox" checked={pushUpstream} onChange={(e) => setPushUpstream(e.target.checked)} className="accent-accent" />
                  推送
                </label></HoverTip>
                <button onClick={createBranch} disabled={loading || !newBranchName.trim()} className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-40">
                  <PlusIcon /> 创建
                </button>
              </div>
            </div>
          )}

          {/* Commit drawer: staging management + per-file diff + commit input */}
          {renderedDrawer === 'commit' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">
                  提交 · {totalChanges} 个变更
                </span>
                <div className="flex items-center gap-1">
                  {!status.clean && (
                    <button onClick={() => runGitAction(() => window.api.gitAdd(gcwd), '全部暂存')} disabled={loading} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200">
                      全部暂存
                    </button>
                  )}
                  <button onClick={() => loadDiff([], false)} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200">
                    全部改动
                  </button>
                  <button onClick={() => setDrawer(null)} className="ml-1 text-zinc-600 hover:text-zinc-300"><CloseIcon /></button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {/* file lists */}
                <div className="min-w-0 space-y-2">
                  {status.conflicts.length > 0 && (
                    <FileSection title="冲突" files={status.conflicts} kind="conflict" loading={loading} diffView={diffView} onPick={(p) => loadDiff([p], false)} />
                  )}
                  {status.staged.length > 0 && (
                    <FileSection
                      title="已暂存"
                      files={status.staged}
                      kind="staged"
                      loading={loading}
                      diffView={diffView}
                      onPick={(p) => loadDiff([p], true)}
                      actionIcon={<MinusIcon />}
                      actionTitle="取消暂存"
                      onAction={unstageFile}
                    />
                  )}
                  {status.unstaged.length > 0 && (
                    <FileSection
                      title="已改动"
                      files={status.unstaged}
                      kind="unstaged"
                      loading={loading}
                      diffView={diffView}
                      onPick={(p) => loadDiff([p], false)}
                      actionIcon={<PlusIcon />}
                      actionTitle="暂存"
                      onAction={stageFile}
                    />
                  )}
                  {status.untracked.length > 0 && (
                    <FileSection
                      title="未跟踪"
                      files={status.untracked}
                      kind="untracked"
                      loading={loading}
                      diffView={diffView}
                      onPick={(p) => loadDiff([p], false, '未跟踪文件,暂无 diff')}
                      actionIcon={<PlusIcon />}
                      actionTitle="暂存"
                      onAction={stageFile}
                    />
                  )}
                  {status.clean && <div className="py-4 text-center text-[11px] text-zinc-600">工作区干净</div>}
                </div>

                {/* diff viewer */}
                <div className="min-w-0">
                  {diffView ? (
                    <div>
                      <div className="mb-1 truncate text-[10px] text-zinc-500">
                        {diffView.loading ? '加载 diff…' : (diffView.paths.length ? diffView.paths.join(', ') : '全部改动')}
                        {diffView.staged && <span className="ml-1 text-amber-400/80">(已暂存)</span>}
                      </div>
                      {diffView.note ? (
                        <div className="rounded bg-[#0b0c10] p-2.5 text-[11px] text-zinc-500">{diffView.note}</div>
                      ) : diffView.loading ? (
                        <div className="rounded bg-[#0b0c10] p-2.5 text-[11px] text-zinc-600">…</div>
                      ) : diffView.text ? (
                        <div className="max-h-[min(60vh,32rem)] overflow-auto"><DiffView text={diffView.text} /></div>
                      ) : (
                        <div className="rounded bg-[#0b0c10] p-2.5 text-[11px] text-zinc-600">无差异</div>
                      )}
                    </div>
                  ) : (
                    <div className="flex h-full items-center justify-center rounded bg-[#0b0c10]/50 p-4 text-center text-[11px] text-zinc-600">
                      点击左侧文件查看改动
                    </div>
                  )}
                </div>
              </div>

              {/* commit input */}
              <div className="flex items-center gap-2 border-t border-white/[0.06] pt-2">
                <input
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void doCommit() }}
                  placeholder="提交信息(Ctrl+Enter 提交)"
                  className="flex-1 rounded-lg border border-white/[0.1] bg-bg-elev/60 px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
                <button
                  onClick={doCommit}
                  disabled={loading || status.staged.length === 0}
                  className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-medium text-white transition hover:brightness-110 disabled:opacity-40"
                  aria-label={status.staged.length === 0 ? '没有已暂存的改动' : '提交已暂存的改动'}
                >
                  <HoverTip tip={status.staged.length === 0 ? '没有已暂存的改动' : '提交已暂存的改动'}><CommitIcon /> 提交{status.staged.length > 0 ? ` (${status.staged.length})` : ''}</HoverTip>
                </button>
              </div>
            </div>
          )}

          {/* Changes drawer：工作区改动聚合视图 */}
          {renderedDrawer === 'changes' && (
            <ChangesPanel
              cwd={changesGitRoot ?? gcwd}
              groups={changesGitGroups}
              // 已知遗留（2026-09-02）：refreshKey 仍只盯主仓库（gcwd）的 status
              // 计数，其他组仓库的外部改动不触发静默刷新，面板内手动刷新可补。
              refreshKey={`${status.staged.length}:${status.unstaged.length}:${status.untracked.length}:${status.conflicts.length}`}
              initialPath={changesTarget?.path}
              initialRequestKey={changesTarget?.requestKey}
              onClose={() => setDrawer(null)}
            />
          )}

          {/* Log drawer */}
          {renderedDrawer === 'log' && (
            <div className="flex flex-col gap-1">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">提交历史</span>
                <button onClick={() => setDrawer(null)} className="text-zinc-600 hover:text-zinc-300"><CloseIcon /></button>
              </div>
              {drawerLoading.log ? (
                <DrawerLoading label="提交历史加载中..." />
              ) : commits.length === 0 ? (
                <div className="py-4 text-center text-[11px] text-zinc-600">暂无提交</div>
              ) : (
                commits.map((c) => (
                  <div key={c.hash} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 transition hover:bg-white/[0.05]">
                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">{c.shortHash}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-zinc-300">{c.message}</div>
                      <div className="text-[10px] text-zinc-600">{c.author} · {formatTime(c.date)}</div>
                    </div>
                    <button
                      onClick={() => setConfirm({
                        title: '撤销提交',
                        message: `用 git revert 撤销提交 ${c.shortHash}?\n「${c.message}」\n这会创建一个反向的新提交。`,
                        confirmLabel: '撤销',
                        danger: true,
                        onConfirm: () => { const hash = c.hash; setConfirm(null); void runGitAction(() => window.api.gitRevert(gcwd, hash), '撤销提交', { invalidateLog: true }).then(() => setDrawer(null)) }
                      })}
                      disabled={loading}
                      className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition hover:text-amber-400 group-hover:opacity-100 disabled:opacity-30"
                      aria-label="撤销此提交"
                    >
                      <HoverTip tip="撤销此提交"><RevertIcon /></HoverTip>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Stash drawer */}
          {renderedDrawer === 'stash' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">储藏</span>
                <button onClick={() => setDrawer(null)} className="text-zinc-600 hover:text-zinc-300"><CloseIcon /></button>
              </div>
              <div className="flex gap-2">
                <button onClick={() => runGitAction(() => window.api.gitStash(gcwd, 'push'), '储藏').then(refreshStash)} disabled={loading} className="flex items-center gap-1 rounded-lg border border-white/[0.1] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40">
                  <PlusIcon /> 储藏当前改动
                </button>
                <button
                  onClick={() => setConfirm({
                    title: '恢复储藏',
                    message: '恢复最近的储藏(stash pop)?\n若与当前改动冲突,会产生合并冲突。',
                    confirmLabel: '恢复',
                    onConfirm: () => { setConfirm(null); void runGitAction(() => window.api.gitStash(gcwd, 'pop'), '恢复储藏').then(refreshStash) }
                  })}
                  disabled={loading || stashList.length === 0}
                  className="flex items-center gap-1 rounded-lg border border-white/[0.1] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  ↩ 恢复最近
                </button>
              </div>
              <div className="git-stable-scroll max-h-40 overflow-y-auto">
                {drawerLoading.stash ? (
                  <DrawerLoading label="储藏列表加载中..." />
                ) : stashList.length === 0 ? (
                  <div className="py-3 text-center text-[11px] text-zinc-600">暂无储藏</div>
                ) : (
                  stashList.map((s, i) => (
                    <div key={i} className="truncate rounded-lg px-2 py-1 font-mono text-[10px] text-zinc-500 hover:bg-white/[0.05]">
                      <HoverTip tip={s}>{s}</HoverTip>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Output drawer */}
          {renderedDrawer === 'output' && (
            <div className="flex flex-col gap-1">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">{output?.cmd} 输出</span>
                <button onClick={() => setDrawer(null)} className="text-zinc-600 hover:text-zinc-300"><CloseIcon /></button>
              </div>
              <pre className="git-stable-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0b0c10] p-2.5 text-[11px] leading-relaxed text-zinc-300">
                {output?.text || '(无输出)'}
              </pre>
            </div>
          )}
          </div>
        </div>
      </Collapse>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title || ''}
        message={confirm?.message || ''}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
        onConfirm={() => confirm?.onConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )

  async function createBranch(): Promise<void> {
    const name = newBranchName.trim()
    if (!name) return
    await runGitAction(async () => {
      await window.api.gitCreateBranch(gcwd, name)
      await window.api.gitCheckoutBranch(gcwd, name)
      if (pushUpstream) await window.api.gitPushUpstream(gcwd)
      setNewBranchName('')
    }, '创建分支')
    setDrawer(null)
  }

  async function refreshStash(): Promise<void> {
    if (!gcwd) return
    try {
      const res = await window.api.gitStash(gcwd, 'list')
      setStashList(res.split('\n').filter(Boolean))
    } catch { setStashList([]) }
  }
}

/** A labeled group of file rows, used inside the commit drawer. */
function FileSection({
  title,
  files,
  kind,
  loading,
  diffView,
  onPick,
  actionIcon,
  actionTitle,
  onAction
}: {
  title: string
  files: string[]
  kind: FileKind
  loading: boolean
  diffView: { paths: string[]; staged: boolean } | null
  onPick: (path: string) => void
  actionIcon?: JSX.Element
  actionTitle?: string
  onAction?: (path: string) => Promise<void>
}): JSX.Element {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium text-zinc-500">{title} · {files.length}</div>
      <div className="space-y-0.5">
        {files.map((path) => {
          const selected = !!diffView && diffView.paths.length === 1 && diffView.paths[0] === path
          return (
            <FileRow
              key={path}
              path={path}
              kind={kind}
              selected={selected}
              loading={loading}
              onSelect={() => onPick(path)}
              actionIcon={actionIcon}
              actionTitle={actionTitle}
              onAction={onAction ? () => onAction(path) : undefined}
            />
          )
        })}
      </div>
    </div>
  )
}
