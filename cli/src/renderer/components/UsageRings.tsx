import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/uiStore'
import { useSessionStore } from '../store/sessionStore'
import { fmtK } from '../utils/format'
import type { PlanUsageInfo, UsageLimitWindow } from '../../shared/ipc'

/** 状态栏迷你用量圆环（kimi web 式）：5h 滚动窗口 + 每周额度两个小 SVG 环，
 *  悬停浮出非模态预览卡（无 backdrop、不阻断对话、移走即关），点击钉住。
 *  数据走 forge:getPlanUsage（主进程 60s 缓存，悬停刷新门槛低）。 */

function resetLabel(resetAt?: number): string | null {
  if (!resetAt) return null
  const ms = resetAt - Date.now()
  if (ms <= 0) return '即将重置'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}小时后重置`
  return `${hours}h ${minutes}m后重置`
}

/** 重置的绝对时间（本地时区）：MM-DD HH:mm；重置时间跨年时带年份
 *  YYYY-MM-DD HH:mm。相对时间（resetLabel）保留，本函数做弱化补充。 */
function resetAbsLabel(resetAt?: number): string | null {
  if (!resetAt) return null
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n: number): string => String(n).padStart(2, '0')
  const body = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getFullYear() !== new Date().getFullYear() ? `${date.getFullYear()}-${body}` : body
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
  // 整数百分点：云端 used/limit 就是整数百分点（used: 42/100），诚实显示整数；
  // 控制台的两位小数来自 cookie 鉴权的另一数据源，token 拿不到。
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
  const resetAbs = resetAbsLabel(window.resetAt)
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-zinc-400">{title}</span>
        <span className="whitespace-nowrap text-zinc-500">
          {pct !== null ? `${pct}%` : '—'}
          {reset ? ` · ${reset}` : ''}
          {resetAbs && <span className="text-zinc-600">{` (${resetAbs})`}</span>}
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
function Ring({ pct, label, danger, title }: { pct: number | null; label: string; danger: boolean; title?: string }): JSX.Element {
  const r = 6.5
  const c = 2 * Math.PI * r
  const frac = (pct ?? 0) / 100
  return (
    <span className="flex items-center gap-1" aria-hidden title={title}>
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
  const cardRef = useRef<HTMLDivElement | null>(null)
  // 预览卡通过 portal 挂到 body 并用 fixed 定位——状态栏容器是 overflow:hidden
  // 的 40px 高药丸，absolute 定位的卡会被整条裁掉（用户实测"悬停无反应"的 root cause）。
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)

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
    if (open) {
      refresh()
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect) {
        setAnchor({
          right: Math.max(8, window.innerWidth - rect.right),
          bottom: window.innerHeight - rect.top + 8
        })
      }
      // 上下文用量即时化：无数据或 >30s 陈旧时触发一次隐藏 /usage 轮
      // （有轮在跑则 main 侧标记 pending 轮末补跑）。
      const sessionId = useSessionStore.getState().meta?.sessionId
      const cu = useSessionStore.getState().contextUsage
      if (sessionId && (!cu || !cu.at || Date.now() - cu.at > 30_000)) {
        void window.api.refreshSessionUsage(sessionId).catch(() => {})
      }
    }
  }, [open, refresh])

  // 钉住状态下点击组件外任意处关闭（无 backdrop，不阻断对话）。
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

  const rollingPct = windowPct(plan?.rolling)
  const weeklyPct = windowPct(plan?.weekly)
  const membership = membershipLabel(plan?.membershipLevel)
  // 上下文用量：隐藏 /usage 轮推送（system/context_usage），无数据置灰。
  const contextUsage = useSessionStore((s) => s.contextUsage)
  const contextPct = contextUsage ? Math.min(100, Math.round(contextUsage.pct)) : null
  // 两位小数：用解析出的 used/total 自算（环 tooltip 与预览卡同步）。
  const contextPct2 =
    contextUsage && contextUsage.total > 0
      ? ((contextUsage.used / contextUsage.total) * 100).toFixed(2)
      : null

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
        aria-expanded={open}
      >
        <Ring pct={rollingPct} label="5h" danger={rollingPct !== null && rollingPct >= 80} />
        <Ring pct={weeklyPct} label="周" danger={weeklyPct !== null && weeklyPct >= 80} />
        <Ring
          pct={contextPct}
          label="上下文"
          danger={contextPct !== null && contextPct >= 80}
          title={contextPct2 !== null ? `上下文 ${contextPct2}%` : undefined}
        />
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
            {/* 数据加载中：骨架条（opacity 脉动） */}
            {!error && !plan && (
              <div className="animate-pulse space-y-2.5">
                <div className="h-2.5 w-full rounded bg-white/[0.06]" />
                <div className="h-2.5 w-2/3 rounded bg-white/[0.06]" />
                <div className="h-2.5 w-full rounded bg-white/[0.06]" />
              </div>
            )}
            {/* 会话用量（隐藏 /usage 轮 Total 行：input/output/cache read） */}
            {contextUsage?.inputTokens !== undefined && (
              <div>
                <div className="mb-1 text-xs text-zinc-400">会话用量</div>
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
              </div>
            )}
            {/* 上下文窗口（隐藏 /usage 轮数据，ACP 不下发 usage_update 的替代） */}
            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-zinc-400">上下文窗口</span>
                <span className="text-zinc-500">{contextPct2 !== null ? `${contextPct2}%` : '—'}</span>
              </div>
              <UsageBar pct={contextPct} />
              <div className="mt-1 text-[11px] text-zinc-600">
                {contextUsage ? `${contextUsage.usedText} / ${contextUsage.total.toLocaleString()}` : '暂无数据（下个 turn 结束后更新）'}
              </div>
            </div>
            {plan?.rolling && <LimitRow title={`${plan.rolling.label}滚动窗口`} window={plan.rolling} />}
            {plan?.weekly && <LimitRow title="每周额度" window={plan.weekly} />}
            {plan?.parallelLimit !== undefined && (
              <div className="text-xs text-zinc-500">并行任务上限：{plan.parallelLimit}</div>
            )}
            {!error && plan && !plan.rolling && !plan.weekly && (
              <p className="text-xs text-zinc-600">云端未返回额度数据。</p>
            )}
          </div>
          <div className="mt-3 border-t border-white/[0.06] pt-2 text-center text-[10px] text-zinc-600">
            悬停预览 · 点击钉住
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
