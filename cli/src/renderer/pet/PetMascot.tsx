import { useEffect, useRef } from 'react'
import { usePetStore } from '../store/petStore'
import { useUiStore } from '../store/uiStore'
import swayingCatUrl from '../assets/pet/swaying-cat-repaired.webm'

/**
 * Tran 界面内的宠物形象（主战场，2026-08-20 用户：「主要是在 tran 界面里面
 * 去舞动」）：聊天视图右下角一只无缝循环的摇摆猫，情绪与桌面悬浮窗同源
 * （usePetReporter → petStore）。
 *
 * 素材：使用 libvpx-vp9 保留原始 alpha 的透明 WebM。短时闪帧经五帧离群修补，
 * 从两个相似姿势间截取纯正向循环并用 6 帧预乘 alpha 过渡衔接；waiting 直接
 * 暂停当前视频帧，不再切换静态图层。error 灰度。
 *
 * 纯展示、pointer-events-none：永远不挡聊天区/输入框的点击；想关掉走
 * 设置 → 系统 → 桌面宠物。
 */
export default function PetMascot(): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const mood = usePetStore((s) => s.mood)
  const previousMoodRef = useRef(mood)
  const label = usePetStore((s) => s.label)
  const masterEnabled = usePetStore((s) => s.masterEnabled)
  const view = useUiStore((s) => s.view)

  const visible = masterEnabled && view === 'chat'
  const animated = mood !== 'waiting'

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
    <div className="pointer-events-none fixed bottom-24 right-4 z-30 flex w-[90px] select-none flex-col items-center">
      {mood !== 'idle' && label && (
        <div className="mb-1.5 max-w-[120px] truncate rounded-xl border border-white/10 bg-[#16141f]/90 px-2.5 py-1 text-[11px] text-zinc-200 shadow-lg">
          {label}
        </div>
      )}
      <div className={mood === 'error' ? 'grayscale-[.85] brightness-[.92]' : ''}>
        <svg className="pointer-events-none absolute h-0 w-0" aria-hidden>
          <filter id="tran-pet-alpha-clean" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncA type="linear" slope="1.02" intercept="-0.02" />
            </feComponentTransfer>
          </filter>
        </svg>
        <video
          ref={videoRef}
          src={swayingCatUrl}
          draggable={false}
          className="block w-[90px] bg-transparent"
          style={{ filter: 'url(#tran-pet-alpha-clean)' }}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
        />
      </div>
    </div>
  )
}
