import { useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import { onOpenChangesPanel } from '../events'
import GitToolbar from './GitToolbar'
import PlanCard from './PlanCard'
import GoalCard from './GoalCard'

/**
 * 右侧停靠面板（2026-08-17，zcode/Codex 式布局）：Git 工具 / 待办 / 目标从右缘
 * 滑出，顶栏右侧三个图标切换。原先这三块常驻正文上方吃纵向空间（整条
 * GitToolbar + GoalCard + 待办卡），现在正文默认独占全高。
 *
 * 面板常驻挂载、收起只是位移出屏——GitToolbar 的轮询与 openChangesPanel 监听
 * 不能掉（SessionChangesPill 的「审核」靠它展开改动抽屉）。
 */
export default function RightDock(): JSX.Element | null {
  const dock = useUiStore((s) => s.rightDock)
  const setRightDock = useUiStore((s) => s.setRightDock)
  const planCount = useSessionStore((s) => s.planEntries.length)
  const goal = useSessionStore((s) => s.goal)

  // 「审核改动」入口（改动胶囊 / 轮次改动卡）→ 打开 dock 的 Git 页。
  useEffect(() => onOpenChangesPanel(() => setRightDock('git')), [setRightDock])

  const open = dock !== null
  const title = dock === 'git' ? 'Git 工具' : dock === 'plan' ? '待办' : '目标'
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
          <button
            type="button"
            onClick={() => setRightDock(null)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
            title="收起"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {/* GitToolbar 常驻挂载（见文件头注释），只切显隐。 */}
          <div className={dock === 'git' ? '' : 'hidden'}>
            <GitToolbar docked />
          </div>
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
