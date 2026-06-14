import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import SubagentMonitor from './SubagentMonitor'

function fmt(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** Permission-mode values come back from the SDK as raw enum strings; map the
 *  known ones to Chinese for readability, fall back to the raw value. */
const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: '默认',
  acceptEdits: '自动接受编辑',
  bypassPermissions: '跳过权限',
  plan: '计划模式',
  dontAsk: '不询问',
  auto: '自动'
}

export default function StatusBar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const status = useSessionStore((s) => s.status)
  const tasks = useSessionStore((s) => s.tasks)
  const [monitorOpen, setMonitorOpen] = useState(false)

  if (!meta) return <div />

  const cost = status.costUsd != null ? `$${status.costUsd.toFixed(4)}` : '—'
  const modeLabel = PERMISSION_MODE_LABEL[meta.permissionMode] ?? meta.permissionMode
  const runningCount = tasks.filter((t) => t.status === 'running').length

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
          <span className="truncate font-mono" title={meta.cwd}>
            {meta.cwd}
          </span>
          <span className="text-zinc-700">·</span>
          <span>{modeLabel}</span>
          {status.turns != null && (
            <>
              <span className="text-zinc-700">·</span>
              <span>{status.turns} 轮</span>
            </>
          )}
          <span className="text-zinc-700">·</span>
          <span title="输入 / 输出 token">
            {fmt(status.inputTokens)} / {fmt(status.outputTokens)}
          </span>
          <span className="ml-auto tabular-nums">费用 {cost}</span>
          {status.stopReason && (
            <span className="text-zinc-600">· 结束: {status.stopReason}</span>
          )}
          {status.error && <span className="text-red-400">· {status.error}</span>}
        </div>
      </div>
      {monitorOpen && <SubagentMonitor onClose={() => setMonitorOpen(false)} />}
    </>
  )
}
