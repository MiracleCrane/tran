import { useSessionStore } from '../store/sessionStore'

function fmt(n?: number): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export default function StatusBar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const status = useSessionStore((s) => s.status)

  if (!meta) return <div />

  const cost = status.costUsd != null ? `$${status.costUsd.toFixed(4)}` : '—'

  return (
    <div className="flex items-center gap-4 border-t border-border-subtle bg-bg-panel px-6 py-1.5 text-[11px] text-zinc-500">
      <span className="truncate font-mono" title={meta.cwd}>
        {meta.cwd}
      </span>
      <span className="text-zinc-700">·</span>
      <span>{meta.permissionMode}</span>
      {status.turns != null && (
        <>
          <span className="text-zinc-700">·</span>
          <span>{status.turns} turns</span>
        </>
      )}
      <span className="text-zinc-700">·</span>
      <span title="input / output tokens">
        {fmt(status.inputTokens)} / {fmt(status.outputTokens)} tok
      </span>
      <span className="ml-auto tabular-nums">cost {cost}</span>
      {status.stopReason && (
        <span className="text-zinc-600">· stop: {status.stopReason}</span>
      )}
      {status.error && <span className="text-red-400">· {status.error}</span>}
    </div>
  )
}
