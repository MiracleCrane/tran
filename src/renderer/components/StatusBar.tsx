import { useSessionStore } from '../store/sessionStore'

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

  if (!meta) return <div />

  const cost = status.costUsd != null ? `$${status.costUsd.toFixed(4)}` : '—'
  const modeLabel = PERMISSION_MODE_LABEL[meta.permissionMode] ?? meta.permissionMode

  return (
    <div className="flex items-center gap-4 border-t border-border-subtle bg-bg-panel px-6 py-1.5 text-[11px] text-zinc-500">
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
  )
}
