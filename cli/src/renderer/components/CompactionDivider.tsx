import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CompactionItem } from '../types'
import { useSessionStore } from '../store/sessionStore'
import { formatMessageTime, formatTimeFull } from '../utils/messageTimes'

// 2026-08-27 用户定夺：折叠 bar 只允许鼠标点击开合，不接受键盘激活（鼠标点过后
// 焦点留在 button 上，Enter/Space 会被原生 button 行为当成再次点击而误开合）。
// 拦掉这两个键的默认激活，焦点（tab 可达）与 onClick 都不动。
// 与 Transcript.tsx 的同名 helper 各持一份（跨文件引会有循环依赖）。
const blockBarKeyboardActivation = (event: ReactKeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === ' ') event.preventDefault()
}

/** 上下文压缩卡（2026-08-27 重设计，用户反馈：英文原文直渲 + 详情卡只有时间
 *  「根本没有意义」）：
 *  - 默认一行安静的中文折叠行：⚡ 上下文已压缩 · 前 → 后 tokens · 消息数 · 时间；
 *    英文提示原文在 sessionStore 吞并，不再以普通回复渲染。
 *  - 点击展开非模态详情卡（portal）：时间 / 压缩前后 tokens / 消息数 / 压缩比例，
 *    外加「当前上下文」实时占用（contextUsage，反映当下而非压缩时刻，已标注）；
 *    摘要正文收在卡内「查看摘要」二级开关后面。
 *  - 降级：统计缺失的压缩事件（历史 wire 通道无统计）只显示有的字段，至少
 *    保住时间 + 当前上下文。 */

function StatRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="text-right text-zinc-200">{value}</span>
    </div>
  )
}

const CompactionDivider = memo(function CompactionDivider({
  item
}: {
  item: CompactionItem
}): JSX.Element {
  const [cardOpen, setCardOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const rowRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const contextUsage = useSessionStore((s) => s.contextUsage)

  const openCard = (): void => {
    const rect = rowRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 340)),
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
      if (rowRef.current?.contains(target) || cardRef.current?.contains(target)) return
      setCardOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [cardOpen])

  const before = item.tokensBefore
  const after = item.tokensAfter
  const ratio =
    before !== undefined && after !== undefined && before > 0
      ? `${Math.round((after / before) * 100)}%`
      : null
  const contextPct =
    contextUsage && contextUsage.total > 0
      ? Math.min(100, (contextUsage.used / contextUsage.total) * 100)
      : null

  return (
    <div className="my-2 flex items-center gap-2 text-[11px] text-zinc-500">
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/25 to-accent/40" />
      <button
        ref={rowRef}
        type="button"
        onClick={() => (cardOpen ? setCardOpen(false) : openCard())}
        onKeyDown={blockBarKeyboardActivation}
        className="flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 transition hover:bg-white/[0.04] hover:text-zinc-300"
      >
        <span className="text-accent">⚡</span>
        <span>上下文已压缩</span>
        {before !== undefined && after !== undefined && (
          <span className="text-zinc-600">
            · {before.toLocaleString()} → {after.toLocaleString()} tokens
          </span>
        )}
        {item.messagesCompacted !== undefined && (
          <span className="text-zinc-600">· {item.messagesCompacted.toLocaleString()} 条消息</span>
        )}
        <span className="text-zinc-600">· {formatMessageTime(item.at)}</span>
        <span className={`text-[9px] text-zinc-600 transition-transform ${cardOpen ? 'rotate-90' : ''}`}>▶</span>
      </button>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-accent/25 to-accent/40" />
      {cardOpen && anchor && createPortal(
        <div
          ref={cardRef}
          className="glass-panel tran-enter fixed z-[90] w-80 rounded-2xl p-4 shadow-2xl"
          style={{ left: anchor.left, bottom: anchor.bottom }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="text-xs font-semibold text-zinc-100">压缩详情</span>
          </div>
          <div className="space-y-1.5 text-[11px] text-zinc-400">
            {before !== undefined && (
              <StatRow label="压缩前" value={`${before.toLocaleString()} tokens`} />
            )}
            {after !== undefined && (
              <StatRow label="压缩后" value={`${after.toLocaleString()} tokens`} />
            )}
            {item.messagesCompacted !== undefined && (
              <StatRow label="压缩消息数" value={item.messagesCompacted.toLocaleString()} />
            )}
            {ratio && <StatRow label="压缩比例" value={`剩余 ${ratio}`} />}
            <StatRow label="时间" value={formatTimeFull(item.at)} />
            {contextUsage && contextPct !== null && (
              <StatRow
                label="当前上下文"
                value={`${contextUsage.usedText} / ${contextUsage.total.toLocaleString()}（${Math.round(contextPct)}%）`}
              />
            )}
          </div>
          {contextUsage && (
            <div className="mt-1.5 text-[10px] text-zinc-600">当前上下文为实时占用，非压缩时刻的值</div>
          )}
          {item.summary && (
            <div className="mt-2 border-t border-white/[0.06] pt-2">
              <button
                type="button"
                onClick={() => setSummaryOpen((v) => !v)}
                onKeyDown={blockBarKeyboardActivation}
                className="text-[11px] text-accent transition hover:brightness-125"
              >
                {summaryOpen ? '收起摘要' : '查看摘要'}
              </button>
              {summaryOpen && (
                <div className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.04] p-2 text-[11px] leading-relaxed text-zinc-300">
                  {item.summary}
                </div>
              )}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
})

export default CompactionDivider
