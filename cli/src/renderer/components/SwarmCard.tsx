import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { ToolBlock } from '../types'
import type { KimiTaskInfo } from '../../shared/ipc'

/** AgentSwarm 工具调用的专门卡片：标题 = rawInput.description、子任务数、
 *  总进度条、逐个子代理一行（序号 + 状态点 + 状态文本/描述）。
 *  数据优先取 kimi 本地 server 的 tasks（kind=subagent，2s 轮询）；
 *  server 不可用时退化为静态卡（rawInput 里的 items + 工具调用自身状态）。 */

interface SwarmRow {
  key: string
  text: string
  status?: string
}

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  pending: '排队',
  completed: '完成',
  failed: '失败',
  stopped: '已停止'
}

function statusDot(status: string | undefined): string {
  if (status === 'running') return 'bg-blue-400 animate-pulse'
  if (status === 'completed') return 'bg-emerald-500'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'stopped') return 'bg-zinc-500'
  return 'bg-amber-400'
}

/** 从 rawInput（完整 JSON 或流式片段）防御式解析 description / items。 */
function parseSwarmInput(block: ToolBlock): { description?: string; items: string[] } {
  const sources: unknown[] = [block.input, block.result]
  for (const src of sources) {
    const text = typeof src === 'string' ? src : src ? JSON.stringify(src) : ''
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as { description?: unknown; items?: unknown }
      const description = typeof parsed.description === 'string' ? parsed.description : undefined
      const items = Array.isArray(parsed.items)
        ? parsed.items.filter((x): x is string => typeof x === 'string')
        : []
      if (description || items.length) {
        return { ...(description ? { description } : {}), items }
      }
    } catch {
      // 流式片段：正则兜底 description；items 粗数 items 区段内的字符串条目。
      const description = /"description"\s*:\s*"([^"]+)"/.exec(text)?.[1]
      const region = /"items"\s*:\s*\[([\s\S]*?)(?:\]|$)/.exec(text)?.[1] ?? ''
      const rough = (region.match(/"[^"]*"/g) ?? []).filter((s) => s !== '"items"')
      if (description || rough.length) {
        return { ...(description ? { description } : {}), items: rough.map((s) => s.slice(1, -1)) }
      }
    }
  }
  return { items: [] }
}

export default function SwarmCard({ block }: { block: ToolBlock }): JSX.Element {
  const swarmTasks = useSessionStore((s) => s.swarmTasks)
  const [collapsed, setCollapsed] = useState(false)
  const { description, items } = parseSwarmInput(block)

  const subagents = (swarmTasks ?? []).filter((t: KimiTaskInfo) => t.kind === 'subagent')
  // 行数据：server tasks 可用用 server（带独立状态）；否则 rawInput items + 工具状态。
  const rows: SwarmRow[] = subagents.length
    ? subagents.map((t, i) => ({
        key: t.id,
        text: t.description ?? `子代理 ${i + 1}`,
        ...(t.status ? { status: t.status } : {})
      }))
    : items.map((text, i) => ({
        key: `item-${i}`,
        text,
        status: block.status === 'done' ? 'completed' : block.status === 'error' ? 'failed' : block.status
      }))

  const total = rows.length
  const done = rows.filter((r) => r.status === 'completed').length
  const running =
    block.status === 'running' || rows.some((r) => r.status === 'running')
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-accent/35 bg-[#101116]">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
      >
        <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
          Swarm
        </span>
        <span className="truncate text-xs text-zinc-200">{description ?? '并行子代理'}</span>
        {total > 0 && (
          <span className="shrink-0 text-[11px] text-zinc-500">
            {done}/{total}
          </span>
        )}
        <span className={`ml-auto shrink-0 text-[11px] ${running ? 'text-blue-400' : 'text-zinc-500'}`}>
          {running ? '进行中' : block.status === 'error' ? '出错' : '已完成'}
        </span>
        <span className="shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-border-subtle bg-[#0f1015] px-3 py-2.5">
          {total > 0 && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-black/30">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${pct}%`,
                  background: 'linear-gradient(90deg, #8b5cf6, #a78bfa)'
                }}
              />
            </div>
          )}
          <div className="space-y-1">
            {rows.map((row, i) => (
              <div key={row.key} className="flex items-center gap-2 text-xs">
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-zinc-600">{i + 1}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(row.status)}`} />
                <span className="min-w-0 flex-1 truncate text-zinc-300">{row.text}</span>
                {row.status && (
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    {STATUS_LABEL[row.status] ?? row.status}
                  </span>
                )}
              </div>
            ))}
            {rows.length === 0 && (
              <div className="text-xs text-zinc-600">
                {running ? '子代理启动中…' : '没有子任务信息。'}
              </div>
            )}
          </div>
          {swarmTasks === null && (
            <div className="mt-1.5 text-[10px] text-zinc-600">
              kimi server 不可用，仅显示工具调用状态。
            </div>
          )}
        </div>
      )}
    </div>
  )
}
