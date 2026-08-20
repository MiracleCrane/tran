import { usePetStore } from '../store/petStore'
import { useUiStore } from '../store/uiStore'
import swayingCatUrl from '../assets/pet/swaying-cat-alpha.webp'
import swayingCatStillUrl from '../assets/pet/swaying-cat-still.png'

/**
 * Tran 界面内的宠物形象（主战场，2026-08-20 用户：「主要是在 tran 界面里面
 * 去舞动」）：聊天视图右下角一只无缝循环的摇摆猫，情绪与桌面悬浮窗同源
 * （usePetReporter → petStore）。
 *
 * 素材：时序极值抠图的真透明动画 webp（墨镜完好），无限循环；首尾淡出是
 * 素材自带的循环衔接（透明帧自然隐现，无黑闪）。waiting 换同帧定格 PNG
 * （叠放切换避免解码闪烁），error 灰度。
 *
 * 纯展示、pointer-events-none：永远不挡聊天区/输入框的点击；想关掉走
 * 设置 → 系统 → 桌面宠物。
 */
export default function PetMascot(): JSX.Element | null {
  const mood = usePetStore((s) => s.mood)
  const label = usePetStore((s) => s.label)
  const masterEnabled = usePetStore((s) => s.masterEnabled)
  const view = useUiStore((s) => s.view)

  if (!masterEnabled || view !== 'chat') return null

  const animated = mood !== 'waiting'
  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-30 flex w-[90px] select-none flex-col items-center">
      {mood !== 'idle' && label && (
        <div className="mb-1.5 max-w-[120px] truncate rounded-xl border border-white/10 bg-[#16141f]/90 px-2.5 py-1 text-[11px] text-zinc-200 shadow-lg">
          {label}
        </div>
      )}
      <div className={`relative ${mood === 'error' ? 'grayscale-[.85] brightness-[.92]' : ''}`}>
        <img
          src={swayingCatStillUrl}
          alt=""
          draggable={false}
          className="w-[90px] transition-opacity duration-200"
          style={{ opacity: animated ? 0 : 1 }}
        />
        <img
          src={swayingCatUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 w-[90px] transition-opacity duration-200"
          style={{ opacity: animated ? 1 : 0 }}
        />
      </div>
    </div>
  )
}
