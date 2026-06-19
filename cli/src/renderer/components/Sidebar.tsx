import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore, type View } from '../store/uiStore'
import Collapse from './Collapse'
import ProjectSwitcher from './ProjectSwitcher'
import type { AgentBackendId, ClaudeExecutionBackend, Provider, SessionListItem } from '../../shared/ipc'
import { onForgeEvent } from '../events'

type BackendFilter = 'all' | ClaudeExecutionBackend
type SessionGroupMode = 'time' | 'project'
type SessionListTransitionPhase = 'idle' | 'exiting' | 'loading' | 'entering'
type WslNavRevealPhase = 'hidden' | 'opening' | 'visible' | 'closing'
type SessionGroup = { label: string; items: SessionListItem[] }
type AnimatedSessionItem = { session: SessionListItem; exiting: boolean }
type AnimatedSessionGroup = { label: string; items: AnimatedSessionItem[] }
type SessionListSnapshot = {
  activeSessionId: string | null
  groups: SessionGroup[]
  showRuntimeBadges: boolean
}

const PINNED_SESSIONS_KEY = 'forge.pinnedSessions.v1'

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  return `${d} 天前`
}

const DAY = 86_400_000
const GROUP_ORDER = ['今天', '昨天', '本周', '更早'] as const
const SIDEBAR_MOTION_MS = 560
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

function toAnimatedSessionGroups(
  groups: SessionGroup[],
  exitingKeys: Set<string> = new Set()
): AnimatedSessionGroup[] {
  return groups
    .map((group) => ({
      label: group.label,
      items: group.items.map((session) => ({
        session,
        exiting: exitingKeys.has(sessionKey(session))
      }))
    }))
    .filter((group) => group.items.length > 0)
}

/* --- icons --- */
const PlusIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
const ChevronIcon = ({ collapsed }: { collapsed: boolean }): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path
      d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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

/** The five footer tool tabs, in display order. Drives both the icon rail
 *  (collapsed sidebar) and the collapsible nav (expanded sidebar). */
const NAV_ITEMS: { view: View; label: string; icon: () => JSX.Element }[] = [
  { view: 'skills', label: '技能', icon: SkillsIcon },
  { view: 'mcp', label: 'MCP 服务器', icon: McpIcon },
  { view: 'providers', label: '运营商', icon: ShieldIcon },
  { view: 'translate', label: '翻译', icon: LanguageIcon },
  { view: 'settings', label: '设置', icon: GearIcon },
  { view: 'wslHealth', label: 'WSL', icon: TerminalIcon },
  { view: 'help', label: '说明', icon: HelpIcon }
]

