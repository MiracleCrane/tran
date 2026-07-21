import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** "模式"按钮 + 上浮现小面板（kimi web 双控件设计的右半）：三个独立开关行
 *  —— 计划（真实，ACP mode='plan'，与权限档互斥、关闭恢复）、Swarm（本地
 *  提示词注入）、目标（占位，下一版本提供）。非模态，点外部关闭。 */

const PlanIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
)
const SwarmIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path
      d="M18.5 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
)
const GoalIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 12h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
)

/** 小开关：只动 transform，200ms。 */
function ModeSwitch({
  checked,
  disabled = false,
  onChange
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-accent/70' : 'bg-white/15'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-200 ${
          checked ? 'translate-x-3' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function ModeRow({
  icon,
  title,
  desc,
  checked,
  disabled = false,
  onChange
}: {
  icon: JSX.Element
  title: string
  desc: string
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <div className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 ${disabled ? 'opacity-60' : ''}`}>
      <span className="shrink-0 text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-zinc-200">{title}</span>
        <span className="block text-[10px] leading-snug text-zinc-500">{desc}</span>
      </span>
      <ModeSwitch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

export default function ModePanel(): JSX.Element | null {
  const meta = useSessionStore((s) => s.meta)
  const modePanel = useSessionStore((s) => s.modePanel)
  const setPlanEnabled = useSessionStore((s) => s.setPlanEnabled)
  const setSwarmEnabled = useSessionStore((s) => s.setSwarmEnabled)
  const setGoalEnabled = useSessionStore((s) => s.setGoalEnabled)
  const [open, setOpen] = useState(false)
  if (!meta) return null

  const planOn = meta.permissionMode === 'plan'
  const anyOn = planOn || modePanel.swarmEnabled

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`glass-control flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] transition ${
          anyOn ? 'border-accent/50 text-accent' : 'text-zinc-300'
        }`}
        title="模式：计划 / Swarm / 目标"
      >
        模式
        {anyOn && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
      {open && (
        <>
          {/* click-outside 捕获层（无 backdrop 变暗，非模态） */}
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div className="glass-panel tran-enter absolute bottom-full right-0 z-[80] mb-2 w-80 rounded-2xl p-1.5 shadow-2xl">
            <ModeRow
              icon={<PlanIcon />}
              title="计划"
              desc="先让智能体梳理计划，再修改文件"
              checked={planOn}
              onChange={(on) => void setPlanEnabled(on)}
            />
            <ModeRow
              icon={<SwarmIcon />}
              title="Swarm"
              desc="并行运行多个智能体，适合大范围探索"
              checked={modePanel.swarmEnabled}
              onChange={(on) => void setSwarmEnabled(on)}
            />
            <ModeRow
              icon={<GoalIcon />}
              title="目标"
              desc="持续跟踪一个目标，直到任务完成 · 下一版本提供"
              checked={modePanel.goalEnabled}
              disabled
              onChange={(on) => void setGoalEnabled(on)}
            />
          </div>
        </>
      )}
    </div>
  )
}
