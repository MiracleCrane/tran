import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../store/sessionStore'
import { AGENT_TOOL_NAMES, BASH_TOOL_NAMES, collectToolBlocks, countRunningTools } from '../utils/toolStats'
import { PlanRow, ToolRow } from './taskRows'

/** chips 独立浮层（kimi web 同款）：点哪个 chip 弹哪个自己的面板，portal 挂
 *  body、fixed 定位向上浮出、点外部关闭。合并面板（TaskPanel）已被此取代。 */

export type ChipKind = 'bash' | 'agent' | 'plan'

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
  const cardRef = useRef<HTMLDivElement | null>(null)

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

  const bashBlocks = kind === 'bash' ? collectToolBlocks(items, BASH_TOOL_NAMES) : []
  const agentBlocks = kind === 'agent' ? collectToolBlocks(items, AGENT_TOOL_NAMES) : []
  const runningAgents = kind === 'agent' ? countRunningTools(items, AGENT_TOOL_NAMES) : 0
  const planDone = planEntries.filter((e) => e.status === 'completed').length

  const title =
    kind === 'bash'
      ? `后台命令 · ${bashBlocks.length}`
      : kind === 'agent'
        ? `子 Agent · ${runningAgents} 运行中`
        : `待办 · ${planDone}/${planEntries.length}`
  const empty =
    kind === 'bash'
      ? bashBlocks.length === 0
      : kind === 'agent'
        ? agentBlocks.length === 0
        : planEntries.length === 0

  return createPortal(
    <div
      ref={cardRef}
      className="glass-panel tran-enter fixed z-[90] w-80 rounded-2xl p-2 shadow-2xl"
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
          (kind === 'bash' ? bashBlocks : agentBlocks).map((b) => (
            <ToolRow key={b.toolUseId} block={b} />
          ))
        )}
      </div>
    </div>,
    document.body
  )
}
