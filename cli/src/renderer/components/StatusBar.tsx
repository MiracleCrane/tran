import { useSessionStore } from '../store/sessionStore'
import UsageRings from './UsageRings'

/** 底部状态栏：左侧只保留瞬态诊断（结束原因/错误），右侧 UsageRings。
 *  cwd/权限/轮数/token 已移除（与项目选择器、输入区选择器重复，token 恒空）。 */
export default function StatusBar(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const stopReason = useSessionStore((s) => s.status.stopReason)
  const error = useSessionStore((s) => s.status.error)

  if (!meta) return <div />

  return (
    <div className="bg-transparent px-6 pb-3">
      <div className="glass-panel-soft mx-auto flex max-w-5xl items-center gap-3 rounded-2xl px-4 py-1.5 text-[11px] text-zinc-500">
        {stopReason && <span className="text-zinc-600">结束: {stopReason}</span>}
        {error && <span className="text-red-400">{error}</span>}
        <UsageRings />
      </div>
    </div>
  )
}
