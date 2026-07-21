import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CompactionItem } from '../types'
import { fmtK } from '../utils/format'

/** 上下文压缩分界线（kimi web 式）：左右渐变细线 + 中间统计 + 右侧"查看摘要"
 *  链接，点击弹非模态详情卡（portal；kimi 不给摘要正文，只有统计数据）。 */

const CompactionDivider = memo(function CompactionDivider({
  item
}: {
  item: CompactionItem
}): JSX.Element {
  const [cardOpen, setCardOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const linkRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const openCard = (): void => {
    const rect = linkRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
        bottom: window.innerHeight - rect.top + 6
      })
    }
    setCardOpen(true)
  }

  // 点击卡片外任意处关闭（无 backdrop，非模态）。
  useEffect(() => {
    if (!cardOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (linkRef.current?.contains(target) || cardRef.current?.contains(target)) return
      setCardOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [cardOpen])

  const before = item.tokensBefore
  const after = item.tokensAfter
  const ratio =
    before && after ? `${Math.round((after / before) * 100)}%` : null

  return (
    <div className="my-2 flex items-center gap-2 text-[11px] text-zinc-500">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/25 to-accent/40" />
      <span className="shrink-0">
        上下文已压缩
        {before !== undefined && after !== undefined
          ? `（${fmtK(before)} → ${fmtK(after)} tokens）`
          : ''}
      </span>
      <button
        ref={linkRef}
        type="button"
        onClick={() => (cardOpen ? setCardOpen(false) : openCard())}
        className="shrink-0 text-accent transition hover:brightness-125"
      >
        查看摘要
      </button>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-accent/25 to-accent/40" />
      {cardOpen && anchor && createPortal(
        <div
          ref={cardRef}
          className="glass-panel tran-enter fixed z-[90] w-64 rounded-2xl p-4 shadow-2xl"
          style={{ left: anchor.left, bottom: anchor.bottom }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="text-xs font-semibold text-zinc-100">压缩详情</span>
          </div>
          <div className="space-y-1.5 text-[11px] text-zinc-400">
            {item.messagesCompacted !== undefined && (
              <div className="flex justify-between"><span>压缩消息数</span><span className="text-zinc-200">{item.messagesCompacted}</span></div>
            )}
            {before !== undefined && (
              <div className="flex justify-between"><span>压缩前</span><span className="text-zinc-200">{before.toLocaleString()} tokens</span></div>
            )}
            {after !== undefined && (
              <div className="flex justify-between"><span>压缩后</span><span className="text-zinc-200">{after.toLocaleString()} tokens</span></div>
            )}
            {ratio && (
              <div className="flex justify-between"><span>压缩比</span><span className="text-zinc-200">{ratio}</span></div>
            )}
            <div className="flex justify-between"><span>时间</span><span className="text-zinc-200">{new Date(item.at).toLocaleTimeString()}</span></div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
})

export default CompactionDivider
