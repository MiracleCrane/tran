import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** 本轮计时条（2026-08-14 用户要求）：从思考块标题里挪出来，钉在对话区顶部
 *  ——像待办卡那样不随转录滚动，但贴左缘、轻得多（不进居中正文列的视觉中心）。
 *  只在 turn 运行中挂载：1s 心跳随组件卸载停止，空闲零成本。 */
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
    <div className="mx-auto w-full max-w-5xl px-6 pt-1.5">
      <span className="tran-turn-timer" title="本轮已运行时长">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 8.5v4.5l3 2M9 2.5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {mm}:{ss}
      </span>
    </div>
  )
}
