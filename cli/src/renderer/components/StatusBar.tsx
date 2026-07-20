import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { TranscriptItem } from '../types'
import SubagentMonitor from './SubagentMonitor'

function fmt(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Kimi 把命令行工具映射为 'terminal'（旧 Claude 后端为 'Bash'）。 */
const BASH_TOOL_NAMES = new Set(['Bash', 'terminal'])
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

/** 统计运行中（pending/running）的指定类工具调用数，供底部 chips 使用。 */
function countRunningTools(items: TranscriptItem[], names: Set<string>): number {
  let count = 0
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (
        block &&
        block.kind === 'tool' &&
        names.has(block.name) &&
        (block.status === 'running' || block.status === 'pending')
      ) {
        count += 1
      }
    }
  }
  return count
}

/** Kimi 的权限模式值原样透传（见 shared/ipc.ts PermissionMode），映射到
 *  中文标签便于阅读；未知值回退原始字符串。 */
const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: '默认',
  plan: '计划模式',
  auto: '自动',
  yolo: 'YOLO'
}

export default function StatusBar(): JSX.Element {
  // Narrow selectors: subscribe to the exact primitives rendered, not the whole
  // `status`/`tasks` objects. Each line re-renders only when its value actually
  // changes (a number/string), not on every store update during a stream.
  const meta = useSessionStore((s) => s.meta)
  const turns = useSessionStore((s) => s.status.turns)
  const inputTokens = useSessionStore((s) => s.status.inputTokens)
  const outputTokens = useSessionStore((s) => s.status.outputTokens)
  const stopReason = useSessionStore((s) => s.status.stopReason)
  const error = useSessionStore((s) => s.status.error)
  const runningCount = useSessionStore(
    (s) => s.tasks.filter((t) => t.status === 'running').length
  )
  const runningBash = useSessionStore((s) => countRunningTools(s.items, BASH_TOOL_NAMES))
  const runningAgents = useSessionStore((s) => countRunningTools(s.items, AGENT_TOOL_NAMES))
  const planTotal = useSessionStore((s) => s.planEntries.length)
  const planDone = useSessionStore(
    (s) => s.planEntries.filter((e) => e.status === 'completed').length
  )
  const [monitorOpen, setMonitorOpen] = useState(false)

  if (!meta) return <div />

  const modeLabel = PERMISSION_MODE_LABEL[meta.permissionMode] ?? meta.permissionMode

  return (
    <>
      <div className="bg-transparent px-6 pb-4">
        <div className="glass-panel-soft mx-auto flex max-w-5xl items-center gap-4 rounded-2xl px-4 py-2 text-[11px] text-zinc-500">
          {runningCount > 0 && (
            <button
              onClick={() => setMonitorOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-950/40 px-2 py-0.5 text-emerald-300 transition hover:bg-emerald-950/70"
              title="查看子代理"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              {runningCount} 个子代理
            </button>
          )}
          {runningBash > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-blue-950/40 px-2 py-0.5 text-blue-300"
              title="运行中的命令行工具调用"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
              后台 Bash ({runningBash})
            </span>
          )}
          {runningAgents > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-2 py-0.5 text-accent"
              title="运行中的子 Agent 工具调用"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              子 Agent ({runningAgents})
            </span>
          )}
          {planTotal > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-0.5 text-zinc-400"
              title="待办清单完成进度"
            >
              待办 ({planDone}/{planTotal})
            </span>
          )}
          <span className="truncate font-mono" title={meta.cwd}>
            {meta.cwd}
          </span>
          <span className="text-zinc-700">·</span>
          <span>{modeLabel}</span>
          {turns != null && (
            <>
              <span className="text-zinc-700">·</span>
              <span>{turns} 轮</span>
            </>
          )}
          <span className="text-zinc-700">·</span>
          <span title="输入 / 输出 token">
            {fmt(inputTokens)} / {fmt(outputTokens)}
          </span>
          <button
            type="button"
            onClick={() => useUiStore.getState().setUsageOpen(true)}
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
            title="查看用量（套餐额度 / 会话用量）"
          >
            用量
          </button>
          {stopReason && (
            <span className="text-zinc-600">· 结束: {stopReason}</span>
          )}
          {error && <span className="text-red-400">· {error}</span>}
        </div>
      </div>
      {monitorOpen && <SubagentMonitor onClose={() => setMonitorOpen(false)} />}
    </>
  )
}
