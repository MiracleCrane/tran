import { useEffect, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PickedFile } from '../../shared/ipc'

const DEFAULT_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

export default function Composer(): JSX.Element {
  const running = useSessionStore((s) => s.status.running)
  const starting = useSessionStore((s) => s.starting)
  const meta = useSessionStore((s) => s.meta)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const interrupt = useSessionStore((s) => s.interrupt)
  const setModel = useSessionStore((s) => s.setModel)
  const [text, setText] = useState('')
  const [models, setModels] = useState(DEFAULT_MODELS)
  const [modelOpen, setModelOpen] = useState(false)
  const [attachments, setAttachments] = useState<PickedFile[]>([])

  // Override the built-in model list with the user's configured list (Settings).
  useEffect(() => {
    void window.api.getPreferences().then((p) => {
      if (p.composerModels && p.composerModels.length) setModels(p.composerModels)
    })
  }, [])

  const pickAttachment = async (): Promise<void> => {
    if (!meta) return
    const files = await window.api.pickFiles(meta.cwd)
    if (files.length) setAttachments((prev) => [...prev, ...files])
  }

  const removeAttachment = (i: number): void =>
    setAttachments((prev) => prev.filter((_, idx) => idx !== i))

  const submit = async (): Promise<void> => {
    const value = text.trim()
    const atts = attachments
    if (!value && atts.length === 0) return
    setText('')
    setAttachments([])
    await sendMessage(value, atts.length ? atts : undefined)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const closeModelMenuOnBlur = (e: FocusEvent<HTMLDivElement>): void => {
    const next = e.relatedTarget
    if (!(next instanceof Node) || !e.currentTarget.contains(next)) {
      setModelOpen(false)
    }
  }

  const selectedModel = models.find((m) => m.id === meta?.model) ?? null

  return (
    <div className="bg-transparent px-6 pb-3 pt-2">
      <div className="mx-auto max-w-5xl">
        <div className="glass-panel overflow-visible rounded-[18px] p-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder={
              starting
                ? '正在启动会话…'
                : running
                  ? 'Claude 正在处理…(可继续发送,消息会排队)'
                  : '给 Claude 发消息…'
            }
            className="max-h-40 min-h-[64px] w-full resize-none rounded-xl border border-transparent bg-transparent px-3 py-2 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-white/10 focus:bg-white/[0.025]"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pt-2">
              {attachments.map((a, i) => (
                <span
                  key={`${a.path}-${i}`}
                  className="glass-control flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-zinc-300"
                  title={a.path}
                >
                  <span className="text-zinc-500">{a.kind === 'image' ? '🖼' : a.kind === 'text' ? '📄' : '📎'}</span>
                  <span className="max-w-[12rem] truncate">{a.name}</span>
                  <button
                    onClick={() => removeAttachment(i)}
                    className="text-zinc-500 transition hover:text-red-300"
                    title="移除"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 px-1 pt-2">
            <button
              type="button"
              onClick={() => void pickAttachment()}
              disabled={!meta}
              className="glass-control flex h-9 w-9 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/[0.09] disabled:opacity-40"
              title="添加附件(从工作目录选择文件)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.8-8.8a3.5 3.5 0 0 1 5 5L10.4 18a2 2 0 0 1-2.8-2.8l7.7-7.7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <span className="px-2 text-[11px] text-zinc-500">
              <kbd className="font-sans text-zinc-400">Enter</kbd> 发送 ·{' '}
              <kbd className="font-sans text-zinc-400">Shift+Enter</kbd> 换行
            </span>
            <div className="ml-auto flex items-center gap-2">
              {meta && (
                <div
                  className="relative"
                  onBlur={closeModelMenuOnBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setModelOpen(false)
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setModelOpen((open) => !open)}
                    className="glass-control flex h-10 min-w-36 items-center gap-2 rounded-xl px-3 text-left text-xs text-zinc-200 transition hover:bg-white/[0.09]"
                    aria-haspopup="listbox"
                    aria-expanded={modelOpen}
                  >
                    <span className="flex-1 truncate">{selectedModel?.label ?? meta.model}</span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      className={`shrink-0 text-zinc-500 transition ${modelOpen ? 'rotate-180' : ''}`}
                    >
                      <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {modelOpen && (
                    <div
                      role="listbox"
                      className="glass-panel absolute bottom-full right-0 z-50 mb-2 w-48 overflow-hidden rounded-2xl p-1"
                    >
                      {models.map((m) => {
                        const active = m.id === meta.model
                        return (
                          <button
                            key={m.id}
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              setModelOpen(false)
                              void setModel(m.id)
                            }}
                            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition ${
                              active
                                ? 'bg-white/[0.1] text-zinc-100'
                                : 'text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                active ? 'bg-accent' : 'bg-transparent'
                              }`}
                            />
                            <span className="truncate">{m.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {running && (
                <button
                  onClick={() => void interrupt()}
                  className="h-10 shrink-0 rounded-xl border border-red-900/60 bg-red-950/40 px-4 text-sm font-medium text-red-300 hover:bg-red-950/60"
                  title="中断当前处理"
                >
                  停止
                </button>
              )}
              <button
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                className="accent-soft-button h-10 shrink-0 rounded-xl px-5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
