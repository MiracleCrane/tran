import { memo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry } from '../types'
import Collapse from './Collapse'

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
  const [collapsed, setCollapsed] = useState(false)
  if (entries.length === 0) return null

  const done = entries.filter((e) => e.status === 'completed').length
  const allDone = done === entries.length

  const rowOf = (entry: PlanEntry, index: number): JSX.Element => {
    const active = entry.status === 'in_progress'
    const completed = entry.status === 'completed'
    return (
      <div key={index} className="flex items-start gap-2 py-1">
        <span
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
            completed
              ? 'border-green-500/60 bg-green-500/20 text-green-400'
              : active
                ? 'border-accent/70 bg-accent/25 text-accent'
                : 'border-white/20 text-transparent'
          }`}
        >
          ✓
        </span>
        <span
          className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${
            completed
              ? 'text-zinc-500 line-through'
              : active
                ? 'text-accent'
                : 'text-zinc-300'
          }`}
        >
          {active && entry.activeForm ? entry.activeForm : entry.content}
        </span>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-3">
      <div className="tool-call-card overflow-hidden rounded-lg border border-accent/30 bg-[#101116]">
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
          <span className="ml-auto shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
        </button>
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
