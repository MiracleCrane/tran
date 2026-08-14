import { memo, useState } from 'react'
import type { ToolBlock } from '../types'
import Collapse from './Collapse'
import ToolCallCard from './ToolCallCard'

const WrenchGlyph = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M14.7 6.3a4.2 4.2 0 0 0-5.9 5.3L3.5 16.9a2 2 0 1 0 2.8 2.8l5.3-5.3a4.2 4.2 0 0 0 5.3-5.9l-2.7 2.7-2.1-.7-.7-2.1 2.6-2.1z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)

/** 连续相邻的工具调用聚成的分组块（纯渲染层聚合，数据仍来自各自的 ToolBlock）。
 *  2026-08 起与单行工具同一语言：裸排版无框，完成态不显示任何标记。 */
const ToolGroupCard = memo(function ToolGroupCard({
  blocks,
  forceOpen = false,
  expandedBlockKey = null
}: {
  blocks: ToolBlock[]
  /** 组内含"最新块"时整组保持展开；用户手动点击后以其选择为准。 */
  forceOpen?: boolean
  expandedBlockKey?: string | null
}): JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const collapsed = userToggled ?? !forceOpen
  const running = blocks.some((b) => b.status === 'running' || b.status === 'pending')
  const hasError = blocks.some((b) => b.status === 'error' || b.status === 'denied')
  // 折叠行摘要：去重后的工具名列表（如 `Bash, Read, Grep`）。
  const toolNames = [...new Set(blocks.map((b) => b.name))].join(', ')

  return (
    // 2026-08：组卡也裸掉（与单行工具/思考块同一语言）——框没有信息量，
    // 可展开由右缘的旋转箭头表达；运行中留一丝紫底信号。
    <div
      className={`tool-call-card my-[3px] overflow-hidden ${running ? 'is-running' : ''}`}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setUserToggled(!collapsed)}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
      >
        <span className="shrink-0 text-zinc-400">
          <WrenchGlyph />
        </span>
        <span className="shrink-0 text-xs font-medium text-zinc-200">{blocks.length} 个工具调用</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{toolNames}</span>
        {/* 与单行工具同一约定：完成态什么都不显示，只有 进行中/含失败 出文字。 */}
        {(running || hasError) && (
          <span className={`shrink-0 text-[11px] ${hasError ? 'text-red-400' : 'text-zinc-500'}`}>
            {running ? '进行中' : '已完成（含失败）'}
          </span>
        )}
        <span className="ml-auto shrink-0" />
      </button>
      <Collapse open={!collapsed}>
        <div className="ml-2 border-l border-white/[0.07] px-2 py-1">
          {blocks.map((block) => (
            <ToolCallCard
              key={block.toolUseId}
              block={block}
              forceExpanded={expandedBlockKey === block.toolUseId}
            />
          ))}
        </div>
      </Collapse>
    </div>
  )
})

export default ToolGroupCard
