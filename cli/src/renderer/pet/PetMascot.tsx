import { useEffect, useRef, useState } from 'react'
import { usePetStore } from '../store/petStore'
import { useUiStore } from '../store/uiStore'
import swayingCatUrl from '../assets/pet/swaying-cat-repaired.webm'
import PetAlphaFilter, { PET_ALPHA_FILTER_URL } from './PetAlphaFilter'
import HoverTip from '../components/HoverTip'
import { useDraggablePetPosition } from './useDraggablePetPosition'

/**
 * Tran 界面内的宠物形象（主战场，2026-08-20 用户：「主要是在 tran 界面里面
 * 去舞动」）：聊天视图右下角一只无缝循环的摇摆猫，情绪与桌面悬浮窗同源
 * （usePetReporter → petStore）。
 *
 * 素材：使用 libvpx-vp9 保留原始 alpha 的透明 WebM。完整可见动作全部保留，
 * 短时闪帧经九帧多数判定修补，首尾只重叠 10 帧做预乘 alpha 交叉淡化；
 * waiting 直接暂停当前视频帧，不再切换静态图层。error 灰度。
 *
 * 仅宠物自身的 90px 区域接收拖动，不占用其余聊天区；位置持久化并在窗口缩放
 * 时自动收回可视范围。
 *
 * 宠物只有一只，跟焦点走：「Tran 以外展示」开着时，主窗口失焦/最小化则这里
 * 让位给桌面悬浮窗（主进程 petWindow 同步出场），回前台再换回来。悬浮窗
 * focusable:false 不抢焦点，window 的 focus/blur 不会因它乒乓。
 */
export default function PetMascot(): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const mood = usePetStore((s) => s.mood)
  const previousMoodRef = useRef(mood)
  const label = usePetStore((s) => s.label)
  const masterEnabled = usePetStore((s) => s.masterEnabled)
  const outsideEnabled = usePetStore((s) => s.outsideEnabled)
  const view = useUiStore((s) => s.view)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const {
    elementRef,
    position,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp
  } = useDraggablePetPosition()

  useEffect(() => {
    if (!outsideEnabled) return
    const onFocus = (): void => setWindowFocused(true)
    const onBlur = (): void => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [outsideEnabled])

  const visible = masterEnabled && view === 'chat' && (!outsideEnabled || windowFocused)
  const animated = mood !== 'waiting' && !dragging

  useEffect(() => {
    const previousMood = previousMoodRef.current
    previousMoodRef.current = mood
    if (!visible) return
    const video = videoRef.current
    if (!video) return
    if (mood === 'working' && previousMood !== 'working') video.currentTime = 0
    if (animated) void video.play().catch(() => undefined)
    else video.pause()
  }, [animated, mood, visible])

  if (!visible) return null

  return (
    <div
      ref={elementRef}
      className={`pointer-events-auto fixed z-30 flex w-[90px] touch-none select-none flex-col items-center ${
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      style={{ right: position.right, bottom: position.bottom }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* 原生 title= 全 app 禁用；外层是 fixed 定位，HoverTip 包在内部
          （包外面的话零尺寸行内 span 量不到位置）。 */}
      <HoverTip tip="拖动宠物" className="flex w-full flex-col items-center">
        {mood !== 'idle' && label && (
          <div className="mb-1.5 max-w-[120px] truncate rounded-xl border border-white/10 bg-[#16141f]/90 px-2.5 py-1 text-[11px] text-zinc-200 shadow-lg">
            {label}
          </div>
        )}
        <div className={mood === 'error' ? 'grayscale-[.85] brightness-[.92]' : ''}>
          <PetAlphaFilter />
          <video
            ref={videoRef}
            src={swayingCatUrl}
            draggable={false}
            className="block w-[90px] bg-transparent"
            style={{ filter: PET_ALPHA_FILTER_URL }}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden
          />
        </div>
      </HoverTip>
    </div>
  )
}
