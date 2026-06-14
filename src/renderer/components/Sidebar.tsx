import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
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

export default function Sidebar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const sessions = useSessionStore((s) => s.sessions)
  const loading = useSessionStore((s) => s.sessionsLoading)
  const refresh = useSessionStore((s) => s.refreshSessions)
  const newChat = useSessionStore((s) => s.newChat)
  const openSession = useSessionStore((s) => s.openSession)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)

  const [activeProvider, setActiveProvider] = useState<Provider | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh, meta?.cwd])

  // Re-read the active provider whenever a new session spawns (covers provider
  // switches, which restart the session → new bridge id).
  useEffect(() => {
    void window.api.getActiveProvider().then(setActiveProvider)
  }, [meta?.sessionId])

  const commitEdit = (): void => {
    if (editingId && editText.trim()) void renameSession(editingId, editText)
    setEditingId(null)
  }
  const doDelete = (id: string): void => {
    setConfirmDeleteId(null)
    void deleteSession(id)
  }

  if (!meta) return <></>

  /* ---------- collapsed: icon rail ---------- */
  if (collapsed) {
    const iconBtn = (on: boolean): string =>
      `flex h-9 w-9 items-center justify-center rounded-lg transition ${
        on ? 'bg-bg-hover text-zinc-100' : 'text-zinc-400 hover:bg-bg-hover/60 hover:text-zinc-200'
      }`
    return (
      <div className="flex w-14 shrink-0 flex-col items-center border-r border-border-subtle bg-bg-panel py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">
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
          className="mt-2 flex h-9 w-9 items-center justify-center rounded-lg bg-bg-elev text-zinc-300 transition hover:bg-bg-hover"
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
          onClick={() => setView('providers')}
          className={`mt-1 ${iconBtn(view === 'providers')}`}
          title="运营商"
        >
          <ShieldIcon />
        </button>
        <button
          onClick={() => setView('mcp')}
          className={`mt-1 ${iconBtn(view === 'mcp')}`}
          title="MCP 服务器"
        >
          <McpIcon />
        </button>
        <button
          onClick={() => setView('settings')}
          className={`mt-1 ${iconBtn(view === 'settings')}`}
          title="设置"
        >
          <GearIcon />
        </button>
        <button
          onClick={toggleSidebar}
          className={`mt-1 ${iconBtn(false)}`}
          title="展开侧边栏"
        >
          <ChevronIcon collapsed />
        </button>
      </div>
    )
  }

  /* ---------- expanded ---------- */
  const groups = groupSessions(sessions)
  const navCls = (on: boolean): string =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
      on ? 'bg-bg-hover text-zinc-100' : 'text-zinc-400 hover:bg-bg-hover/60 hover:text-zinc-200'
    }`

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-panel">
      {/* brand + collapse */}
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">
          F
        </div>
        <div className="flex-1 text-sm font-semibold text-zinc-100">Forge</div>
        <button
          onClick={toggleSidebar}
          className="rounded-md p-1 text-zinc-500 transition hover:bg-bg-hover hover:text-zinc-300"
          title="收起侧边栏"
        >
          <ChevronIcon collapsed={false} />
        </button>
      </div>

      {/* project switcher + new chat + provider */}
      <div className="space-y-2 px-3 pb-2 pt-2">
        <ProjectSwitcher collapsed={false} />
        <button
          onClick={() => {
            void newChat()
            setView('chat')
          }}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          + 新建对话
        </button>
        {activeProvider && (
          <button
            onClick={() => setView('providers')}
            className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-elev px-2.5 py-1.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover"
            title="切换运营商"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">{activeProvider.name || activeProvider.baseUrl}</span>
            <span className="ml-auto shrink-0 font-mono text-zinc-500">{activeProvider.model}</span>
          </button>
        )}
      </div>

      {/* session list label */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">
          最近会话
        </span>
        <button
          onClick={() => void refresh()}
          className="text-xs text-zinc-500 transition hover:text-zinc-300"
          title="刷新"
        >
          ↻
        </button>
      </div>

      {/* grouped sessions */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">加载中…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">还没有对话。</div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
              {g.label}
            </div>
            {g.items.map((s) => {
              const active = s.sessionId === meta.sdkSessionId && view === 'chat'
              const editing = editingId === s.sessionId
              const confirming = confirmDeleteId === s.sessionId
              return (
                <div key={s.sessionId} className="group relative">
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
                      className="w-full rounded-lg border border-accent bg-bg-elev px-2.5 py-2 text-xs text-zinc-100 outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        void openSession(s.sessionId)
                        setView('chat')
                      }}
                      className={`relative w-full rounded-lg px-2.5 py-2 text-left transition ${
                        active
                          ? 'bg-bg-hover text-zinc-100'
                          : 'text-zinc-400 hover:bg-bg-hover/60 hover:text-zinc-200'
                      }`}
                    >
                      {active && (
                        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
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
                            className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-bg-hover"
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
                            className="rounded p-1 text-zinc-500 transition hover:bg-bg-hover hover:text-zinc-200"
                            title="重命名"
                          >
                            <EditIcon />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmDeleteId(s.sessionId)
                            }}
                            className="rounded p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
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
      </div>

      {/* footer nav */}
      <div className="border-t border-border-subtle p-2">
        <button onClick={() => setView(view === 'skills' ? 'chat' : 'skills')} className={navCls(view === 'skills')}>
          <SkillsIcon />
          技能
        </button>
        <button onClick={() => setView(view === 'providers' ? 'chat' : 'providers')} className={`mt-1 ${navCls(view === 'providers')}`}>
          <ShieldIcon />
          运营商
        </button>
        <button
          onClick={() => setView(view === 'mcp' ? 'chat' : 'mcp')}
          className={`mt-1 ${navCls(view === 'mcp')}`}
        >
          <McpIcon />
          MCP 服务器
        </button>
        <button
          onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
          className={`mt-1 ${navCls(view === 'settings')}`}
        >
          <GearIcon />
          设置
        </button>
      </div>
    </div>
  )
}
