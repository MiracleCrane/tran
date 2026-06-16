import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore, type View } from '../store/uiStore'
import Collapse from './Collapse'
import ProjectSwitcher from './ProjectSwitcher'
import type { Provider, SessionListItem } from '../../shared/ipc'

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
const SESSION_CACHE_IDLE_RELEASE_MS = 5_000
const SESSION_PREFETCH_RESUME_MS = 180
const SESSION_PREFETCH_FAST_SCROLL_PX_PER_MS = 1.15
const SESSION_LOAD_MORE_THRESHOLD_PX = 180

function bucketOf(ts: number): string {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= todayStart) return '今天'
  if (ts >= todayStart - DAY) return '昨天'
  if (ts >= todayStart - 7 * DAY) return '本周'
  return '更早'
}

function groupSessions(
  sessions: SessionListItem[]
): { label: string; items: SessionListItem[] }[] {
  const map = new Map<string, SessionListItem[]>()
  for (const s of sessions) {
    const b = bucketOf(s.lastModified)
    const arr = map.get(b)
    if (arr) arr.push(s)
    else map.set(b, [s])
  }
  return GROUP_ORDER.filter((b) => map.has(b)).map((label) => ({ label, items: map.get(label)! }))
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
  { view: 'settings', label: '设置', icon: GearIcon }
]

