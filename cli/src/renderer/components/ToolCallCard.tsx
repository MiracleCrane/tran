import { memo, useState } from 'react'
import type { ToolBlock } from '../types'
import { backgroundTaskInfo } from '../utils/toolStats'
import Collapse from './Collapse'
import CodeBlock, { langForTool } from './CodeBlock'
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

/** 子代理（Agent）工具输入的防御式解析：input 可能是对象或 JSON 字符串；
 *  取 description / subagent_type / prompt，解析不出对象时返回 null（走原始回落）。 */
export function parseSubagentInput(input: unknown): {
  description?: string
  subagentType?: string
  prompt?: string
} | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    description: str(record.description),
    subagentType: str(record.subagent_type),
    prompt: str(record.prompt)
  }
}

/** 折叠态摘要：按工具类型从 rawInput 提取关键信息（命令行/路径/pattern/
 *  description）。rawInput 可能是对象或 JSON 字符串，防御式解析；失败回落通用摘要。 */
export function summaryForTool(name: string, input: unknown): string {
  let value = input
  if (typeof value === 'string') {
    const raw = value
    try {
      value = JSON.parse(raw)
    } catch {
      return raw.slice(0, 80) // 非 JSON 字符串：直接截断当摘要
    }
  }
  const inp = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Bash':
    case 'terminal':
      return s(inp.command)
    case 'Read':
    case 'read_file':
      return s(inp.file_path) || s(inp.path)
    case 'Write':
    case 'Edit':
    case 'patch':
      return s(inp.file_path) || s(inp.path)
    case 'Glob':
    case 'Grep':
    case 'search':
      return s(inp.pattern) || s(inp.query)
    case 'WebSearch':
      return s(inp.query)
    case 'WebFetch':
      return s(inp.url)
    case 'Agent':
    case 'Task':
      return s(inp.description)
    default:
      // 通用回落：title → command → file_path/path
      return s(inp.title) || s(inp.command) || s(inp.file_path) || s(inp.path)
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
  denied: { label: '已拒绝', dot: 'bg-orange-500', text: 'text-orange-400' },
  stopped: { label: '手动停止', dot: 'bg-zinc-500', text: 'text-zinc-400' }
}

const ToolCallCard = memo(function ToolCallCard({
  block,
  forceExpanded = false
}: {
  block: ToolBlock
  /** 任务面板详情行用：强制展开（用户点击仍可覆盖）。 */
  forceExpanded?: boolean
}): JSX.Element {
  // 默认收起只显示一行摘要；运行中/排队中的卡片例外自动展开（输出值得直接可见），
  // 完成后自动收回摘要；用户手动点击后以其选择为准。
  const isSubagent = block.name === 'Agent'
  const active = block.status === 'running' || block.status === 'pending'
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const collapsed = userToggled ?? (forceExpanded ? false : !active)
  const meta = STATUS_META[block.status]
  // 后台子代理（rawInput.run_in_background，实证见 toolStats）：完成=已挂后台。
  const bg = isSubagent ? backgroundTaskInfo(block) : null
  const statusLabel = bg?.isBackground && bg.running && block.status === 'done' ? '已挂后台' : meta.label
  const summary = summaryForTool(block.name, block.input)
  const resultText = collapsed ? '' : normalizeResult(block.result)
  const inputText =
    !collapsed && block.name === 'Bash' ? ((block.input as { command?: string })?.command ?? '') : ''
  const streaming = isSubagent && block.status === 'running'

  return (
    <div
      className={`tool-call-card my-1.5 overflow-hidden rounded-lg border bg-[#101116] ${
        block.status === 'running' ? 'is-running' : ''
      } ${isSubagent ? 'border-accent/35' : 'border-border-subtle'}`}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setUserToggled(!collapsed)}
        className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${isSubagent ? 'bg-accent' : meta.dot} ${streaming ? 'animate-pulse' : ''}`} />
        {isSubagent ? (
          <>
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              子代理
            </span>
            {bg?.isBackground && (
              <span
                className="shrink-0 rounded bg-blue-950/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-300"
                title="后台任务：派出后不阻塞对话，完成通知稍后到达"
              >
                后台
              </span>
            )}
          </>
        ) : (
          <span className="shrink-0 font-mono text-xs font-medium text-zinc-300">{block.name}</span>
        )}
        {summary && (
          <span className="truncate font-mono text-xs text-zinc-500">{summary}</span>
        )}
        <span key={block.status} className={`ml-auto shrink-0 text-[11px] ${meta.text}`}>
          {/* 完成瞬间：状态勾弹入（key 随状态重挂载，动画只播一次） */}
          {block.status === 'done' && !bg?.running && <span className="tran-check-pop mr-1">✓</span>}
          {statusLabel}
          {block.elapsed ? ` · ${block.elapsed.toFixed(1)}s` : ''}
        </span>
        <span className="shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
      </button>

      <Collapse open={!collapsed}>
        <div className="border-t border-border-subtle bg-[#0f1015] px-3 py-2.5">
          {block.name === 'Bash' && inputText && (
            <CodeBlock
              text={inputText}
              lang="bash"
              className="mb-2 overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-300"
            />
          )}

          {!isSubagent && block.name !== 'Bash' && block.input != null && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                输入
              </summary>
              <CodeBlock
                text={JSON.stringify(block.input, null, 2)}
                lang="json"
                className="mt-1 overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-400"
              />
            </details>
          )}

          {isSubagent && (() => {
            // 子代理输入区：友好渲染 description / subagent_type / prompt，
            // 解析失败时回落原始 JSON 显示。
            const parsed = parseSubagentInput(block.input)
            if (!parsed) {
              return block.input != null && (
                <details className="mb-2">
                  <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                    输入
                  </summary>
                  <pre className="mt-1 overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-400">
                    {typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}
                  </pre>
                </details>
              )
            }
            return (
              <div className="mb-2">
                {(parsed.description || parsed.subagentType) && (
                  <div className="flex items-center gap-2">
                    {parsed.description && (
                      <span className="min-w-0 break-words text-xs font-semibold text-zinc-200">
                        {parsed.description}
                      </span>
                    )}
                    {parsed.subagentType && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {parsed.subagentType}
                      </span>
                    )}
                  </div>
                )}
                {parsed.prompt && (
                  <details className={parsed.description || parsed.subagentType ? 'mt-1.5' : ''}>
                    <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                      查看指令
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0b0c10] p-2.5 text-xs leading-relaxed text-zinc-400">
                      {parsed.prompt}
                    </pre>
                  </details>
                )}
              </div>
            )
          })()}

          {block.errorMessage && (
            <div className="mb-2 text-xs text-orange-400">{block.errorMessage}</div>
          )}

          {isSubagent && resultText && (
            <>
              <CodeBlock
                text={resultText}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#0b0c10] p-2.5 text-xs leading-relaxed text-zinc-300"
              />
              {streaming && <span className="tran-stream-cursor" aria-hidden />}
            </>
          )}
          {!isSubagent && resultText && (
            <DiffView text={resultText} lang={langForTool(block.name, block.input)} />
          )}

          {!resultText && block.status === 'running' && (
            <div className="text-xs text-zinc-600">{isSubagent ? '子代理运行中，等待输出…' : '等待输出…'}</div>
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
