import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry, ToolBlock, ToolStatus } from '../types'
import { AGENT_TOOL_NAMES, backgroundTaskInfo } from '../utils/toolStats'
import ToolCallCard, { parseSubagentInput, summaryForTool } from './ToolCallCard'

/** 任务行组件（chips 独立浮层共用；原 TaskPanel 合并面板拆出）。 */

/** 耗时格式化：1.2s / 3m5s；无时间戳（历史重放）诚实显示"—"。 */
export function fmtDuration(startedAt?: number, endedAt?: number): string {
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

export function ToolRow({ block }: { block: ToolBlock }): JSX.Element {
  const interrupt = useSessionStore((s) => s.interrupt)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const [open, setOpen] = useState(false)
  const icon = STATUS_ICON[block.status]
  const isAgent = AGENT_TOOL_NAMES.has(block.name)
  // 后台任务（实证形态见 toolStats.backgroundTaskInfo）：完成=已挂后台。
  const bg = isAgent ? backgroundTaskInfo(block) : null
  const bgRunning = !!bg?.isBackground && bg.running
  // 前台阻塞语义只给非后台任务。
  const running = (block.status === 'running' || block.status === 'pending') && !bg?.isBackground
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
            {bg?.isBackground && (
              <span
                className="shrink-0 rounded bg-blue-950/50 px-1 py-0.5 text-[9px] font-medium text-blue-300"
                title="后台任务：派出后不阻塞对话"
              >
                后台
              </span>
            )}
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
        {bgRunning && bg?.taskId && (
          <button
            type="button"
            title="软停：让 agent 用 TaskStop 停掉该后台任务（不中断整轮）"
            onClick={(e) => {
              e.stopPropagation()
              void sendMessage(`请使用 TaskStop 停止任务 ${bg.taskId}`)
            }}
            className="shrink-0 rounded px-1 text-[10px] text-red-400 transition hover:bg-red-950/40"
          >
            停止
          </button>
        )}
        {running && (
          <button
            type="button"
            title={
              isAgent
                ? '中断当前整轮执行（停该子代理所在轮）；ACP 不支持单任务停止'
                : '中断当前整轮执行；ACP 不支持单任务停止（web 的单独停止走 server 协议）'
            }
            onClick={(e) => {
              e.stopPropagation()
              void interrupt()
            }}
            className="shrink-0 rounded px-1 text-[10px] text-red-400 transition hover:bg-red-950/40"
          >
            {isAgent ? '中断（停该子代理所在轮）' : '中断'}
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

export function PlanRow({ entry, index }: { entry: PlanEntry; index: number }): JSX.Element {
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
