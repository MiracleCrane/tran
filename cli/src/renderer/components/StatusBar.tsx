import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import SubagentMonitor from './SubagentMonitor'

function fmt(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
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
  const costUsd = useSessionStore((s) => s.status.costUsd)
  const turns = useSessionStore((s) => s.status.turns)
  const inputTokens = useSessionStore((s) => s.status.inputTokens)
  const outputTokens = useSessionStore((s) => s.status.outputTokens)
  const stopReason = useSessionStore((s) => s.status.stopReason)
  const error = useSessionStore((s) => s.status.error)
  const runningCount = useSessionStore(
    (s) => s.tasks.filter((t) => t.status === 'running').length
  )
  const [monitorOpen, setMonitorOpen] = useState(false)

  if (!meta) return <div />

  const cost = costUsd != null ? `$${costUsd.toFixed(4)}` : '—'
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
          <span className="ml-auto tabular-nums">费用 {cost}</span>
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
