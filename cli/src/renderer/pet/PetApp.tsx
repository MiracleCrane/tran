import { useEffect, useRef, useState } from 'react'
import type { PetMood, PetState } from '../../shared/ipc'
import swayingCatUrl from '../assets/pet/swaying-cat-alpha.webp'
import swayingCatStillUrl from '../assets/pet/swaying-cat-still.png'

/**
 * 桌面宠物窗口（「Tran 以外」的展示位）的页面：一只魔性摇摆猫 + 状态气泡。
 * 与界面内 PetMascot 同素材同情绪，状态经主进程 pet:state 推过来。
 *
 * 素材：三段式抠图的真透明动画 webp（墨镜/腿完好），无限循环；首尾淡出帧
 * 的 alpha 已按帧亮度缩放——循环点是人物自然隐现，没有黑闪。waiting 换同帧
 * 定格 PNG（叠放切换避免解码闪烁）。
 *
 * 拖拽（2026-08-20 第三版）：pointermove 累计 movementX/Y，rAF 合帧上报主
 * 进程 setPosition；拖动期间切定格帧（动画合成开销是"卡"的主因）。
 * -webkit-app-region:drag 在透明窗口上不生效（Chromium 限制），别走回头路。
 * stage 的 1% 白底让全窗都能命中（透明像素在分层窗口上点不到）。
 */

const BUBBLE_FALLBACK: Record<Exclude<PetMood, 'idle'>, string> = {
  working: '正在干活…',
  waiting: '等你回话',
  done: '搞定了',
  error: '出错了'
}

const CSS = `
  html, body, #root { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  .pet-stage {
    position: relative; width: 100%; height: 100%;
    display: flex; align-items: flex-end; justify-content: center;
    cursor: grab; user-select: none; -webkit-user-select: none;
    touch-action: none;
    /* Windows 分层窗口按像素 alpha 命中：全透明区域点不到。1% 白 =
       肉眼不可见的全窗可点（拖哪、右键哪都行）。 */
    background: rgba(255, 255, 255, 0.012);
  }
  .pet-stage.dragging { cursor: grabbing; }
  .pet-img {
    width: 90px; height: auto; display: block; pointer-events: none;
    transition: opacity 180ms ease, filter 180ms ease;
  }
  .pet-img.top { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); }
  .pet-stage.mood-error .pet-img { filter: grayscale(.85) brightness(.92); }
  .pet-bubble {
    position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
    max-width: 108px; padding: 4px 8px; border-radius: 10px;
    background: rgba(22, 20, 31, .88); border: 1px solid rgba(255, 255, 255, .14);
    color: #f3f1fa; font: 11px/1.5 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
    pointer-events: none;
  }
  .pet-bubble::after {
    content: ''; position: absolute; bottom: -4px; left: 50%; margin-left: -4px;
    width: 8px; height: 8px; transform: rotate(45deg);
    background: rgba(22, 20, 31, .88); border-right: 1px solid rgba(255, 255, 255, .14);
    border-bottom: 1px solid rgba(255, 255, 255, .14);
  }
  .pet-bubble.mood-error { border-color: rgba(248, 113, 113, .5); color: #fecaca; }
  .pet-bubble.mood-done { border-color: rgba(74, 222, 128, .45); color: #bbf7d0; }
`

export default function PetApp(): JSX.Element {
  const [state, setState] = useState<PetState>({ mood: 'idle' })
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** rAF 合帧用的增量累计与帧句柄。 */
  const pendingDelta = useRef({ dx: 0, dy: 0 })
  const rafId = useRef(0)

  useEffect(() => {
    if (!window.petApi) return
    return window.petApi.onState(setState)
  }, [])

  useEffect(() => {
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current)
    }
  }, [])

  const flushDelta = (): void => {
    rafId.current = 0
    const { dx, dy } = pendingDelta.current
    if ((dx !== 0 || dy !== 0) && window.petApi) {
      window.petApi.dragDelta({ dx, dy })
    }
    pendingDelta.current = { dx: 0, dy: 0 }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !window.petApi) return
    setDragging(true)
    // setPointerCapture 在 focusable:false 的透明窗口上可能抛错——优化项，
    // 绝不能阻断拖拽（窗口就巴掌大，移动/抬起总会进这个 div）。
    try {
      stageRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 见上 */
    }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging || !window.petApi) return
    pendingDelta.current.dx += e.movementX
    pendingDelta.current.dy += e.movementY
    if (!rafId.current) rafId.current = requestAnimationFrame(flushDelta)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setDragging(false)
    if (rafId.current) {
      cancelAnimationFrame(rafId.current)
      rafId.current = 0
    }
    flushDelta()
    try {
      stageRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* 与按下处同理 */
    }
    window.petApi?.dragEnd()
  }

  // 动画层：waiting 或拖拽中显示定格（拖拽时动画合成是卡的主因）
  const animated = state.mood !== 'waiting' && !dragging
  const bubble = state.mood === 'idle' ? null : (state.label ?? BUBBLE_FALLBACK[state.mood])

  return (
    <div
      ref={stageRef}
      className={`pet-stage mood-${state.mood}${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault()
        window.petApi?.openContextMenu()
      }}
    >
      <style>{CSS}</style>
      {bubble && <div className={`pet-bubble mood-${state.mood}`}>{bubble}</div>}
      <img className="pet-img" src={swayingCatStillUrl} alt="" draggable={false}
        style={{ opacity: animated ? 0 : 1 }} />
      <img className="pet-img top" src={swayingCatUrl} alt="" draggable={false}
        style={{ opacity: animated ? 1 : 0 }} />
    </div>
  )
}
