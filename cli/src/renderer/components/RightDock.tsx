import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import PlanCard from './PlanCard'
import GoalCard from './GoalCard'
import HoverTip from './HoverTip'

/**
 * 右侧停靠面板（2026-08-17，zcode/Codex 式布局）：待办 / 目标从右缘滑出，
 * 顶栏右侧图标切换。Git 工具 2026-08-18 回正文顶部常驻（用户拍板
 * 「git工具去上面啊，不要在右边了」），不再占这个面板——dock 只剩
 * 待办/目标两页。
 */
export default function RightDock(): JSX.Element | null {
  const dock = useUiStore((s) => s.rightDock)
  const setRightDock = useUiStore((s) => s.setRightDock)
  const planCount = useSessionStore((s) => s.planEntries.length)
  const goal = useSessionStore((s) => s.goal)

  const open = dock !== null
  const title = dock === 'plan' ? '待办' : '目标'
  return (
    <div
      className={`right-dock-root absolute inset-y-0 right-0 z-30 w-[360px] max-w-[88vw] transition-transform duration-300 ease-spring ${
        open ? 'translate-x-0' : 'pointer-events-none translate-x-full'
      }`}
      aria-hidden={!open}
    >
      {/* 圆角（2026-08-17 用户：尖角框不行）+ overflow-hidden 裁掉内容出界。 */}
      <div className="flex h-full flex-col overflow-hidden rounded-l-2xl border-l border-white/[0.07] bg-[#0d0e13]/[0.97] shadow-[-18px_0_44px_rgba(0,0,0,0.35)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <span className="flex-1 text-xs font-medium text-zinc-300">{title}</span>
          <HoverTip tip="收起">
            <button
              type="button"
              onClick={() => setRightDock(null)}
              aria-label="收起"
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </HoverTip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {dock === 'plan' &&
            (planCount > 0 ? (
              <PlanCard docked />
            ) : (
              <div className="px-2 py-3 text-xs text-zinc-600">暂无待办。</div>
            ))}
          {dock === 'goal' &&
            (goal ? <GoalCard docked /> : <div className="px-2 py-3 text-xs text-zinc-600">暂无目标。</div>)}
        </div>
      </div>
    </div>
  )
}
