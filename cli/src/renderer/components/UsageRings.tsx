import { useCallback, useEffect, useRef, useState } from 'react'
import { useUiStore } from '../store/uiStore'
import type { PlanUsageInfo, UsageLimitWindow } from '../../shared/ipc'

/** 状态栏迷你用量圆环（kimi web 式）：5h 滚动窗口 + 每周额度两个小 SVG 环，
 *  悬停浮出非模态预览卡（无 backdrop、不阻断对话、移走即关），点击钉住。
 *  数据走 forge:getPlanUsage（主进程 60s 缓存，悬停刷新门槛低）。 */

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

function resetLabel(resetAt?: number): string | null {
  if (!resetAt) return null
  const ms = resetAt - Date.now()
  if (ms <= 0) return '即将重置'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}小时后重置`
  return `${hours}h ${minutes}m后重置`
}

const MEMBERSHIP_LABELS: Record<string, string> = {
  LEVEL_FREE: '免费版',
  LEVEL_BASIC: '基础会员',
  LEVEL_INTERMEDIATE: '中级会员',
  LEVEL_ADVANCED: '高级会员'
}

function membershipLabel(level: string | undefined): string | null {
  if (!level) return null
  return MEMBERSHIP_LABELS[level] ?? level
}

function windowPct(window: UsageLimitWindow | undefined): number | null {
  if (!window || window.used === undefined || !window.limit) return null
  return Math.min(100, Math.round((window.used / window.limit) * 100))
}

function UsageBar({ pct }: { pct: number | null }): JSX.Element {
  const danger = pct !== null && pct >= 80
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct ?? 0}%`,
          background: danger
            ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
            : 'linear-gradient(90deg, #8b5cf6, #a78bfa)'
        }}
      />
    </div>
  )
}

function LimitRow({ title, window }: { title: string; window: UsageLimitWindow }): JSX.Element {
  const pct = windowPct(window)
  const reset = resetLabel(window.resetAt)
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-zinc-400">{title}</span>
        <span className="text-zinc-500">
          {pct !== null ? `${pct}%` : '—'}
          {reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <UsageBar pct={pct} />
      <div className="mt-1 text-[11px] text-zinc-600">
        {window.used !== undefined ? fmtK(window.used) : '—'} / {window.limit ? fmtK(window.limit) : '—'}
        {window.remaining !== undefined ? ` · 剩余 ${fmtK(window.remaining)}` : ''}
      </div>
    </div>
  )
}

/** 单个小圆环：pct 为 null 时置灰显示"—"（无数据）。 */
function Ring({ pct, label, danger }: { pct: number | null; label: string; danger: boolean }): JSX.Element {
  const r = 6.5
  const c = 2 * Math.PI * r
  const frac = (pct ?? 0) / 100
  return (
    <span className="flex items-center gap-1" aria-hidden>
      <svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0">
        <circle cx="10" cy="10" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2.4" />
        {pct !== null && (
          <circle
            cx="10"
            cy="10"
            r={r}
            fill="none"
            stroke={danger ? '#ef4444' : '#8b5cf6'}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={`${(frac * c).toFixed(2)} ${c.toFixed(2)}`}
            transform="rotate(-90 10 10)"
          />
        )}
        {pct === null && (
          <text x="10" y="12.5" textAnchor="middle" fontSize="7" fill="rgb(82 82 91)">
            —
          </text>
        )}
      </svg>
      <span className="text-[9px] text-zinc-500">{label}</span>
    </span>
  )
}

export default function UsageRings(): JSX.Element {
  const pinned = useUiStore((s) => s.usageOpen)
  const setPinned = useUiStore((s) => s.setUsageOpen)
  const [hover, setHover] = useState(false)
  const [plan, setPlan] = useState<PlanUsageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback((): void => {
    void window.api
      .getPlanUsage()
      .then((result) => {
        if (result.ok) {
          setPlan(result.data)
          setError(null)
        } else {
          setError(result.error)
        }
      })
      .catch(() => setError('网络错误，无法连接 Kimi 云端接口'))
  }, [])

  // 挂载拉一次（主进程有缓存，便宜）；预览打开时再拉（>30s 会触发后台刷新）。
  useEffect(() => refresh(), [refresh])
  const open = hover || pinned
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // 钉住状态下点击组件外任意处关闭（无 backdrop，不阻断对话）。
  useEffect(() => {
    if (!pinned) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [pinned, setPinned])

  const rollingPct = windowPct(plan?.rolling)
  const weeklyPct = windowPct(plan?.weekly)
  const membership = membershipLabel(plan?.membershipLevel)

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
        className="flex items-center gap-2 rounded px-1.5 py-0.5 transition hover:bg-white/[0.06]"
        title="套餐用量（悬停预览，点击钉住）"
        aria-expanded={open}
      >
        <Ring pct={rollingPct} label="5h" danger={rollingPct !== null && rollingPct >= 80} />
        <Ring pct={weeklyPct} label="周" danger={weeklyPct !== null && weeklyPct >= 80} />
      </button>

      {open && (
        <div className="glass-panel tran-enter absolute bottom-full right-0 z-[90] mb-2 w-72 rounded-2xl p-4 shadow-2xl">
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="flex-1 text-xs font-semibold text-zinc-100">套餐用量</span>
            {membership && (
              <span className="rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                {membership}
              </span>
            )}
          </div>
          {error && (
            <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
              {error}
            </div>
          )}
          <div className="space-y-3">
            {plan?.rolling && <LimitRow title={`${plan.rolling.label}滚动窗口`} window={plan.rolling} />}
            {plan?.weekly && <LimitRow title="每周额度" window={plan.weekly} />}
            {plan?.parallelLimit !== undefined && (
              <div className="text-xs text-zinc-500">并行任务上限：{plan.parallelLimit}</div>
            )}
            {!error && !plan?.rolling && !plan?.weekly && (
              <p className="text-xs text-zinc-600">云端未返回额度数据。</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
