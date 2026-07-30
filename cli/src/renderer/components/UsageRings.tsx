import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/uiStore'
import { useSessionStore } from '../store/sessionStore'
import { fmtK } from '../utils/format'

/** 用量组件只展示 `kimi acp` 会话内隐藏 `/usage` 轮返回的数据。
 * 不读取凭证，不直连 Kimi 云端接口，也不展示 MembershipService 数据。 */
export default function UsageRings(): JSX.Element {
  const pinned = useUiStore((s) => s.usageOpen)
  const setPinned = useUiStore((s) => s.setUsageOpen)
  const contextUsage = useSessionStore((s) => s.contextUsage)
  const [hover, setHover] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const open = hover || pinned

  useEffect(() => {
    if (!open) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        right: Math.max(8, window.innerWidth - rect.right),
        bottom: window.innerHeight - rect.top + 8
      })
    }
    const sessionId = useSessionStore.getState().meta?.sessionId
    const usage = useSessionStore.getState().contextUsage
    if (sessionId && (!usage?.at || Date.now() - usage.at > 30_000)) {
      void window.api.refreshSessionUsage(sessionId).catch(() => {})
    }
  }, [open])

  useEffect(() => {
    if (!pinned) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || cardRef.current?.contains(target)) return
      setPinned(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [pinned, setPinned])

  const pct =
    contextUsage && contextUsage.total > 0
      ? Math.min(100, (contextUsage.used / contextUsage.total) * 100)
      : null
  const pctText = pct === null ? '—' : `${pct.toFixed(2)}%`

  return (
    <div
      ref={rootRef}
      className="relative ml-auto flex items-center"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={() => setPinned(!pinned)}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
        aria-expanded={open}
        title={`上下文 ${pctText}`}
      >
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.08]">
          <span
            className={`block h-full rounded-full ${pct !== null && pct >= 80 ? 'bg-red-500' : 'bg-accent'}`}
            style={{ width: `${pct ?? 0}%` }}
          />
        </span>
        <span>{pctText}</span>
      </button>

      {open && anchor && createPortal(
        <div
          ref={cardRef}
          className="glass-panel tran-enter fixed z-[90] w-80 rounded-2xl p-4 shadow-2xl"
          style={{ right: anchor.right, bottom: anchor.bottom }}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="flex-1 text-xs font-semibold text-zinc-100">会话用量</span>
          </div>

          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-zinc-400">上下文窗口</span>
                <span className="text-zinc-500">{pctText}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
                <div
                  className={`h-full rounded-full ${pct !== null && pct >= 80 ? 'bg-red-500' : 'bg-accent'}`}
                  style={{ width: `${pct ?? 0}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {contextUsage
                  ? `${contextUsage.usedText} / ${contextUsage.total.toLocaleString()}`
                  : '暂无数据；打开后会通过 kimi acp 执行一次隐藏 /usage'}
              </div>
            </div>

            {contextUsage?.inputTokens !== undefined && (
              <div className="grid grid-cols-3 gap-1.5 text-center">
                {([
                  ['输入', contextUsage.inputTokens],
                  ['输出', contextUsage.outputTokens],
                  ['缓存命中', contextUsage.cacheReadTokens]
                ] as const).map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-white/[0.06] bg-black/20 px-1.5 py-1.5">
                    <div className="text-xs font-semibold text-zinc-100">
                      {value !== undefined ? fmtK(value) : '—'}
                    </div>
                    <div className="mt-0.5 text-[9px] text-zinc-500">{label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-3 border-t border-white/[0.06] pt-2 text-[10px] text-zinc-600">
            数据仅来自 Kimi Code CLI 的 /usage
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
