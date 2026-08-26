import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry, ToolBlock, ToolStatus } from '../types'
import type { KimiTaskInfo } from '../../shared/ipc'
import { AGENT_TOOL_NAMES, BASH_TOOL_NAMES, backgroundTaskInfo, withServerTaskStatus } from '../utils/toolStats'
import ToolCallCard, { parseSubagentInput, summaryForTool } from './ToolCallCard'
import HoverTip from './HoverTip'

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

/** 行是否活跃（运行中/排队；后台任务——子 Agent 与后台命令——以 server 校正后的
 *  running 为准，server 不可用退回 launch 结果文本猜测）：
 *  ChipPopover 的置顶排序与行高亮共用同一判定。 */
export function isToolRowActive(block: ToolBlock, swarmTasks?: KimiTaskInfo[] | null): boolean {
  const bg =
    AGENT_TOOL_NAMES.has(block.name) || BASH_TOOL_NAMES.has(block.name)
      ? backgroundTaskInfo(block)
      : null
  if (bg?.isBackground) return withServerTaskStatus(bg, swarmTasks).running
  return block.status === 'running' || block.status === 'pending'
}

export function ToolRow({ block }: { block: ToolBlock }): JSX.Element {
  const interrupt = useSessionStore((s) => s.interrupt)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const swarmTasks = useSessionStore((s) => s.swarmTasks)
  const [open, setOpen] = useState(false)
  const isAgent = AGENT_TOOL_NAMES.has(block.name)
  // 后台任务（实证形态见 toolStats.backgroundTaskInfo）：完成=已挂后台。
  // 后台命令（Bash）与后台子 Agent 同口径（2026-08-18：原先只认 Agent，
  // 后台命令行在面板里永远显示"已完成"、无运行态无走时）。
  // #32 有 server tasks 时以其状态为准（完成/被杀后不再误报运行中）。
  const bgInfo = isAgent || BASH_TOOL_NAMES.has(block.name) ? backgroundTaskInfo(block) : null
  const bg = bgInfo?.isBackground ? withServerTaskStatus(bgInfo, swarmTasks) : bgInfo
  const bgRunning = !!bg?.isBackground && bg.running
  // 前台阻塞语义只给非后台任务。
  const running = (block.status === 'running' || block.status === 'pending') && !bg?.isBackground
  // #32 后台仍在跑时块 status 已是 done（launch ack），图标按运行中显示；
  // 信封补登的终态（无 server 记录的老任务）按 完成/失败/停止 显示。
  const icon =
    STATUS_ICON[
      bgRunning
        ? 'running'
        : bg?.terminal === 'failed'
          ? 'error'
          : bg?.terminal === 'stopped'
            ? 'stopped'
            : block.status
    ]
  const sub = isAgent ? parseSubagentInput(block.input) : null
  const summary = summaryForTool(block.name, block.input)
  // #32 后台任务时长以 server task 的 started_at/completed_at 为准（block 的
  //  endedAt 只是 launch ack 时间）；仍在跑则计到当前。
  const duration = bg?.isBackground
    ? fmtDuration(bg.startedAt ?? block.startedAt, bgRunning ? undefined : bg.endedAt ?? block.endedAt)
    : fmtDuration(block.startedAt, block.endedAt)

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-white/[0.03] ${
          isToolRowActive(block, swarmTasks) ? 'tool-row-running' : ''
        }`}
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
              <HoverTip tip="后台任务：派出后不阻塞对话" tipClassName="text-left" className="inline-flex shrink-0">
                <span className="rounded bg-blue-950/50 px-1 py-0.5 text-[9px] font-medium text-blue-300">
                  后台
                </span>
              </HoverTip>
            )}
            {sub?.subagentType && (
              <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[9px] text-zinc-400">
                {sub.subagentType}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="shrink-0 font-mono text-[11px] text-zinc-300">{block.name}</span>
            {bg?.isBackground && (
              <HoverTip tip="后台任务：发起后不阻塞对话" tipClassName="text-left" className="inline-flex shrink-0">
                <span className="rounded bg-blue-950/50 px-1 py-0.5 text-[9px] font-medium text-blue-300">
                  后台
                </span>
              </HoverTip>
            )}
          </>
        )}
        {/* #12 子 agent 显示可读意图（description→prompt），不再是裸参数；
         *  完整输入/命令收进下方展开区（ToolCallCard）。
         *  #28 两行 clamp（配合浮层加宽）：描述能预览到大意，不再一刀切省略。 */}
        {isAgent ? (
          <HoverTip tip={sub?.prompt || summary} tipClassName="break-words text-left" className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[11px] leading-snug text-zinc-300">
              {sub?.description || sub?.prompt || summary || ''}
            </span>
          </HoverTip>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-500">
            {summary}
          </span>
        )}
        {bgRunning && bg?.taskId && (
          <HoverTip tip="软停：让 agent 用 TaskStop 停掉该后台任务（不中断整轮）" tipClassName="break-words text-left" className="inline-flex shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void sendMessage(`请使用 TaskStop 停止任务 ${bg.taskId}`)
              }}
              className="rounded px-1 text-[10px] text-red-400 transition hover:bg-red-950/40"
            >
              停止
            </button>
          </HoverTip>
        )}
        {running && (
          <HoverTip
            tip={
              isAgent
                ? '中断当前整轮执行（停该子代理所在轮）；ACP 不支持单任务停止'
                : '中断当前整轮执行；ACP 不支持单任务停止（web 的单独停止走 server 协议）'
            }
            tipClassName="break-words text-left"
            className="inline-flex shrink-0"
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void interrupt()
              }}
              className="rounded px-1 text-[10px] text-red-400 transition hover:bg-red-950/40"
            >
              {isAgent ? '中断（停该子代理所在轮）' : '中断'}
            </button>
          </HoverTip>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-600">
          {duration}
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
        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
          completed
            ? 'tran-check-pop border-green-500/60 bg-green-500/20 text-green-400'
            : active
              ? 'border-accent/70 bg-accent/25 text-accent'
              : 'border-white/20 text-transparent'
        }`}
      >
        {/* SVG 打勾：文本字形 ✓ 在小圆圈里基线对不齐（看着是歪的）。 */}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
