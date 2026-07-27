import { useSessionStore } from '../store/sessionStore'
import UsageRings from './UsageRings'

/** 底部状态栏：左侧只保留瞬态诊断（结束原因/错误），右侧 UsageRings。
 *  cwd/权限/轮数/token 已移除（与项目选择器、输入区选择器重复，token 恒空）。 */
export default function StatusBar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const stopReason = useSessionStore((s) => s.status.stopReason)
  const error = useSessionStore((s) => s.status.error)
  const clearError = useSessionStore((s) => s.clearError)

  if (!meta) return <div />

  return (
    <div className="bg-transparent px-6 pb-3">
      <div className="glass-panel-soft mx-auto flex max-w-5xl items-center gap-3 rounded-2xl px-4 py-1.5 text-[11px] text-zinc-500">
        {stopReason && <span className="text-zinc-600">结束: {stopReason}</span>}
        {error && (
          <span className="flex min-w-0 items-center gap-1 text-red-400">
            <span className="truncate">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 rounded px-0.5 text-red-400/70 transition hover:bg-white/[0.06] hover:text-red-300"
              title="关闭错误提示"
            >
              ×
            </button>
          </span>
        )}
        <UsageRings />
      </div>
    </div>
  )
}
