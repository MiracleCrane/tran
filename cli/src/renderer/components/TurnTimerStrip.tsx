import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** 本轮计时（2026-08-17 用户要求）：悬浮在对话区左下角——输出的左边，不占
 *  纵向空间（别放顶部横条，也别塞进左侧栏）。运行中才出现，数字带流光。 */
export default function TurnTimerStrip(): JSX.Element | null {
  const running = useSessionStore((s) => s.status.running)
  const startedAt = useSessionStore((s) => s.status.startedAt)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [running])
  if (!running || !startedAt) return null
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-20">
      <span className="tran-turn-timer" title="本轮已运行时长">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 8.5v4.5l3 2M9 2.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="tran-shimmer">{mm}:{ss}</span>
      </span>
    </div>
  )
}
