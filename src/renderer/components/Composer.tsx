import { useEffect, useState, type KeyboardEvent } from 'react'
import { useSessionStore } from '../store/sessionStore'

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

  // Override the built-in model list with the user's configured list (Settings).
  useEffect(() => {
    void window.api.getPreferences().then((p) => {
      if (p.composerModels && p.composerModels.length) setModels(p.composerModels)
    })
  }, [])

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || running) return
    setText('')
    await sendMessage(value)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="border-t border-border-subtle bg-bg-panel px-6 py-3">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder={
              starting
                ? '正在启动会话…'
                : running
                  ? 'Claude 正在处理…(点击「停止」可中断)'
                  : '给 Claude 发消息…'
            }
            className="max-h-40 min-h-[44px] flex-1 resize-none rounded-xl border border-border-subtle bg-bg-elev px-3.5 py-2.5 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-accent"
          />
          {running ? (
            <button
              onClick={() => void interrupt()}
              className="h-[44px] shrink-0 rounded-xl border border-red-900/60 bg-red-950/40 px-4 text-sm font-medium text-red-300 hover:bg-red-950/60"
            >
              停止
            </button>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!text.trim()}
              className="h-[44px] shrink-0 rounded-xl bg-accent px-5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              发送
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-600">
          <span>
            <kbd className="font-sans">Enter</kbd> 发送 · <kbd className="font-sans">Shift+Enter</kbd> 换行
          </span>
          {meta && (
            <select
              value={meta.model}
              onChange={(e) => void setModel(e.target.value)}
              className="ml-auto rounded border border-border-subtle bg-bg-elev px-2 py-0.5 text-[11px] text-zinc-400 outline-none"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  )
}
