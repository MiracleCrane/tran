import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** 画任务栏角标：深色圆底 + 白色数字（Codex 风格）。64px 绘制，高分屏不糊。 */
function drawBadge(count: number): string {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const r = size / 2
  ctx.beginPath()
  ctx.arc(r, r, r - 2, 0, Math.PI * 2)
  ctx.fillStyle = '#1f1f23'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 ${count > 9 ? 30 : 38}px "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 9 ? '9+' : String(count), r, r + 2)
  return canvas.toDataURL('image/png')
}

/**
 * 每轮回答完且窗口不在前台时，给任务栏图标打一个 Codex 式数字角标
 * （2026-08-18 用户：「每轮对话你回答完了能够像 codex 一样有个小标」）。
 * 计数连续累计（前台连着完成 N 轮才切走也能看到 N）；聚焦即清零——渲染层
 * 清计数，图标本身由主进程的 focus 监听复位（见 main/index.ts）。
 */
export function useTaskbarBadge(): void {
  const running = useSessionStore((s) => s.status.running)
  const prevRunningRef = useRef(running)
  const countRef = useRef(0)

  useEffect(() => {
    const reset = (): void => {
      countRef.current = 0
    }
    window.addEventListener('focus', reset)
    return () => window.removeEventListener('focus', reset)
  }, [])

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (!wasRunning || running) return
    // 轮刚结束。前台看着就不打标，顺手清掉旧计数（回到前台也算"已读"）。
    if (document.hasFocus()) {
      countRef.current = 0
      return
    }
    countRef.current += 1
    const dataUrl = drawBadge(countRef.current)
    if (dataUrl) {
      void window.api.setOverlayBadge(
        dataUrl,
        countRef.current > 1 ? `${countRef.current} 轮回复已完成` : '回复已完成'
      )
    }
  }, [running])
}
