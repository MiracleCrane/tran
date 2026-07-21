import { memo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { GoalControlAction, GoalStatus } from '../../shared/ipc'
import ConfirmDialog from './ConfirmDialog'

/** 目标卡片（goal 循环）：目标文本（两行截断可展开）+ 状态徽章 + 进度 x/y
 *  + 暂停/继续/停止按钮。挂在对话区顶部（PlanCard 旁）。 */

const STATUS_META: Record<GoalStatus, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'bg-accent/15 text-accent' },
  paused: { label: '已暂停', cls: 'bg-white/[0.08] text-zinc-400' },
  blocked: { label: '已阻塞', cls: 'bg-red-950/60 text-red-300' },
  complete: { label: '已完成', cls: 'bg-green-950/60 text-green-400' }
}

const GoalIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 12h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

const GoalCard = memo(function GoalCard(): JSX.Element | null {
  const goal = useSessionStore((s) => s.goal)
  const meta = useSessionStore((s) => s.meta)
  const [expanded, setExpanded] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  if (!goal || !meta) return null

  const control = (action: GoalControlAction): void => {
    void window.api.goalControl(meta.sessionId, action).catch(() => {})
  }
  const statusMeta = STATUS_META[goal.status]

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-3">
      <div className="tool-call-card overflow-hidden rounded-lg border border-accent/30 bg-[#101116]">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="shrink-0 text-accent">
            <GoalIcon />
          </span>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className={`min-w-0 flex-1 text-left text-xs text-zinc-200 ${
              expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'
            }`}
            title={expanded ? '收起' : '展开目标全文'}
          >
            {goal.objective}
          </button>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.cls}`}>
            {statusMeta.label}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
            轮次 {goal.turnCount}/{goal.maxTurns}
          </span>
          {goal.status === 'active' && (
            <button
              type="button"
              onClick={() => control('pause')}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200"
            >
              暂停
            </button>
          )}
          {(goal.status === 'paused' || goal.status === 'blocked') && (
            <button
              type="button"
              onClick={() => control('resume')}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-accent transition hover:bg-accent/10"
            >
              继续
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmStop(true)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
          >
            停止
          </button>
        </div>
        {goal.blockedReason && goal.status !== 'active' && (
          <div className="border-t border-border-subtle px-3 py-1.5 text-[11px] text-zinc-500">
            {goal.blockedReason}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmStop}
        danger
        title="停止目标"
        message="停止并清除该目标？循环将立即终止。"
        confirmLabel="停止"
        onConfirm={() => {
          setConfirmStop(false)
          control('stop')
        }}
        onCancel={() => setConfirmStop(false)}
      />
    </div>
  )
})

export default GoalCard
