import { memo, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** AskUserQuestion 决策卡片（对话流内、不打断）：问题 + 竖排选项按钮组 +
 *  Skip 副按钮；回答后短暂显示已选项（只读态）再自动收起。
 *  optionId 原样回传（不经 allow/deny 模糊匹配）。 */

const ANSWERED_DISMISS_MS = 1200

const ElicitationCard = memo(function ElicitationCard(): JSX.Element | null {
  const req = useSessionStore((s) => s.elicitationQueue[0] ?? null)
  const queueLen = useSessionStore((s) => s.elicitationQueue.length)
  const answerElicitation = useSessionStore((s) => s.answerElicitation)
  const [answered, setAnswered] = useState<string | null>(null)
  const dismissTimerRef = useRef<number | null>(null)

  // 切换到下一条问题时重置已答态。
  useEffect(() => {
    setAnswered(null)
  }, [req?.toolUseID])

  useEffect(
    () => () => {
      if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current)
    },
    []
  )

  if (!req) return null

  const choose = (optionId: string): void => {
    if (answered) return
    setAnswered(optionId)
    dismissTimerRef.current = window.setTimeout(() => {
      void answerElicitation(req.toolUseID, optionId)
    }, ANSWERED_DISMISS_MS)
  }

  // Skip 类选项（kind 为 reject*）渲染为 secondary 副按钮，其余为主选项竖排。
  const primary = req.options.filter((o) => !(o.kind ?? '').startsWith('reject'))
  const skips = req.options.filter((o) => (o.kind ?? '').startsWith('reject'))

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pb-2">
      <div className="glass-panel tran-enter rounded-2xl border-accent/25 p-3.5">
        <div className="mb-2 flex items-start gap-2">
          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
          <div className="min-w-0 flex-1 text-sm font-medium text-zinc-100">{req.question}</div>
          {queueLen > 1 && (
            <span className="shrink-0 text-[10px] text-zinc-500">还有 {queueLen - 1} 问</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {primary.map((option) => {
            const selected = answered === option.optionId
            return (
              <button
                key={option.optionId}
                type="button"
                disabled={answered !== null}
                onClick={() => choose(option.optionId)}
                className={`rounded-xl border px-3 py-2 text-left text-xs transition ${
                  selected
                    ? 'border-accent/60 bg-accent/20 text-accent'
                    : 'border-white/10 text-zinc-200 hover:border-accent/40 hover:bg-accent/10'
                } disabled:cursor-default ${answered && !selected ? 'opacity-50' : ''}`}
              >
                {selected && <span className="mr-1.5">✓</span>}
                {option.name}
              </button>
            )
          })}
          {skips.map((option) => {
            const selected = answered === option.optionId
            return (
              <button
                key={option.optionId}
                type="button"
                disabled={answered !== null}
                onClick={() => choose(option.optionId)}
                className={`rounded-xl px-3 py-1.5 text-left text-[11px] transition ${
                  selected
                    ? 'text-accent'
                    : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300'
                } disabled:cursor-default ${answered && !selected ? 'opacity-50' : ''}`}
              >
                {selected && <span className="mr-1.5">✓</span>}
                {option.name}
              </button>
            )
          })}
        </div>
        {answered && <div className="mt-2 text-[10px] text-zinc-600">已选择，继续对话…</div>}
      </div>
    </div>
  )
})

export default ElicitationCard
