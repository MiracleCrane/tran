import { useEffect, useRef, useState } from 'react'
import type { PetMood, PetState } from '../../shared/ipc'
import swayingCatUrl from '../assets/pet/swaying-cat-alpha.webp'
import swayingCatStillUrl from '../assets/pet/swaying-cat-still.png'

/**
 * 桌面宠物窗口（「Tran 以外」的展示位）的页面：一只魔性摇摆猫 + 状态气泡。
 * 与界面内 PetMascot 同素材同情绪，状态经主进程 pet:state 推过来。
 *
 * 素材：边缘洪水填充抠过背景的真透明动画 webp（墨镜的封闭黑区完好），
 * 无限循环；首尾淡出是素材自带的循环衔接设计（黑场帧抠完即透明帧，
 * 循环点表现为人物自然隐现，没有黑闪）。waiting 时换成同帧定格 PNG
 * （两张图叠放透明度切换，避免换 src 的解码闪烁）。
 *
 * 交互：拖拽走 OS 原生（stage 的 -webkit-app-region:drag，见 petWindow.ts），
 * 右键出菜单。
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
    /* 拖拽交给 OS 原生（WM_NCHITTEST + app-region:drag）。
       Windows 分层窗口按像素 alpha 命中：真透明区域点不到（会穿透），
       1% 白等于肉眼不可见的"全窗可点"——拖哪都跟手，右键哪都出菜单。 */
    background: rgba(255, 255, 255, 0.012);
    -webkit-app-region: drag;
  }
  .pet-stage:active { cursor: grabbing; }
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
    /* 气泡不抢拖拽：整块 stage 都是拖拽区。 */
    -webkit-app-region: drag;
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

  useEffect(() => {
    if (!window.petApi) return
    return window.petApi.onState(setState)
  }, [])

  const animated = state.mood !== 'waiting'
  const bubble = state.mood === 'idle' ? null : (state.label ?? BUBBLE_FALLBACK[state.mood])

  return (
    <div
      className={`pet-stage mood-${state.mood}`}
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
