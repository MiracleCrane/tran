import { memo, useState } from 'react'
import type { ToolBlock } from '../types'
import Collapse from './Collapse'
import DiffView from './DiffView'

function normalizeResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text)
        return ''
      })
      .join('\n')
      .trim()
  }
  if (typeof result === 'object') {
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }
  return String(result)
}

function summaryForTool(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Bash':
      return s(inp.command)
    case 'Read':
      return s(inp.file_path)
    case 'Write':
      return s(inp.file_path)
    case 'Edit':
      return s(inp.file_path)
    case 'Glob':
      return s(inp.pattern)
    case 'Grep':
      return s(inp.pattern)
    case 'WebSearch':
      return s(inp.query)
    case 'WebFetch':
      return s(inp.url)
    case 'Agent':
    case 'Task':
      return s(inp.description)
    default:
      return ''
  }
}

const STATUS_META: Record<
  ToolBlock['status'],
  { label: string; dot: string; text: string }
> = {
  pending: { label: '排队中', dot: 'bg-amber-400', text: 'text-amber-400' },
  running: { label: '运行中', dot: 'bg-blue-400 animate-pulse', text: 'text-blue-400' },
  done: { label: '完成', dot: 'bg-green-500', text: 'text-green-500' },
  error: { label: '出错', dot: 'bg-red-500', text: 'text-red-400' },
  denied: { label: '已拒绝', dot: 'bg-orange-500', text: 'text-orange-400' }
}

const ToolCallCard = memo(function ToolCallCard({ block }: { block: ToolBlock }): JSX.Element {
  // Collapsed by default — tool details (read text, inputs, diffs) stay folded
  // out of the conversation until clicked, so the transcript isn't cluttered.
  const [collapsed, setCollapsed] = useState(true)
  const meta = STATUS_META[block.status]
  const summary = summaryForTool(block.name, block.input)
  const resultText = collapsed ? '' : normalizeResult(block.result)
  const inputText =
    !collapsed && block.name === 'Bash' ? ((block.input as { command?: string })?.command ?? '') : ''

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-border-subtle bg-[#101116]">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
        <span className="shrink-0 font-mono text-xs font-medium text-zinc-300">{block.name}</span>
        {summary && (
          <span className="truncate font-mono text-xs text-zinc-500">{summary}</span>
        )}
        <span className={`ml-auto shrink-0 text-[11px] ${meta.text}`}>
          {meta.label}
          {block.elapsed ? ` · ${block.elapsed.toFixed(1)}s` : ''}
        </span>
        <span className="shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
      </button>

      <Collapse open={!collapsed}>
        <div className="border-t border-border-subtle bg-[#0f1015] px-3 py-2.5">
          {block.name === 'Bash' && inputText && (
            <pre className="mb-2 overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-300">
              <span className="text-zinc-600">$ </span>
              {inputText}
            </pre>
          )}

          {block.name !== 'Bash' && block.input != null && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                输入
              </summary>
              <pre className="mt-1 overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-400">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </details>
          )}

          {block.errorMessage && (
            <div className="mb-2 text-xs text-orange-400">{block.errorMessage}</div>
          )}

          {resultText && <DiffView text={resultText} />}

          {!resultText && block.status === 'running' && (
            <div className="text-xs text-zinc-600">等待输出…</div>
          )}
          {!resultText && block.status === 'pending' && (
            <div className="text-xs text-zinc-600">排队中 — 等待批准或轮到执行。</div>
          )}
        </div>
      </Collapse>
    </div>
  )
})

export default ToolCallCard
