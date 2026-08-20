import { useEffect, useRef, useState } from 'react'
import type { PetMood, PetState } from '../../shared/ipc'
import swayingCatUrl from '../assets/pet/swaying-cat.webp'
import swayingCatStillUrl from '../assets/pet/swaying-cat-still.png'

/**
 * 桌面宠物窗口的页面：一只魔性摇摆猫 + 状态气泡。
 *
 * 素材只有一段摇摆动画（webp 不能调速/暂停），状态差异靠三招表达：
 * - 动静切换：working/done 放动画，idle/waiting 换成第一帧定格 PNG（两张图
 *   叠放、透明度切换，避免换 src 的解码闪烁）；
 * - CSS 滤镜：error 灰度；
 * - 气泡文案：mood 对应的主体动作（idle 不出气泡）。
 *
 * 交互：整窗可拖拽（pointer 事件 → IPC 换算屏幕坐标），右键出菜单。
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
  }
  .pet-stage.dragging { cursor: grabbing; }
  .pet-img {
    width: 200px; height: auto; display: block; pointer-events: none;
    transition: opacity 180ms ease, filter 180ms ease;
  }
  .pet-img.top { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); }
  .pet-stage.mood-error .pet-img { filter: grayscale(.85) brightness(.92); }
  .pet-stage.mood-idle .pet-img, .pet-stage.mood-waiting .pet-img { filter: saturate(.82); }
  .pet-bubble {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
    max-width: 210px; padding: 6px 12px; border-radius: 12px;
    background: rgba(22, 20, 31, .88); border: 1px solid rgba(255, 255, 255, .14);
    color: #f3f1fa; font: 12px/1.5 -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
    pointer-events: none;
  }
  .pet-bubble::after {
    content: ''; position: absolute; bottom: -5px; left: 50%; margin-left: -5px;
    width: 10px; height: 10px; transform: rotate(45deg);
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
  /** 上一帧指针位置（拖拽增量用）。 */
  const lastPoint = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!window.petApi) return
    return window.petApi.onState(setState)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !window.petApi) return
    stageRef.current?.setPointerCapture(e.pointerId)
    lastPoint.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging || !window.petApi || !lastPoint.current) return
    // 只发增量：clientX 是 CSS px（与主进程 setPosition 的 DIP 同单位），
    // 混用 screenX 会在高缩放下滚雪球（见 petWindow.ts 头注）。
    const dx = e.clientX - lastPoint.current.x
    const dy = e.clientY - lastPoint.current.y
    if (dx === 0 && dy === 0) return
    lastPoint.current = { x: e.clientX, y: e.clientY }
    window.petApi.dragDelta({ dx, dy })
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    stageRef.current?.releasePointerCapture(e.pointerId)
    lastPoint.current = null
    setDragging(false)
    window.petApi?.dragEnd()
  }

  // 动画层：working/done/error 显示；定格层：idle/waiting 显示。
  const animated = state.mood === 'working' || state.mood === 'done' || state.mood === 'error'
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
