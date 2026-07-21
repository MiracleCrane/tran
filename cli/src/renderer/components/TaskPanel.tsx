import { memo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry, ToolBlock, ToolStatus } from '../types'
import { AGENT_TOOL_NAMES, BASH_TOOL_NAMES, collectToolBlocks } from '../utils/toolStats'
import Collapse from './Collapse'
import ToolCallCard, { parseSubagentInput, summaryForTool } from './ToolCallCard'

/** 任务面板（kimi web 同款 task-list）：点 chips 展开，三个分区（后台命令/
 *  子 Agent/待办）。数据全部渲染层派生（sessionStore.items / planEntries）。 */

/** 耗时格式化：1.2s / 3m5s；无时间戳（历史重放）诚实显示"—"。 */
function fmtDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return '—'
  const ms = (endedAt ?? Date.now()) - startedAt
  if (ms < 0) return '—'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const STATUS_ICON: Record<ToolStatus, { glyph: string; cls: string }> = {
  done: { glyph: '✓', cls: 'text-green-500' },
  error: { glyph: '✗', cls: 'text-red-400' },
  denied: { glyph: '✗', cls: 'text-orange-400' },
  running: { glyph: '●', cls: 'animate-pulse text-accent' },
  pending: { glyph: '●', cls: 'animate-pulse text-amber-400' },
  stopped: { glyph: '⏸', cls: 'text-zinc-500' }
}

function ToolRow({ block }: { block: ToolBlock }): JSX.Element {
  const interrupt = useSessionStore((s) => s.interrupt)
  const [open, setOpen] = useState(false)
  const icon = STATUS_ICON[block.status]
  const running = block.status === 'running' || block.status === 'pending'
  const isAgent = AGENT_TOOL_NAMES.has(block.name)
  const sub = isAgent ? parseSubagentInput(block.input) : null
  const summary = summaryForTool(block.name, block.input)

  return (
    <div>
      <div
        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/[0.03]"
        onClick={() => setOpen((o) => !o)}
      >
        {/* 状态图标：颜色/态过渡 150ms（运行中→完成/失败）。 */}
        <span className={`shrink-0 transition-colors duration-150 ${icon.cls}`}>{icon.glyph}</span>
        {isAgent ? (
          <>
            <span className="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9px] font-medium text-accent">
              子代理
            </span>
            {sub?.subagentType && (
              <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[9px] text-zinc-400">
                {sub.subagentType}
              </span>
            )}
          </>
        ) : (
          <span className="shrink-0 font-mono text-[11px] text-zinc-300">{block.name}</span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500">
          {summary || sub?.prompt || ''}
        </span>
        {running && (
          <button
            type="button"
            title="停止将中断当前整轮执行（ACP 不支持单任务停止）"
            onClick={(e) => {
              e.stopPropagation()
              void interrupt()
            }}
            className="shrink-0 rounded px-1 text-[10px] text-red-400 transition hover:bg-red-950/40"
          >
            停止
          </button>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
          {fmtDuration(block.startedAt, block.endedAt)}
        </span>
      </div>
      {/* 详情：现有 ToolCallCard 的展开态渲染（输入/输出/子代理流式结果） */}
      {open && <ToolCallCard block={block} forceExpanded />}
    </div>
  )
}

function PlanRow({ entry, index }: { entry: PlanEntry; index: number }): JSX.Element {
  const active = entry.status === 'in_progress'
  const completed = entry.status === 'completed'
  return (
    // key 带状态：完成瞬间重挂载，打勾弹入 + 划线动画只播一次。
    <div key={`${index}-${entry.status}`} className="flex items-start gap-2 px-2 py-1">
      <span
        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
          completed
            ? 'tran-check-pop border-green-500/60 bg-green-500/20 text-green-400'
            : active
              ? 'border-accent/70 bg-accent/25 text-accent'
              : 'border-white/20 text-transparent'
        }`}
      >
        ✓
      </span>
      <span
        className={`min-w-0 flex-1 break-words text-[11px] leading-relaxed ${
          completed ? 'text-zinc-500' : active ? 'text-accent' : 'text-zinc-300'
        }`}
      >
        <span className={completed ? 'plan-strike' : undefined}>
          {active && entry.activeForm ? entry.activeForm : entry.content}
        </span>
      </span>
    </div>
  )
}

function Section({
  title,
  empty,
  children
}: {
  title: string
  empty: boolean
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">
        {title}
      </div>
      {empty ? <div className="px-2 py-1.5 text-[11px] text-zinc-600">暂无记录</div> : children}
    </div>
  )
}

const TaskPanel = memo(function TaskPanel({ open }: { open: boolean }): JSX.Element {
  const items = useSessionStore((s) => s.items)
  const planEntries = useSessionStore((s) => s.planEntries)
  const bashBlocks = collectToolBlocks(items, BASH_TOOL_NAMES)
  const agentBlocks = collectToolBlocks(items, AGENT_TOOL_NAMES)
  const planDone = planEntries.filter((e) => e.status === 'completed').length

  return (
    <Collapse open={open}>
      <div className="glass-panel-soft mb-1.5 max-h-72 space-y-2 overflow-y-auto rounded-xl px-2 py-2">
        <Section title={`后台命令 (${bashBlocks.length})`} empty={bashBlocks.length === 0}>
          {bashBlocks.map((b) => (
            <ToolRow key={b.toolUseId} block={b} />
          ))}
        </Section>
        <Section title={`子 Agent (${agentBlocks.length})`} empty={agentBlocks.length === 0}>
          {agentBlocks.map((b) => (
            <ToolRow key={b.toolUseId} block={b} />
          ))}
        </Section>
        <Section title={`待办 (${planDone}/${planEntries.length})`} empty={planEntries.length === 0}>
          {planEntries.map((entry, i) => (
            <PlanRow key={i} entry={entry} index={i} />
          ))}
        </Section>
      </div>
    </Collapse>
  )
})

export default TaskPanel
