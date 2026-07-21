import { memo, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** AskUserQuestion 决策卡片（对话流内、不打断；对齐 kimi web）：
 *  选项可切换选中态（单选 radio 式 / multiSelect 多选 checkbox 式），
 *  点"提交"才回传 optionId（多选受 ACP 单响应限制只回第一个选中项）。
 *  Skip（kind=reject 的选项）点击即答。提交后短暂只读已答态再收起。 */

const ANSWERED_DISMISS_MS = 1200

const ElicitationCard = memo(function ElicitationCard(): JSX.Element | null {
  const req = useSessionStore((s) => s.elicitationQueue[0] ?? null)
  const queueLen = useSessionStore((s) => s.elicitationQueue.length)
  const answerElicitation = useSessionStore((s) => s.answerElicitation)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [answered, setAnswered] = useState<string | null>(null)
  const dismissTimerRef = useRef<number | null>(null)

  // 切换到下一条问题时重置选择/已答态。
  useEffect(() => {
    setSelected(new Set())
    setAnswered(null)
  }, [req?.toolUseID])

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current)
    },
    []
  )

  if (!req) return null
  const multi = !!req.multiSelect

  const toggle = (optionId: string): void => {
    if (answered) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(optionId)) {
        next.delete(optionId)
      } else if (multi) {
        next.add(optionId)
      } else {
        next.clear()
        next.add(optionId)
      }
      return next
    })
  }

  const answer = (optionId: string): void => {
    if (answered) return
    setAnswered(optionId)
    dismissTimerRef.current = window.setTimeout(() => {
      void answerElicitation(req.toolUseID, optionId)
    }, ANSWERED_DISMISS_MS)
  }

  const submit = (): void => {
    // 多选降级：ACP 单响应只能回一个 optionId，回第一个选中项。
    const first = selected.values().next().value as string | undefined
    if (first) answer(first)
  }

  const primary = req.options.filter((o) => !(o.kind ?? '').startsWith('reject'))
  const skips = req.options.filter((o) => (o.kind ?? '').startsWith('reject'))

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-2">
      <div className="glass-panel tran-enter rounded-2xl border-accent/25 p-3.5">
        <div className="mb-2 flex items-start gap-2">
          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
          <div className="min-w-0 flex-1 text-sm font-medium text-zinc-100">{req.question}</div>
          {multi && <span className="shrink-0 text-[10px] text-zinc-500">可多选</span>}
          {queueLen > 1 && (
            <span className="shrink-0 text-[10px] text-zinc-500">还有 {queueLen - 1} 问</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {primary.map((option) => {
            const isSelected = answered ? answered === option.optionId : selected.has(option.optionId)
            return (
              <button
                key={option.optionId}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={isSelected}
                disabled={answered !== null}
                onClick={() => toggle(option.optionId)}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  isSelected
                    ? 'border-accent/60 bg-accent/20 text-accent'
                    : 'border-white/10 text-zinc-200 hover:border-accent/40 hover:bg-accent/10'
                } disabled:cursor-default ${answered && !isSelected ? 'opacity-50' : ''}`}
              >
                {isSelected && <span className="mr-1.5">✓</span>}
                {option.name}
              </button>
            )
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={answered !== null || selected.size === 0}
            onClick={submit}
            className="accent-soft-button rounded-lg px-4 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            提交
          </button>
          {skips.map((option) => (
            <button
              key={option.optionId}
              type="button"
              disabled={answered !== null}
              onClick={() => answer(option.optionId)}
              className={`rounded-lg px-3 py-1.5 text-[11px] transition ${
                answered === option.optionId
                  ? 'text-accent'
                  : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
              } disabled:cursor-default ${answered && answered !== option.optionId ? 'opacity-50' : ''}`}
            >
              {answered === option.optionId && <span className="mr-1">✓</span>}
              {option.name}
            </button>
          ))}
          {multi && (
            <span className="ml-auto text-[10px] text-zinc-600">多选题仅回传第一个选中项（协议限制）</span>
          )}
          {answered && <span className="ml-auto text-[10px] text-zinc-600">已选择，继续对话…</span>}
        </div>
      </div>
    </div>
  )
})

export default ElicitationCard
