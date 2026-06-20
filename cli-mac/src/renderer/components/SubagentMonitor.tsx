import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { historyToItems } from '../store/sessionStore'
import type { SubagentTask, TranscriptItem } from '../types'

const STATUS_META: Record<SubagentTask['status'], { label: string; dot: string; text: string }> = {
  running: { label: '运行中', dot: 'bg-emerald-500 animate-pulse', text: 'text-emerald-400' },
  completed: { label: '已完成', dot: 'bg-zinc-500', text: 'text-zinc-400' },
  failed: { label: '失败', dot: 'bg-red-500', text: 'text-red-400' },
  stopped: { label: '已停止', dot: 'bg-orange-500', text: 'text-orange-400' }
}

function fmtTokens(n?: number): string {
  if (n == null) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
function fmtDuration(ms?: number): string {
  if (ms == null) return ''
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

/** First useful identifier from a tool's input (command / path / pattern / url…). */
function toolDetail(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  if (name === 'Bash' && typeof o.command === 'string') return o.command
  for (const k of ['file_path', 'pattern', 'url', 'query', 'description']) {
    if (typeof o[k] === 'string') return o[k] as string
  }
  return ''
}

/** A lightweight renderer for a subagent's transcript (text + compact tool rows).
 *  Kept simple — the main Transcript components aren't reused to avoid coupling. */
function SubagentConversation({ items }: { items: TranscriptItem[] }): JSX.Element {
  if (items.length === 0) {
    return <div className="px-3 py-6 text-center text-xs text-zinc-600">暂无会话记录。</div>
  }
  return (
    <div className="space-y-2">
      {items.map((it) => {
        if (it.kind === 'user') {
          return (
            <div key={it.id} className="rounded-lg border border-border-subtle/60 bg-bg-elev px-2.5 py-1.5">
              <div className="whitespace-pre-wrap break-words text-[11px] text-zinc-400">
                {it.text}
              </div>
            </div>
          )
        }
        return (
          <div key={it.id} className="space-y-1">
            {it.blocks.map((b, i) => {
              if (b.kind === 'text' && b.text.trim()) {
                return (
                  <div key={i} className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-300">
                    {b.text}
                  </div>
                )
              }
              if (b.kind === 'thinking' && b.text.trim()) {
                return (
                  <details key={i} className="rounded bg-bg-elev/50 px-2 py-1">
                    <summary className="cursor-pointer text-[10px] text-zinc-600">思考</summary>
                    <div className="mt-1 whitespace-pre-wrap text-[10px] text-zinc-600">{b.text}</div>
                  </details>
                )
              }
              if (b.kind === 'tool') {
                const detail = toolDetail(b.name, b.input)
                return (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded bg-bg-elev/60 px-2 py-1 font-mono text-[10px] text-zinc-500"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        b.status === 'running'
                          ? 'bg-blue-400 animate-pulse'
                          : b.status === 'done'
                            ? 'bg-green-500'
                            : b.status === 'error'
                              ? 'bg-red-500'
                              : 'bg-zinc-600'
                      }`}
                    />
                    <span className="text-zinc-400">{b.name}</span>
                    {detail && <span className="truncate">{detail}</span>}
                  </div>
                )
              }
              return null
            })}
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  onClose: () => void
}

export default function SubagentMonitor({ onClose }: Props): JSX.Element {
  const tasks = useSessionStore((s) => s.tasks)
  const meta = useSessionStore((s) => s.meta)
  const backgroundTask = useSessionStore((s) => s.backgroundTask)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [loading, setLoading] = useState(false)

  const selected = tasks.find((t) => t.taskId === selectedId) ?? null

  const fetchConversation = useCallback(async (): Promise<void> => {
    if (!meta || !selectedId) return
    setLoading(true)
    try {
      const msgs = await window.api.getSubagentMessages(meta.sdkSessionId ?? meta.sessionId, selectedId, meta.cwd)
      setItems(historyToItems(msgs))
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [meta, selectedId])

  // Load on select; poll while the subagent is still running.
  useEffect(() => {
    if (!selectedId) {
      setItems([])
      return
    }
    void fetchConversation()
    if (!selected || selected.status !== 'running') return
    const t = setInterval(() => void fetchConversation(), 1500)
    return () => clearInterval(t)
  }, [selectedId, selected?.status, fetchConversation])

  return (
    <>
      {/* outside-click catcher */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="liquid-float-in fixed bottom-9 left-6 z-50 flex max-h-[60vh] w-96 flex-col overflow-hidden rounded-xl border border-border-subtle bg-[#101116] shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border-subtle bg-[#14151b] px-3 py-2">
          {selected ? (
            <>
              <button
                onClick={() => setSelectedId(null)}
                className="rounded px-1 text-xs text-zinc-400 hover:bg-bg-hover hover:text-zinc-200"
              >
                ←
              </button>
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span className="flex-1 truncate text-xs font-medium text-zinc-100">
                {selected.description || selected.subagentType || '子代理'}
              </span>
              <span className={`text-[10px] ${STATUS_META[selected.status].text}`}>
                {STATUS_META[selected.status].label}
              </span>
            </>
          ) : (
            <>
              <span className="text-xs font-medium text-zinc-100">子代理</span>
              <span className="text-[10px] text-zinc-500">
                {tasks.filter((t) => t.status === 'running').length} 运行中 · {tasks.length} 总计
              </span>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {selected ? (
            loading && items.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">加载中…</div>
            ) : (
              <SubagentConversation items={items} />
            )
          ) : tasks.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-600">暂无子代理。</div>
          ) : (
            <div className="space-y-1">
              {tasks.map((t) => {
                const m = STATUS_META[t.status]
                return (
                  <div
                    key={t.taskId}
                    onClick={() => setSelectedId(t.taskId)}
                    className="w-full cursor-pointer rounded-lg px-2.5 py-2 transition hover:bg-bg-hover"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${m.dot}`} />
                      <span className="flex-1 truncate text-xs font-medium text-zinc-200">
                        {t.description || '(无描述)'}
                      </span>
                      {t.isBackgrounded && (
                        <span className="shrink-0 rounded bg-sky-950/50 px-1 py-0.5 text-[9px] text-sky-300">
                          后台
                        </span>
                      )}
                      <span className={`shrink-0 text-[10px] ${m.text}`}>{m.label}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-[10px] text-zinc-600">
                      {t.subagentType && <span className="rounded bg-bg-elev px-1 py-0.5">{t.subagentType}</span>}
                      {t.tokens != null && <span>{fmtTokens(t.tokens)} tok</span>}
                      {t.toolUses != null && <span>· {t.toolUses} 工具</span>}
                      {t.durationMs != null && <span>· {fmtDuration(t.durationMs)}</span>}
                      {t.lastToolName && <span className="truncate">· {t.lastToolName}</span>}
                      {t.status === 'running' && !t.isBackgrounded && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void backgroundTask(t.taskId)
                          }}
                          className="ml-auto rounded border border-border-subtle bg-bg-elev px-2 py-0.5 text-[10px] text-zinc-300 transition hover:bg-bg-hover hover:text-zinc-100"
                          title="转入后台,释放主会话以便继续对话"
                        >
                          转入后台
                        </button>
                      )}
                    </div>
                    {t.summary && t.status !== 'running' && (
                      <div className="mt-1 pl-4 text-[10px] text-zinc-500">{t.summary}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
