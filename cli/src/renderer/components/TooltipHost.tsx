import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 全局自定义 tooltip：替换浏览器原生 title（2026-08-17 用户：「悬停预览不要
 *  那种网页默认感」）。capture 阶段拦 [title] 元素：暂存并清空 title（原生
 *  提示就此压住），悬停 350ms 后在元素上方浮出深色小卡（贴顶不足 72px 翻到
 *  下方、clamp 拉跑时右缘对齐触发元素右缘，同 HoverTip 规则）；移开/按下即关并还原。 */
export default function TooltipHost(): JSX.Element | null {
  const [tip, setTip] = useState<{
    text: string
    x: number
    right: number
    top: number
    bottom: number
    below: boolean
    alignRight: boolean
  } | null>(null)
  const timerRef = useRef<number | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const t = targetRef.current
      if (t?.dataset.tranTip) {
        t.setAttribute('title', t.dataset.tranTip)
        delete t.dataset.tranTip
      }
      targetRef.current = null
      setTip(null)
    }
    const onOver = (e: PointerEvent): void => {
      const el = (e.target as HTMLElement).closest?.('[title]') as HTMLElement | null
      const text = el?.getAttribute('title')?.trim()
      if (!el || !text) {
        if (targetRef.current) clear()
        return
      }
      if (targetRef.current === el) return
      clear()
      targetRef.current = el
      el.dataset.tranTip = text
      el.removeAttribute('title')
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        const r = el.getBoundingClientRect()
        // 2026-09-02 同步 HoverTip 的定位规则（「气泡离触发元素老远」全面排查）：
        // max-w 280px，clamp 会把左缘拉离触发元素时改右缘贴触发元素右缘；触发
        // 元素贴顶（上方不足 72px）时翻到下方——原先只有 -translate-y-full 的
        // 上方摆位，贴顶时整条气泡出屏。
        const alignRight = r.left + 288 > window.innerWidth - 8
        setTip({
          text,
          x: Math.max(8, Math.min(r.left, window.innerWidth - 290)),
          right: window.innerWidth - r.right,
          top: r.top,
          bottom: r.bottom,
          below: r.top < 72,
          alignRight
        })
      }, 350)
    }
    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerdown', clear, true)
    return () => {
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerdown', clear, true)
      clear()
    }
  }, [])

  if (!tip) return null
  return createPortal(
    <div
      className={`pointer-events-none fixed z-[200] max-w-[280px] whitespace-pre-wrap break-words rounded-lg border border-white/[0.08] bg-[#232323] px-2 py-1 text-[11px] leading-snug text-zinc-300 shadow-xl shadow-black/40${tip.below ? '' : ' -translate-y-full'}`}
      style={{
        ...(tip.alignRight ? { right: tip.right } : { left: tip.x }),
        top: tip.below ? tip.bottom + 6 : tip.top - 6
      }}
    >
      {tip.text}
    </div>,
    document.body
  )
}