export default function Sidebar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const sessions = useSessionStore((s) => s.sessions)
  const loading = useSessionStore((s) => s.sessionsLoading)
  const sessionsHasMore = useSessionStore((s) => s.sessionsHasMore)
  const refresh = useSessionStore((s) => s.refreshSessions)
  const reloadForBackendSwitch = useSessionStore((s) => s.reloadForBackendSwitch)
  const loadMoreSessions = useSessionStore((s) => s.loadMoreSessions)
  const newChat = useSessionStore((s) => s.newChat)
  const openSession = useSessionStore((s) => s.openSession)
  const prefetchSessionHistory = useSessionStore((s) => s.prefetchSessionHistory)
  const pruneSessionHistoryCache = useSessionStore((s) => s.pruneSessionHistoryCache)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const navCollapsed = useUiStore((s) => s.navCollapsed)
  const toggleNav = useUiStore((s) => s.toggleNav)

  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>('claude-code')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [sessionSearch, setSessionSearch] = useState('')
  const [backendFilter, setBackendFilter] = useState<BackendFilter>('all')
  const [groupMode, setGroupMode] = useState<SessionGroupMode>('time')
  const [pinnedSessionKeys, setPinnedSessionKeys] = useState<Set<string>>(() => readPinnedSessions())
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [wslNavRevealPhase, setWslNavRevealPhase] = useState<WslNavRevealPhase>('hidden')
  const [sessionListTransitionPhase, setSessionListTransitionPhase] =
    useState<SessionListTransitionPhase>('idle')
  const [sessionListSnapshot, setSessionListSnapshot] = useState<SessionListSnapshot | null>(null)
  const [newlyInsertedSessionKeys, setNewlyInsertedSessionKeys] = useState<Set<string>>(() => new Set())
  const [exitingSessionKeys, setExitingSessionKeys] = useState<Set<string>>(() => new Set())
  const [renderedSessionGroups, setRenderedSessionGroups] = useState<AnimatedSessionGroup[] | null>(null)
  const sidebarMotionTimeoutRef = useRef<number | null>(null)
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
  const firstSidebarPaintRef = useRef(true)
  const preparedSidebarMotionRef = useRef(false)

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
    setBackendFilter('all')
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
    setBackendFilter('windows')
    void refresh()
    sessionListFadeTimeoutRef.current = window.setTimeout(() => {
      sessionListFadeTimeoutRef.current = null
      if (transitionId !== sessionListTransitionIdRef.current) return
      startWslNavOpening()
    }, WSL_OPEN_SESSION_STAGE_MS)
  }

  useEffect(() => {
    const refreshWslSupport = (): void => {
      void window.api.getPreferences().then((prefs) => {
        const enabled = !!prefs.wslSupportEnabled
        if (!wslSupportInitializedRef.current) {
          wslSupportInitializedRef.current = true
          setWslSupportEnabled(enabled)
          setWslNavPhase(enabled ? 'visible' : 'hidden')
          setBackendFilter(enabled ? 'windows' : 'all')
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

  // Re-read the active agent/provider whenever a new session spawns (covers
  // provider switches, which restart the session -> new bridge id).
  useEffect(() => {
    const refreshAgentProvider = (): void => {
      void Promise.all([
        window.api.getPreferences().catch(() => null),
        window.api.getActiveProvider().catch(() => null)
      ]).then(([prefs, provider]) => {
        const nextAgent = prefs?.agentBackend ?? 'claude-code'
        setAgentBackend(nextAgent)
        setActiveProvider(nextAgent === 'claude-code' || nextAgent === 'hermes' ? provider : null)
      })
    }
    refreshAgentProvider()
    const offProvider = onForgeEvent('providerChanged', refreshAgentProvider)
    const offAgentBackend = onForgeEvent('agentBackendChanged', refreshAgentProvider)
    return () => {
      offProvider()
      offAgentBackend()
    }
  }, [meta?.sessionId])

  const clearSidebarMotionTimers = (): void => {
    if (sidebarMotionTimeoutRef.current !== null) {
      window.clearTimeout(sidebarMotionTimeoutRef.current)
      sidebarMotionTimeoutRef.current = null
    }
  }

  const prepareSidebarMotion = (): void => {
    clearSidebarMotionTimers()
    document.documentElement.classList.add('sidebar-motion')
    sidebarMotionTimeoutRef.current = window.setTimeout(() => {
      sidebarMotionTimeoutRef.current = null
      document.documentElement.classList.remove('sidebar-motion')
    }, SIDEBAR_MOTION_MS)
  }

  const handleToggleSidebar = (): void => {
    preparedSidebarMotionRef.current = true
    prepareSidebarMotion()
    toggleSidebar()
  }

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
    if (firstSidebarPaintRef.current) {
      firstSidebarPaintRef.current = false
      return
    }
    if (preparedSidebarMotionRef.current) {
      preparedSidebarMotionRef.current = false
      return
    }
    prepareSidebarMotion()
  }, [collapsed])

  useEffect(() => {
    return () => {
      clearSidebarMotionTimers()
      clearWslNavRevealTimer()
      clearSessionListFadeTimers()
      clearSessionInsertTimer()
      clearSessionExitTimer()
      clearSessionCacheReleaseTimer()
      clearPrefetchResumeTimer()
      document.documentElement.classList.remove('sidebar-motion')
    }
  }, [])

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

  const commitEdit = (): void => {
    if (editingId && editText.trim()) {
      const target = sessions.find((session) => sessionKey(session) === editingId)
      if (target) void renameSession(target.sessionId, editText, target.runtimeBackend)
    }
    setEditingId(null)
  }
  const doDelete = (key: string): void => {
    setConfirmDeleteId(null)
    const target = sessions.find((session) => sessionKey(session) === key)
    if (target) void deleteSession(target.sessionId, target.runtimeBackend)
  }

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase()
    return sessions
      .filter((session) => {
        if (!wslSupportEnabled && (session.runtimeBackend ?? 'windows') === 'wsl') return false
        if (backendFilter !== 'all' && (session.runtimeBackend ?? 'windows') !== backendFilter) return false
        if (!q) return true
        const haystack = [
          session.summary,
          session.cwd,
          session.gitBranch,
          session.runtimeBackend
        ]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
        return haystack.includes(q)
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
  }, [backendFilter, pinnedSessionKeys, sessionSearch, sessions, wslSupportEnabled])

  const sessionGroups = useMemo(
    () =>
      groupMode === 'project'
        ? groupSessionsByProject(filteredSessions, meta?.cwd ?? '')
        : groupSessionsByTime(filteredSessions),
    [filteredSessions, groupMode, meta?.cwd]
  )
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

    if (collapsed || !meta) return

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
  }, [collapsed, meta?.cwd, sessionGroups, prefetchSessionHistory])

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
  const showProviderNav = agentBackend === 'claude-code' || agentBackend === 'hermes'

  useEffect(() => {
    if (!showProviderNav && view === 'providers') setView('settings')
  }, [setView, showProviderNav, view])

  /* ---------- collapsed: icon rail ---------- */
  if (collapsed) {
    const iconBtn = (on: boolean): string =>
      `flex h-9 w-9 items-center justify-center rounded-xl transition ${
        on ? 'glass-active text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
      }`
    return (
      <div key="sidebar-collapsed" className="sidebar-collapse glass-sidebar flex w-14 shrink-0 flex-col items-center rounded-[18px] border py-2.5">
        <button
          onClick={handleToggleSidebar}
          className={iconBtn(false)}
          title="展开侧边栏"
        >
          <ChevronIcon collapsed />
        </button>
        <div className="accent-soft-button mt-2 flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold text-white">
          F
        </div>
        <div className="mt-2">
          <ProjectSwitcher collapsed />
        </div>
        <button
          onClick={() => {
            void newChat()
            setView('chat')
          }}
          className="accent-soft-button mt-2 flex h-9 w-9 items-center justify-center rounded-xl text-white transition hover:brightness-110"
          title="新建对话"
        >
          <PlusIcon />
        </button>
        {showProviderNav && activeProvider && (
          <span
            className="mt-2 h-1.5 w-1.5 rounded-full bg-emerald-500"
            title={`运营商:${activeProvider.name || activeProvider.baseUrl}`}
          />
        )}
        <div className="min-h-0 flex-1" />
        <button
          onClick={() => setView('skills')}
          className={iconBtn(view === 'skills')}
          title="技能"
        >
          <SkillsIcon />
        </button>
        <button
          onClick={() => setView('mcp')}
          className={`mt-1 ${iconBtn(view === 'mcp')}`}
          title="MCP 服务器"
        >
          <McpIcon />
        </button>
        <div className={`provider-stack-reveal provider-collapsed-reveal ${showProviderNav ? 'is-enabled' : ''}`}>
          <button
            onClick={() => {
              if (showProviderNav) setView('providers')
            }}
            className={iconBtn(view === 'providers')}
            title="运营商"
            disabled={!showProviderNav}
            tabIndex={showProviderNav ? 0 : -1}
            aria-hidden={!showProviderNav}
          >
            <ShieldIcon />
          </button>
        </div>
        <button
          onClick={() => setView('translate')}
          className={`mt-1 ${iconBtn(view === 'translate')}`}
          title="翻译"
        >
          <LanguageIcon />
        </button>
        <button
          onClick={() => setView('settings')}
          className={`mt-1 ${iconBtn(view === 'settings')}`}
          title="设置"
        >
          <GearIcon />
        </button>
        <div className={`wsl-stack-reveal wsl-collapsed-reveal ${wslNavRevealClass}`}>
          <button
            onClick={() => {
              if (wslNavInteractive) setView('wslHealth')
            }}
            className={iconBtn(view === 'wslHealth')}
            title="WSL"
            disabled={!wslNavInteractive}
            tabIndex={wslNavInteractive ? 0 : -1}
            aria-hidden={!wslNavInteractive}
          >
            <TerminalIcon />
          </button>
        </div>
        <button
          onClick={() => setView('help')}
          className={`mt-1 ${iconBtn(view === 'help')}`}
          title="说明"
        >
          <HelpIcon />
        </button>
      </div>
    )
  }

  /* ---------- expanded ---------- */
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
  const navCls = (on: boolean): string =>
    `sidebar-tool-tab flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs ${
      on ? 'is-active glass-active text-zinc-100' : 'text-zinc-400'
    }`

  const handleSidebarPointerGlow = (event: PointerEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--tab-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--tab-y', `${event.clientY - rect.top}px`)
  }

  const renderSessionSnapshot = (snapshot: SessionListSnapshot): JSX.Element[] =>
    snapshot.groups.map((g) => (
      <div key={g.label} className="mb-2">
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/70">
          {g.label}
        </div>
        {g.items.map((s) => {
          const active = s.sessionId === snapshot.activeSessionId && view === 'chat'
          return (
            <div
              key={sessionKey(s)}
              className="group relative [content-visibility:auto] [contain-intrinsic-size:auto_44px]"
            >
              <div
                className={`sidebar-session-row relative w-full rounded-xl border px-2.5 py-2 text-left ${
                  active ? 'is-active glass-active text-zinc-100' : 'border-transparent text-zinc-400'
                }`}
              >
                {active && (
                  <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent" />
                )}
                <div className="truncate text-xs">{s.summary || '(未命名)'}</div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-600">
                  <span>{relTime(s.lastModified)}</span>
                  <span className={`session-runtime-badge ${snapshot.showRuntimeBadges ? 'is-visible' : ''}`}>
                    {backendLabel(s.runtimeBackend)}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    ))

  return (
    <div key="sidebar-expanded" className="sidebar-expand glass-sidebar flex w-64 shrink-0 flex-col rounded-[18px] border">
      {/* brand + collapse */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <div className="accent-soft-button flex h-8 w-8 items-center justify-center rounded-xl text-sm font-bold text-white">
          F
        </div>
        <div className="flex-1 text-sm font-semibold text-zinc-100">Forge</div>
        <button
          onClick={handleToggleSidebar}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
          title="收起侧边栏"
        >
          <ChevronIcon collapsed={false} />
        </button>
      </div>

      {/* project switcher + new chat + provider */}
      <div className="sidebar-deferred-content is-ready relative z-[70] space-y-3 px-4 pb-3.5 pt-2.5">
        <ProjectSwitcher collapsed={false} />
        <button
          onClick={() => {
            void newChat()
            setView('chat')
          }}
          className="accent-soft-button flex h-10 w-full items-center justify-center gap-2 rounded-[14px] px-3 text-sm font-medium text-white transition hover:brightness-110"
        >
          + 新建对话
        </button>
      </div>

      {/* session list label */}
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500/80">
          最近会话
        </span>
        <button
          onClick={startSessionRefreshTransition}
          className="rounded-md px-1 text-xs text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300"
          title="刷新"
        >
          ↻
        </button>
      </div>

      <div className="min-h-0 flex flex-1 flex-col">
        {/* grouped sessions */}
        <div className="space-y-2 px-4 pb-2 pt-1">
          <input
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="搜索会话"
            className="h-8 w-full rounded-lg border border-white/[0.08] bg-bg-elev/60 px-2.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-accent/60"
          />
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setBackendFilter('all')}
              className={`rounded-md px-1.5 py-1 text-[10px] transition ${
                backendFilter === 'all'
                  ? 'bg-accent/20 text-accent'
                  : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
              }`}
            >
              全部
            </button>
            <div className={`wsl-filter-options ${wslSupportEnabled ? 'is-visible' : ''}`}>
              {(['windows', 'wsl'] as ClaudeExecutionBackend[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setBackendFilter(value)}
                  className={`rounded-md px-1.5 py-1 text-[10px] transition ${
                    backendFilter === value
                      ? 'bg-accent/20 text-accent'
                      : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                  }`}
                  tabIndex={wslSupportEnabled ? 0 : -1}
                  aria-hidden={!wslSupportEnabled}
                >
                  {backendLabel(value)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setGroupMode((mode) => (mode === 'time' ? 'project' : 'time'))}
              className="ml-auto rounded-md px-1.5 py-1 text-[10px] text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300"
              title="切换分组"
            >
              {groupMode === 'time' ? '按时间' : '按项目'}
            </button>
          </div>
        </div>

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
        {!hideLiveSessionList && !hasAnimatedSessionRows && !loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">还没有对话。</div>
        )}
        {!hideLiveSessionList && !hasAnimatedSessionRows && !loading && sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">没有匹配的会话。</div>
        )}
        {groups.map((g, groupIndex) => (
          <div
            key={g.label}
            className="session-list-grow-group mb-2"
            style={{ '--session-grow-delay': `${Math.min(groupIndex * 28, 120)}ms` } as CSSProperties}
          >
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/70">
              {g.label}
            </div>
            {g.items.map((item, rowIndex) => {
              const s = item.session
              const key = sessionKey(s)
              const active = s.sessionId === meta.sdkSessionId && view === 'chat'
              const editing = editingId === key
              const confirming = confirmDeleteId === key
              const pinned = pinnedSessionKeys.has(key)
              const inserting = newlyInsertedSessionKeys.has(key)
              const exiting = item.exiting
              return (
                <div
                  key={key}
                  data-session-id={s.sessionId}
                  data-session-backend={s.runtimeBackend ?? 'windows'}
                  className={`session-row-shell group relative [content-visibility:auto] [contain-intrinsic-size:auto_44px] ${
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
                        void openSession(s.sessionId, s.runtimeBackend)
                        setView('chat')
                      }}
                      onPointerEnter={handleSidebarPointerGlow}
                      onPointerMove={handleSidebarPointerGlow}
                      className={`sidebar-session-row relative w-full rounded-xl border px-2.5 py-2 pr-20 text-left ${
                        active
                          ? 'is-active glass-active text-zinc-100'
                          : 'border-transparent text-zinc-400'
                      }`}
                      disabled={exiting}
                    >
                      {active && (
                        <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent" />
                      )}
                      <div className="truncate text-xs">{s.summary || '(未命名)'}</div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-600">
                        <span>{relTime(s.lastModified)}</span>
                        <span className={`session-runtime-badge ${wslSupportEnabled ? 'is-visible' : ''}`}>
                          {backendLabel(s.runtimeBackend)}
                        </span>
                      </div>
                    </button>
                  )}

                  {!editing && !exiting && (
                    <div
                      className={`absolute bottom-1 right-1 z-10 flex items-center gap-0.5 ${
                        confirming
                          ? 'pointer-events-auto opacity-100'
                          : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                      } transition-opacity duration-150`}
                    >
                      {confirming ? (
                        <>
                          <button
                            onClick={() => doDelete(key)}
                            className="rounded bg-red-950/80 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/80"
                          >
                            删除
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded bg-bg-elev/90 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-bg-hover"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              togglePinnedSession(s)
                            }}
                            className={`flex h-6 w-6 items-center justify-center overflow-hidden rounded-lg p-1 text-[11px] transition ${
                              pinned
                                ? 'text-accent hover:bg-white/[0.06]'
                                : 'text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200'
                            }`}
                            title={pinned ? '取消置顶' : '置顶'}
                          >
                            <PinIcon active={pinned} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingId(key)
                              setEditText(s.summary || '')
                            }}
                            className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                            title="重命名"
                          >
                            <EditIcon />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmDeleteId(key)
                            }}
                            className="rounded-lg p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
                            title="删除"
                          >
                            <TrashIcon />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {!hideLiveSessionList && sessions.length > 0 && (sessionsHasMore || loading) && (
          <div className="px-2 py-3 text-center text-[11px] text-zinc-600">
            继续下滑加载更多
          </div>
        )}
            </div>
          )}
        </div>
      </div>

      {/* footer nav — collapsible tool tabs */}
      <div className="sidebar-deferred-content is-ready px-3 pb-4 pt-2">
        <div className="glass-panel-soft rounded-2xl p-1.5">
          <button
            onClick={toggleNav}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[10px] font-medium uppercase tracking-wide text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300"
            title={navCollapsed ? '展开工具栏' : '收起工具栏'}
          >
            <span className="flex-1">工具</span>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              className={`shrink-0 text-zinc-500 transition-transform duration-300 ease-spring ${navCollapsed ? '-rotate-90' : ''}`}
            >
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* grid-rows 0fr↔1fr animates height without guessing a max-height;
              the inner overflow-hidden clips the rows mid-tween. The spring
              curve + per-item stagger give the non-linear pop. */}
          <Collapse open={!navCollapsed}>
            <div className="mt-1">
              {NAV_ITEMS.map((item, i) => {
                const on = view === item.view
                const isWslItem = item.view === 'wslHealth'
                const isProviderItem = item.view === 'providers'
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
                      '--sidebar-tab-stagger': navCollapsed ? '0ms' : `${i * 55}ms`,
                      opacity: navCollapsed ? 0 : 1,
                      transform: navCollapsed ? 'translateY(-6px)' : 'translateY(0)'
                    } as CSSProperties}
                    disabled={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav)}
                    tabIndex={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav) ? -1 : 0}
                    aria-hidden={(isWslItem && !wslNavInteractive) || (isProviderItem && !showProviderNav)}
                  >
                    <item.icon />
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
      </div>
    </div>
  )
}
