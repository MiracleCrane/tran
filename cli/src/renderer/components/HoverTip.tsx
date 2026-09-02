import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 悬停气泡（2026-08-25：用户嫌原生 title= 提示丑——「悬停还是丑丑的」）。
 * 视觉与 Transcript 的 GroupNoteText 气泡同款：深色玻璃圆角、~120ms 淡入、
 * portal 挂 body 逃出祖先 overflow 裁剪。默认在触发元素上方，贴顶不足 72px
 * 时翻到下方。2026-09-01 破例加 preferBelow：会话改动 pill 悬停时上方气泡
 * 会盖住 Transcript 末尾文字（用户：「这边挡住了」），pill 下方是 Composer
 * 空白区，强制朝下。
 *
 * 用法：<HoverTip tip="提示全文">…触发元素…</HoverTip>
 */
export default function HoverTip({
  tip,
  children,
  className = 'inline-flex',
  tipClassName,
  preferBelow = false
}: {
  tip: ReactNode
  children: ReactNode
  /** 包裹层 class：触发元素是整行/块级时传 'block' / 'flex w-full' 之类。 */
  className?: string
  /** 气泡本身的追加 class（如路径需要 break-all）。 */
  tipClassName?: string
  /** 强制放触发元素下方（上方会遮挡重要内容时使用）。 */
  preferBelow?: boolean
}): JSX.Element {
  const [pos, setPos] = useState<{ left: number; right: number; top: number; below: boolean; alignRight: boolean } | null>(null)
  const [shown, setShown] = useState(false)

  const hide = (): void => {
    setPos(null)
    setShown(false)
  }

  const show = (event: MouseEvent<HTMLSpanElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    // 默认放上方（bottom 锚定，不用量气泡高度）；上方贴顶不够 72px 才翻到下边。
    const below = preferBelow || rect.top < 72
    // max-w-md = 448px。2026-09-02 修「气泡离触发元素老远」（用户截图：右侧的
    // MD 复制钮/待办钮的气泡跑到左边）：clamp 会把左侧拉离触发元素时改为**右缘
    // 对齐**（气泡右缘贴触发元素右缘），短气泡就正好悬在触发元素上方。
    const alignRight = rect.left + 456 > window.innerWidth - 8
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 456))
    setPos({ left, right: window.innerWidth - rect.right, top: below ? rect.bottom + 6 : rect.top - 6, below, alignRight })
  }

  // 挂载后下一帧再转正透明度/位移，做出 ~120ms 淡入。
  useEffect(() => {
    if (!pos) return
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [pos])

  // 滚动（捕获阶段，滚动容器也接得到）时收起；卸载随 effect 清理。
  useEffect(() => {
    if (!pos) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [pos])

  return (
    <span className={className} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos &&
        createPortal(
          <div
            className={`pointer-events-none fixed z-[100] max-w-md whitespace-normal rounded-lg border border-white/10 bg-zinc-900/95 px-2.5 py-1.5 text-xs text-zinc-300 shadow-xl backdrop-blur transition duration-[120ms] ease-out ${
              shown ? 'translate-y-0 opacity-100' : `opacity-0 ${pos.below ? '-translate-y-1' : 'translate-y-1'}`
            }${tipClassName ? ` ${tipClassName}` : ''}`}
            style={
              pos.below
                ? pos.alignRight
                  ? { right: pos.right, top: pos.top }
                  : { left: pos.left, top: pos.top }
                : pos.alignRight
                  ? { right: pos.right, bottom: window.innerHeight - pos.top }
                  : { left: pos.left, bottom: window.innerHeight - pos.top }
            }
          >
            {tip}
          </div>,
          document.body
        )}
    </span>
  )
}