export default function Sidebar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const sessions = useSessionStore((s) => s.sessions)
  const loading = useSessionStore((s) => s.sessionsLoading)
  const sessionsHasMore = useSessionStore((s) => s.sessionsHasMore)
  const refresh = useSessionStore((s) => s.refreshSessions)
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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [sidebarContentReady, setSidebarContentReady] = useState(true)
  const sidebarReadyFrameRef = useRef<number | null>(null)
  const sidebarMotionTimeoutRef = useRef<number | null>(null)
  const sessionListRef = useRef<HTMLDivElement | null>(null)
  const visibleSessionIdsRef = useRef<Set<string>>(new Set())
  const pendingSessionPrefetchRef = useRef<Set<string>>(new Set())
  const prefetchPausedRef = useRef(false)
  const prefetchResumeTimeoutRef = useRef<number | null>(null)
  const lastSessionScrollRef = useRef({ top: 0, time: 0 })
  const sessionCacheReleaseTimeoutRef = useRef<number | null>(null)
  const firstSidebarPaintRef = useRef(true)
  const preparedSidebarMotionRef = useRef(false)

  useEffect(() => {
    void refresh()
  }, [refresh, meta?.cwd])

  // Re-read the active provider whenever a new session spawns (covers provider
  // switches, which restart the session → new bridge id).
  useEffect(() => {
    void window.api.getActiveProvider().then(setActiveProvider)
  }, [meta?.sessionId])

  const clearSidebarMotionTimers = (): void => {
    if (sidebarReadyFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarReadyFrameRef.current)
      sidebarReadyFrameRef.current = null
    }
    if (sidebarMotionTimeoutRef.current !== null) {
      window.clearTimeout(sidebarMotionTimeoutRef.current)
      sidebarMotionTimeoutRef.current = null
    }
  }

  const prepareSidebarMotion = (): void => {
    clearSidebarMotionTimers()
    document.documentElement.classList.add('sidebar-motion')
    setSidebarContentReady(false)
    sidebarReadyFrameRef.current = window.requestAnimationFrame(() => {
      sidebarReadyFrameRef.current = window.requestAnimationFrame(() => {
        sidebarReadyFrameRef.current = null
        setSidebarContentReady(true)
      })
    })
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

  const warmSessionWhenAllowed = (sessionId: string): void => {
    visibleSessionIdsRef.current.add(sessionId)
    if (prefetchPausedRef.current) {
      pendingSessionPrefetchRef.current.add(sessionId)
      return
    }
    void prefetchSessionHistory(sessionId)
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
      clearSessionCacheReleaseTimer()
      clearPrefetchResumeTimer()
      document.documentElement.classList.remove('sidebar-motion')
    }
  }, [])

  const commitEdit = (): void => {
    if (editingId && editText.trim()) void renameSession(editingId, editText)
    setEditingId(null)
  }
  const doDelete = (id: string): void => {
    setConfirmDeleteId(null)
    void deleteSession(id)
  }

  const sessionGroups = useMemo(() => groupSessions(sessions), [sessions])

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
          if (!sessionId) continue
          if (entry.isIntersecting) warmSessionWhenAllowed(sessionId)
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
        if (!sessionId) continue
        const rect = row.getBoundingClientRect()
        if (rect.bottom >= top && rect.top <= bottom) warmSessionWhenAllowed(sessionId)
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

  /* ---------- collapsed: icon rail ---------- */
  if (collapsed) {
    const iconBtn = (on: boolean): string =>
      `flex h-9 w-9 items-center justify-center rounded-xl transition ${
        on ? 'glass-active text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
      }`
    return (
      <div key="sidebar-collapsed" className="sidebar-collapse glass-sidebar flex w-14 shrink-0 flex-col items-center rounded-[18px] border py-3">
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
          {sidebarContentReady ? (
            <ProjectSwitcher collapsed />
          ) : (
            <div className="h-9 w-9 rounded-xl bg-white/[0.035]" />
          )}
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
        {activeProvider && (
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
        <button
          onClick={() => setView('providers')}
          className={`mt-1 ${iconBtn(view === 'providers')}`}
          title="运营商"
        >
          <ShieldIcon />
        </button>
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
      </div>
    )
  }

  /* ---------- expanded ---------- */
  const groups = sessionGroups
  const navCls = (on: boolean): string =>
    `sidebar-tool-tab flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs ${
      on ? 'is-active glass-active text-zinc-100' : 'text-zinc-400'
    }`

  const handleSidebarPointerGlow = (event: PointerEvent<HTMLButtonElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--tab-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--tab-y', `${event.clientY - rect.top}px`)
  }

  return (
    <div key="sidebar-expanded" className="sidebar-expand glass-sidebar flex w-64 shrink-0 flex-col rounded-[18px] border">
      {/* brand + collapse */}
      <div className="flex items-center gap-2 px-4 pt-4">
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
      <div
        className={`sidebar-deferred-content space-y-3 px-4 pb-4 pt-3.5 ${
          sidebarContentReady ? 'is-ready' : ''
        }`}
      >
        {sidebarContentReady ? (
          <>
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
          </>
        ) : (
          <>
            <div className="h-8 rounded-xl bg-white/[0.035]" />
            <div className="h-10 rounded-[14px] bg-white/[0.04]" />
          </>
        )}
      </div>

      {/* session list label */}
      <div className="flex items-center justify-between px-4 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500/80">
          最近会话
        </span>
        <button
          onClick={() => void refresh()}
          className="rounded-md px-1 text-xs text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-300"
          title="刷新"
        >
          ↻
        </button>
      </div>

      {/* grouped sessions */}
      <div
        ref={sessionListRef}
        onScroll={handleSessionListScroll}
        className={`sidebar-deferred-content min-h-0 flex-1 overflow-y-auto px-3 pb-3 ${
          sidebarContentReady ? 'is-ready' : ''
        }`}
      >
        {loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">加载中…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">还没有对话。</div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/70">
              {g.label}
            </div>
            {g.items.map((s) => {
              const active = s.sessionId === meta.sdkSessionId && view === 'chat'
              const editing = editingId === s.sessionId
              const confirming = confirmDeleteId === s.sessionId
              return (
                <div
                  key={s.sessionId}
                  data-session-id={s.sessionId}
                  className="group relative [content-visibility:auto] [contain-intrinsic-size:auto_44px]"
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
                        void openSession(s.sessionId)
                        setView('chat')
                      }}
                      onPointerEnter={handleSidebarPointerGlow}
                      onPointerMove={handleSidebarPointerGlow}
                      className={`sidebar-session-row relative w-full rounded-xl border px-2.5 py-2 text-left ${
                        active
                          ? 'is-active glass-active text-zinc-100'
                          : 'border-transparent text-zinc-400'
                      }`}
                    >
                      {active && (
                        <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent" />
                      )}
                      <div className="truncate text-xs">{s.summary || '(未命名)'}</div>
                      <div className="mt-0.5 text-[10px] text-zinc-600">{relTime(s.lastModified)}</div>
                    </button>
                  )}

                  {!editing && (
                    <div
                      className={`absolute right-1 top-1 flex items-center gap-0.5 ${
                        confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      } transition`}
                    >
                      {confirming ? (
                        <>
                          <button
                            onClick={() => doDelete(s.sessionId)}
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
                              setEditingId(s.sessionId)
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
                              setConfirmDeleteId(s.sessionId)
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
        {sessions.length > 0 && (sessionsHasMore || loading) && (
          <div className="px-2 py-3 text-center text-[11px] text-zinc-600">
            {loading ? '加载更多会话中...' : '继续下滑加载更多'}
          </div>
        )}
      </div>

      {/* footer nav — collapsible tool tabs */}
      <div
        className={`sidebar-deferred-content px-3 pb-4 pt-2 ${
          sidebarContentReady ? 'is-ready' : ''
        }`}
      >
        {!sidebarContentReady ? (
          <div className="glass-panel-soft h-12 rounded-2xl p-1.5" />
        ) : (
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
                return (
                  <button
                    key={item.view}
                    onClick={() => setView(on ? 'chat' : item.view)}
                    onPointerEnter={handleSidebarPointerGlow}
                    onPointerMove={handleSidebarPointerGlow}
                    className={`${navCls(on)} ${i > 0 ? 'mt-1' : ''}`}
                    style={{
                      '--sidebar-tab-stagger': navCollapsed ? '0ms' : `${i * 55}ms`,
                      opacity: navCollapsed ? 0 : 1,
                      transform: navCollapsed ? 'translateY(-6px)' : 'translateY(0)'
                    } as CSSProperties}
                  >
                    <item.icon />
                    {item.label}
                  </button>
                )
              })}
            </div>
          </Collapse>
        </div>
        )}
      </div>
    </div>
  )
}
