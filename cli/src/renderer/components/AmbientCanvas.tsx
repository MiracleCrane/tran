import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** 氛围背景：单层 canvas 紫色漂浮粒子（alpha ≤0.06，36 个慢速光斑）。
 *  性能预算：
 *  - 粒子画在内容【之上】（z-30，同 .tran-ambient）——不参与任何 backdrop-filter
 *    采样，canvas 重绘不会触发玻璃层模糊重算（上次 44fps 的根因）。
 *  - 半 DPR 渲染（fill-rate 减半）；粒子用一次性绘制的离屏 sprite。
 *  - 流式/启动/键盘中降频到 ~10fps，空闲 ~30fps；页面隐藏/窗口 blur 完全暂停。
 *  - prefers-reduced-motion：不启动（含运行时切换，fps 探针依赖）。 */

const PARTICLE_COUNT = 24
const MAX_ALPHA = 0.055
const DPR_SCALE = 0.35
const IDLE_FRAME_MS = 66 // ~15fps（实测 30fps 的整窗 canvas 更新吃 10~15fps，降频保命）
const BUSY_FRAME_MS = 150 // ~7fps
const TYPING_BUSY_MS = 800
/** 标题栏高度（CSS px，对应 styles.css 的 .window-titlebar）。粒子层 z-30
 *  盖在标题栏之上，飘到左上角时会在品牌区罩一团紫色，看着像脏块——
 *  每帧画完把这条区域擦掉。 */
const TITLEBAR_HEIGHT_PX = 42

interface Particle {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  phase: number
}

export default function AmbientCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 离屏光斑 sprite（紫色径向渐变，只画一次）
    const sprite = document.createElement('canvas')
    sprite.width = 128
    sprite.height = 128
    const sctx = sprite.getContext('2d')!
    const grad = sctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(167, 139, 250, 0.9)')
    grad.addColorStop(0.55, 'rgba(139, 92, 246, 0.28)')
    grad.addColorStop(1, 'rgba(139, 92, 246, 0)')
    sctx.fillStyle = grad
    sctx.fillRect(0, 0, 128, 128)

    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 26 + Math.random() * 52,
      vx: (Math.random() - 0.5) * 0.000_016,
      vy: (Math.random() - 0.5) * 0.000_012,
      phase: Math.random() * Math.PI * 2
    }))

    let raf = 0
    let lastFrame = 0
    let lastKeyAt = 0
    let enabled = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const resize = (): void => {
      const scale = (window.devicePixelRatio || 1) * DPR_SCALE
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale))
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale))
    }
    resize()
    window.addEventListener('resize', resize)

    const isBusy = (): boolean => {
      const s = useSessionStore.getState()
      return s.status.running || s.starting || performance.now() - lastKeyAt < TYPING_BUSY_MS
    }

    const draw = (t: number): void => {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        p.x += p.vx * (t - lastFrame || 16)
        p.y += p.vy * (t - lastFrame || 16)
        if (p.x < -0.15) p.x += 1.3
        if (p.x > 1.15) p.x -= 1.3
        if (p.y < -0.15) p.y += 1.3
        if (p.y > 1.15) p.y -= 1.3
        ctx.globalAlpha = MAX_ALPHA * (0.55 + 0.45 * Math.sin(p.phase + t / 2600))
        const size = p.r * 2
        ctx.drawImage(sprite, p.x * w - p.r, p.y * h - p.r, size, size)
      }
      ctx.globalAlpha = 1
      // 擦掉标题栏区域：粒子层在内容之上，别让光斑盖住品牌 logo/文字。
      const scale = canvas.clientHeight > 0 ? h / canvas.clientHeight : 1
      ctx.clearRect(0, 0, w, TITLEBAR_HEIGHT_PX * scale)
    }

    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame)
      const elapsed = t - lastFrame
      if (elapsed < (isBusy() ? BUSY_FRAME_MS : IDLE_FRAME_MS)) return
      draw(t)
      lastFrame = t
    }
    const start = (): void => {
      if (!raf && enabled && !document.hidden) raf = requestAnimationFrame(frame)
    }
    const stop = (): void => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const onVisibility = (): void => (document.hidden ? stop() : start())
    const onBlur = (): void => stop()
    const onFocus = (): void => start()
    const onKey = (): void => {
      lastKeyAt = performance.now()
    }
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMotionChange = (): void => {
      enabled = !motionQuery.matches
      if (!enabled) {
        stop()
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      } else {
        start()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    window.addEventListener('keydown', onKey, { capture: true, passive: true })
    motionQuery.addEventListener('change', onMotionChange)
    start()

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onKey, { capture: true })
      motionQuery.removeEventListener('change', onMotionChange)
    }
  }, [])

  return <canvas ref={canvasRef} className="ambient-canvas" aria-hidden />
}
