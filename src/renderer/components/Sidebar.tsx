import { useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function Sidebar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const sessions = useSessionStore((s) => s.sessions)
  const loading = useSessionStore((s) => s.sessionsLoading)
  const refresh = useSessionStore((s) => s.refreshSessions)
  const newChat = useSessionStore((s) => s.newChat)
  const openSession = useSessionStore((s) => s.openSession)

  useEffect(() => {
    void refresh()
  }, [refresh, meta?.cwd])

  if (!meta) return <></>
  const cwdName = meta.cwd.split(/[\\/]/).pop() ?? meta.cwd

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-panel">
      <div className="border-b border-border-subtle p-3">
        <button
          onClick={() => void newChat()}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          + New chat
        </button>
        <div className="mt-2 truncate px-1 text-[11px] text-zinc-500" title={meta.cwd}>
          {cwdName}
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-600">
          Recent
        </span>
        <button
          onClick={() => void refresh()}
          className="text-xs text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">Loading…</div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-3 text-xs text-zinc-600">No conversations yet.</div>
        )}
        {sessions.map((s) => {
          const active = s.sessionId === meta.sdkSessionId
          return (
            <button
              key={s.sessionId}
              onClick={() => void openSession(s.sessionId)}
              className={`mb-1 w-full rounded-lg px-2.5 py-2 text-left transition ${
                active
                  ? 'bg-bg-hover text-zinc-100'
                  : 'text-zinc-400 hover:bg-bg-hover/60 hover:text-zinc-200'
              }`}
            >
              <div className="truncate text-xs">{s.summary || '(untitled)'}</div>
              <div className="mt-0.5 text-[10px] text-zinc-600">{relTime(s.lastModified)}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
