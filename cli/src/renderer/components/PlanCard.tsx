import { memo, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry } from '../types'
import Collapse from './Collapse'

/** 超过这个时长没更新就显示陈旧提示（待办是纯推送，没有补拉，旧快照看起来
 *  和当前状态一模一样——见 kimi 的设计：后台任务完成只在「下一轮」才注入）。 */
const PLAN_STALE_AFTER_MS = 90_000

function staleLabel(sinceMs: number): string {
  const min = Math.floor(sinceMs / 60000)
  if (min < 60) return `${min} 分钟前更新`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前更新`
  return `${Math.floor(hour / 24)} 天前更新`
}

const ListGlyph = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
)

/** 待办清单卡片：ACP plan 事件驱动，整体样式对齐 ToolCallCard 玻璃风。
 *  completed 打勾、in_progress 紫色高亮（优先显示 activeForm）。 */
const PlanCard = memo(function PlanCard(): JSX.Element | null {
  const entries = useSessionStore((s) => s.planEntries)
  const planUpdatedAt = useSessionStore((s) => s.planUpdatedAt)
  const running = useSessionStore((s) => s.status.running)
  const swarmTasks = useSessionStore((s) => s.swarmTasks)
  const [collapsed, setCollapsed] = useState(false)
  // 陈旧文案要随时间走，但待办本身不会再变——用一个低频 tick 驱动重算。
  const [, setTick] = useState(0)

  const hasUnfinished = entries.some((e) => e.status !== 'completed')
  useEffect(() => {
    if (!hasUnfinished || running) return
    const timer = window.setInterval(() => setTick((v) => v + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [hasUnfinished, running])

  if (entries.length === 0) return null

  const done = entries.filter((e) => e.status === 'completed').length
  const allDone = done === entries.length

  // 后台任务已收尾但待办还停在未完成 + 会话空闲 = agent 还不知道。
  // kimi 的后台任务完成通知只在「下一轮」注入（源码原文：
  // "The completion arrives automatically in a later turn."），所以在用户
  // 发下一条消息之前，待办物理上不可能自己更新。Tran 靠磁盘任务记录能比
  // agent 先知道，这里就是把这个时间差告诉用户。
  const settledBackgroundTask =
    !running &&
    hasUnfinished &&
    (swarmTasks ?? []).some((t) => {
      const status = (t.status ?? '').toLowerCase()
      return status === 'completed' || status === 'failed' || status === 'stopped'
    })

  const staleSince = planUpdatedAt === null ? 0 : Date.now() - planUpdatedAt
  const showStale = !running && hasUnfinished && planUpdatedAt !== null && staleSince >= PLAN_STALE_AFTER_MS

  const rowOf = (entry: PlanEntry, index: number): JSX.Element => {
    const active = entry.status === 'in_progress'
    const completed = entry.status === 'completed'
    return (
      // key 带状态：完成瞬间重挂载，打勾弹入 + 划线动画只播一次。
      <div key={`${index}-${entry.status}`} className="flex items-start gap-2 py-1">
        <span
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
            completed
              ? 'tran-check-pop border-green-500/60 bg-green-500/20 text-green-400'
              : active
                ? 'border-accent/70 bg-accent/25 text-accent'
                : 'border-white/20 text-transparent'
          }`}
        >
          {/* 与待办浮层（taskRows.PlanRow）同一枚 SVG 勾：文本字形在小圆圈里基线对不齐。 */}
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span
          className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${
            completed
              ? 'text-zinc-500'
              : active
                ? 'text-accent'
                : 'text-zinc-300'
          }`}
        >
          <span className={completed ? 'plan-strike' : undefined}>
            {active && entry.activeForm ? entry.activeForm : entry.content}
          </span>
        </span>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-3">
      {/* #44 与工具 bar 同宽（#9 统一 max-w-[92%] 时漏了待办条）。 */}
      <div className="tool-call-card max-w-[92%] overflow-hidden rounded-lg border border-accent/30 bg-[#101116]">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
        >
          <span className={`shrink-0 ${allDone ? 'text-green-400' : 'text-accent'}`}>
            <ListGlyph />
          </span>
          <span className="shrink-0 text-xs font-medium text-zinc-200">待办 {entries.length} 项</span>
          <span className="text-[11px] text-zinc-500">
            {allDone ? '已完成' : `已完成 ${done}/${entries.length}`}
          </span>
          {showStale && (
            <span className="shrink-0 text-[11px] text-zinc-600" title="待办由 AI 主动推送，会话空闲时不会自行刷新">
              · {staleLabel(staleSince)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
        </button>
        {settledBackgroundTask && (
          <div className="flex items-start gap-2 border-t border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            <span aria-hidden className="mt-px shrink-0">⏱</span>
            <span>
              后台任务已结束，但待办还停在未完成 —— AI 要等你发下一条消息才会收到完成通知并更新。
            </span>
          </div>
        )}
        <Collapse open={!collapsed}>
          <div className="border-t border-border-subtle bg-[#0f1015] px-3 py-1.5">
            {entries.map(rowOf)}
          </div>
        </Collapse>
      </div>
    </div>
  )
})

export default PlanCard
