import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../store/sessionStore'
import type { ToolBlock } from '../types'
import {
  AGENT_TOOL_NAMES,
  collectBackgroundTaskBlocks,
  collectToolBlocks,
  countRunningBackgroundTasks,
  countRunningTools
} from '../utils/toolStats'
import { isToolRowActive, PlanRow, ToolRow } from './taskRows'

/** chips 独立浮层（kimi web 同款）：点哪个 chip 弹哪个自己的面板，portal 挂
 *  body、fixed 定位向上浮出、点外部关闭。合并面板（TaskPanel）已被此取代。 */

/** #12 归档阈值：默认只显示活跃项 + 最近 N 条历史，其余收进"查看全部"。 */
const RECENT_HISTORY_LIMIT = 8

export type ChipKind = 'task' | 'plan'

export interface ChipAnchor {
  left: number
  bottom: number
}

export default function ChipPopover({
  kind,
  anchor,
  onClose
}: {
  kind: ChipKind
  anchor: ChipAnchor
  onClose: () => void
}): JSX.Element {
  const items = useSessionStore((s) => s.items)
  const planEntries = useSessionStore((s) => s.planEntries)
  // #32 后台 agent 的运行中计数/置顶以 server 校正后的状态为准。
  const swarmTasks = useSessionStore((s) => s.swarmTasks)
  // 轮结束后仍挂着 running 的前台块是残留帧，别再报"在跑"（见 countRunningTools）。
  const turnRunning = useSessionStore((s) => s.status.running)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)

  // 点卡片外任意处关闭（无 backdrop，非模态）。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement
      if (cardRef.current?.contains(target)) return
      if (target.closest?.('[data-chip-row]')) return // chips 行自身（切换浮层）
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  // 「后台任务」面板分两节：命令（只列真后台任务）+ 子代理（口径同 chip 计数）。
  const bashBlocks = kind === 'task' ? collectBackgroundTaskBlocks(items) : []
  const agentBlocks = kind === 'task' ? collectToolBlocks(items, AGENT_TOOL_NAMES) : []
  const runningBash = kind === 'task' ? countRunningBackgroundTasks(items, swarmTasks) : 0
  const runningAgents =
    kind === 'task' ? countRunningTools(items, AGENT_TOOL_NAMES, swarmTasks, turnRunning) : 0
  const planDone = planEntries.filter((e) => e.status === 'completed').length

  const runningTasks = runningBash + runningAgents
  const title =
    kind === 'task'
      ? runningTasks > 0
        ? `后台任务 · ${runningTasks} 运行中`
        : '后台任务'
      : `待办 · ${planDone}/${planEntries.length}`
  const empty =
    kind === 'task'
      ? bashBlocks.length === 0 && agentBlocks.length === 0
      : planEntries.length === 0

  // #12 排序：最新在前（collectToolBlocks 返回时间正序，倒转）；活跃项再置顶突出；
  // 历史默认只露最近 N 条，其余收进「查看全部」。命令/子代理两节共用这套切分。
  const renderBlockList = (blocks: ToolBlock[]): JSX.Element => {
    const newestFirst = blocks.slice().reverse()
    const activeBlocks = newestFirst.filter((b) => isToolRowActive(b, swarmTasks))
    const historyBlocks = newestFirst.filter((b) => !isToolRowActive(b, swarmTasks))
    const visibleHistory = showAllHistory ? historyBlocks : historyBlocks.slice(0, RECENT_HISTORY_LIMIT)
    const hiddenHistoryCount = historyBlocks.length - visibleHistory.length
    return (
      <>
        {[...activeBlocks, ...visibleHistory].map((b) => (
          <ToolRow key={b.toolUseId} block={b} />
        ))}
        {hiddenHistoryCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowAllHistory(true)}
            className="mt-0.5 w-full rounded-lg px-2 py-1.5 text-left text-[11px] text-zinc-500 transition hover:bg-white/[0.03] hover:text-zinc-300"
          >
            查看全部（还有 {hiddenHistoryCount} 条历史）
          </button>
        ) : showAllHistory && historyBlocks.length > RECENT_HISTORY_LIMIT ? (
          <button
            type="button"
            onClick={() => setShowAllHistory(false)}
            className="mt-0.5 w-full rounded-lg px-2 py-1.5 text-left text-[11px] text-zinc-500 transition hover:bg-white/[0.03] hover:text-zinc-300"
          >
            收起历史
          </button>
        ) : null}
      </>
    )
  }

  // #28 浮层加宽：子代理行要预览完整任务描述（原 w-80 截断成"额度悬浮卡…"），
  // 「后台任务」给到 30rem；待办适度加宽到 24rem。max-w 兜底小窗口不溢出屏幕。
  const widthCls = kind === 'task' ? 'w-[30rem]' : 'w-96'

  return createPortal(
    <div
      ref={cardRef}
      className={`glass-panel tran-enter fixed z-[90] ${widthCls} max-w-[92vw] rounded-2xl p-2 shadow-2xl`}
      style={{ left: anchor.left, bottom: anchor.bottom }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-zinc-200">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        {title}
      </div>
      <div className="max-h-80 overflow-y-auto border-t border-white/[0.06] pt-1">
        {empty ? (
          <div className="px-2 py-2 text-[11px] text-zinc-600">暂无记录</div>
        ) : kind === 'plan' ? (
          planEntries.map((entry, i) => <PlanRow key={i} entry={entry} index={i} />)
        ) : (
          <>
            {bashBlocks.length > 0 && (
              <>
                <div className="px-2 pb-0.5 pt-1 text-[10px] text-zinc-600">命令</div>
                {renderBlockList(bashBlocks)}
              </>
            )}
            {agentBlocks.length > 0 && (
              <>
                <div className="px-2 pb-0.5 pt-1 text-[10px] text-zinc-600">子代理</div>
                {renderBlockList(agentBlocks)}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
