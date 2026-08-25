import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 悬停气泡（2026-08-25：用户嫌原生 title= 提示丑——「悬停还是丑丑的」）。
 * 视觉与 Transcript 的 GroupNoteText 气泡同款：深色玻璃圆角、~120ms 淡入、
 * portal 挂 body 逃出祖先 overflow 裁剪。默认在触发元素上方，贴顶不足 72px
 * 时翻到下方。刻意不做 placement 系统——这一个翻转规则够用了。
 *
 * 用法：<HoverTip tip="提示全文">…触发元素…</HoverTip>
 */
export default function HoverTip({
  tip,
  children,
  className = 'inline-flex',
  tipClassName
}: {
  tip: ReactNode
  children: ReactNode
  /** 包裹层 class：触发元素是整行/块级时传 'block' / 'flex w-full' 之类。 */
  className?: string
  /** 气泡本身的追加 class（如路径需要 break-all）。 */
  tipClassName?: string
}): JSX.Element {
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const [shown, setShown] = useState(false)

  const hide = (): void => {
    setPos(null)
    setShown(false)
  }

  const show = (event: MouseEvent<HTMLSpanElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    // 默认放上方（bottom 锚定，不用量气泡高度）；上方贴顶不够 72px 才翻到下边。
    const below = rect.top < 72
    // max-w-md = 448px，左边往屏内 clamp 一档防出屏。
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 456))
    setPos({ left, top: below ? rect.bottom + 6 : rect.top - 6, below })
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
                ? { left: pos.left, top: pos.top }
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
