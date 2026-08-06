import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../store/sessionStore'
import { relTime } from '../utils/format'
import { onForgeEvent } from '../events'

/**
 * 会话搜索面板（Codex「搜索聊天」同款形态，2026-08 用户点名要学）：
 * 居中浮层、顶部搜索框、下面是会话列表，键盘 ↑↓ 选择、Enter 进入、Esc 关闭。
 * 侧栏里那个常驻搜索输入框已由它取代——入口是「最近会话」行的搜索图标
 * 或 Ctrl+K（shortcuts.ts），两处都发 forge:open-session-search。
 */

const MAX_RESULTS = 8

export default function SessionSearchPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const sessions = useSessionStore((s) => s.sessions)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      onForgeEvent('openSessionSearch', () => {
        setQuery('')
        setActive(0)
        setOpen(true)
      }),
    []
  )

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? sessions.filter((s) =>
          [s.summary, s.cwd, s.gitBranch]
            .filter(Boolean)
            .join('\n')
            .toLowerCase()
            .includes(q)
        )
      : sessions
    return filtered.slice(0, MAX_RESULTS)
  }, [sessions, query])

  if (!open) return null

  const choose = (index: number): void => {
    const target = results[index]
    if (!target) return
    void useSessionStore
      .getState()
      .openSessionCrossProject(target.sessionId, target.cwd ?? '', target.runtimeBackend)
    setOpen(false)
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-black/50 pt-[14vh]"
      onPointerDown={() => setOpen(false)}
    >
      <div
        className="glass-panel w-[36rem] max-w-[90vw] rounded-2xl p-2 shadow-2xl"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
            else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((a) => Math.min(a + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (event.key === 'Enter') choose(active)
          }}
          placeholder="搜索会话"
          spellCheck={false}
          className="h-9 w-full rounded-xl border border-white/[0.08] bg-bg-elev/60 px-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-accent/60"
        />
        <div className="mt-1 max-h-80 overflow-y-auto">
          {results.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-600">没有匹配的会话</div>
          )}
          {results.map((s, i) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => choose(i)}
              onPointerEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition ${
                i === active ? 'bg-white/[0.06]' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-zinc-200">{s.summary || '(未命名)'}</span>
                <span className="block truncate text-[10px] text-zinc-600">{s.cwd}</span>
              </span>
              <span className="shrink-0 text-[10px] text-zinc-600">{relTime(s.lastModified)}</span>
            </button>
          ))}
        </div>
        <div className="mt-1 border-t border-white/[0.06] pt-1">
          <div className="px-3 pb-0.5 pt-1 text-[10px] text-zinc-600">推荐</div>
          <button
            type="button"
            onClick={() => {
              void useSessionStore.getState().newChat()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06]"
          >
            ＋ 新对话
            <span className="ml-auto text-[10px] text-zinc-600">Ctrl+N</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
