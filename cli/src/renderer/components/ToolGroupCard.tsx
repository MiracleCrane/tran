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

const CheckGlyph = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 连续相邻的工具调用聚成的分组块（对齐 kimi web：左侧圆点+图标、右侧状态勾、
 *  可展开查看每个工具调用）。纯渲染层聚合，数据仍来自各自的 ToolBlock。 */
const ToolGroupCard = memo(function ToolGroupCard({ blocks }: { blocks: ToolBlock[] }): JSX.Element {
  const [collapsed, setCollapsed] = useState(true)
  const running = blocks.some((b) => b.status === 'running' || b.status === 'pending')
  const hasError = blocks.some((b) => b.status === 'error' || b.status === 'denied')
  // 折叠行摘要：去重后的工具名列表（如 `Bash, Read, Grep`）。
  const toolNames = [...new Set(blocks.map((b) => b.name))].join(', ')

  return (
    <div
      className={`tool-call-card my-1.5 overflow-hidden rounded-lg border bg-[#101116] ${
        running ? 'is-running' : ''
      } ${hasError ? 'border-red-900/50' : 'border-border-subtle'}`}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            running ? 'animate-pulse bg-blue-400' : hasError ? 'bg-red-500' : 'bg-green-500'
          }`}
        />
        <span className="shrink-0 text-zinc-400">
          <WrenchGlyph />
        </span>
        <span className="shrink-0 text-xs font-medium text-zinc-200">{blocks.length} 个工具调用</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{toolNames}</span>
        <span className={`shrink-0 text-[11px] ${hasError ? 'text-red-400' : 'text-zinc-500'}`}>
          {running ? '进行中' : hasError ? '已完成（含失败）' : '已完成'}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {!running && !hasError && (
            <span className="text-green-500">
              <CheckGlyph />
            </span>
          )}
          <span className="text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
        </span>
      </button>
      <Collapse open={!collapsed}>
        <div className="border-t border-border-subtle bg-[#0f1015] px-2 py-1.5">
          {blocks.map((block) => (
            <ToolCallCard key={block.toolUseId} block={block} />
          ))}
        </div>
      </Collapse>
    </div>
  )
})

export default ToolGroupCard
