import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUiStore } from '../store/uiStore'
import { useSessionStore } from '../store/sessionStore'
import { fmtK } from '../utils/format'
import type { DeepseekBalanceInfo, PlanUsageInfo, UsageLimitWindow } from '../../shared/ipc'

/**
 * 状态栏用量：三个小圆环 —— 5h 滚动窗口 / 每周 / 上下文，悬停浮出预览卡，点击钉住。
 *
 * 数据来源分两条，都不碰浏览器 Cookie：
 * - 5h / 每周：`forge:getPlanUsage` → `GET api.kimi.com/coding/v1/usages`，
 *   Bearer 是 Kimi Code CLI 自己的 OAuth access_token（主进程带缓存）。
 * - 上下文：ACP 隐藏 `/usage` 轮推送的 contextUsage（纯本地）。
 *
 * v1.0.46 曾把 5h/周一起删掉，理由是"移除 Kimi 网页接口"——但那一版真正该删的
 * 是复用浏览器 Cookie 打 MembershipService RPC 的 quotaService/kimiWebChat，
 * 这条走的是官方 API + CLI 自己的凭证，被误伤了。v1.0.49 只把这条加回来，
 * Cookie 那条继续保持删除。
 */

/** 预览卡通过 portal 挂到 body 并 fixed 定位：状态栏那条是 overflow:hidden 的
 *  矮容器，absolute 定位的卡会被整条裁掉（表现为"悬停没反应"）。 */
const CARD_GAP_PX = 8

/** 额度数据的新鲜度阈值：超过这个岁数才在展开时补拉一次。 */
const PLAN_STALE_MS = 60_000

function resetLabel(resetAt?: number): string | null {
  if (!resetAt) return null
  const ms = resetAt - Date.now()
  if (ms <= 0) return '即将重置'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
  return `${hours}h ${minutes}m 后重置`
}

/** used/limit → 0–1 比例；任一缺失或 limit 为 0 时返回 undefined（显示"—"）。 */
function windowRatio(w?: UsageLimitWindow): number | undefined {
  if (!w || w.used === undefined || !w.limit) return undefined
  return Math.min(1, w.used / w.limit)
}

function pct2(ratio: number | undefined): string | null {
  return ratio === undefined ? null : `${(ratio * 100).toFixed(2)}%`
}

/** 接口原始枚举（LEVEL_ADVANCED）→ 展示文案（Advanced）；未识别的值原样透出。 */
function formatMembershipLevel(raw: string): string {
  const stripped = raw.replace(/^LEVEL_/i, '')
  if (!/^[A-Z][A-Z0-9_]*$/.test(stripped)) return stripped
  return stripped.charAt(0) + stripped.slice(1).toLowerCase()
}

/** 单个小圆环：pct 为 null 时置灰显示"—"（无数据）。 */
function Ring({
  pct,
  label,
  title
}: {
  pct: number | null
  label: string
  title?: string
}): JSX.Element {
  const danger = pct !== null && pct >= 80
  const r = 6.5
  const c = 2 * Math.PI * r
  const frac = (pct ?? 0) / 100
  return (
    <span className="flex items-center gap-1" title={title}>
      <svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0" aria-hidden>
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

/** 预览卡里的一行额度：标题 + 两位小数百分比 + 重置时间 + 用量明细。 */
function QuotaRow({
  title,
  window: w
}: {
  title: string
  window?: UsageLimitWindow
}): JSX.Element {
  const ratio = windowRatio(w)
  const pctText = pct2(ratio)
  const reset = resetLabel(w?.resetAt)
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-zinc-400">{title}</span>
        <span className="whitespace-nowrap text-zinc-500">
          {pctText ?? '—'}
          {reset ? <span className="text-zinc-600">{` · ${reset}`}</span> : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
        <div
          className={`h-full rounded-full ${ratio !== undefined && ratio >= 0.8 ? 'bg-red-500' : 'bg-accent'}`}
          style={{ width: `${(ratio ?? 0) * 100}%` }}
        />
      </div>
      {w?.used !== undefined && w.limit !== undefined && (
        <div className="mt-1 text-[11px] text-zinc-600">
          {fmtK(w.used)} / {fmtK(w.limit)}
          {w.remaining !== undefined ? `　剩余 ${fmtK(w.remaining)}` : ''}
        </div>
      )}
    </div>
  )
}

export default function UsageRings(): JSX.Element {
  const pinned = useUiStore((s) => s.usageOpen)
  const setPinned = useUiStore((s) => s.setUsageOpen)
  const contextUsage = useSessionStore((s) => s.contextUsage)
  const [hover, setHover] = useState(false)
  const [plan, setPlan] = useState<PlanUsageInfo | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [deepseek, setDeepseek] = useState<DeepseekBalanceInfo | null>(null)
  const planFetchedAtRef = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const open = hover || pinned

  const refreshPlan = useCallback((): void => {
    planFetchedAtRef.current = Date.now()
    void window.api
      .getPlanUsage()
      .then((result) => {
        if (result.ok) {
          setPlan(result.data)
          setPlanError(null)
        } else {
          setPlanError(result.error)
        }
      })
      .catch((error: unknown) => {
        setPlanError(error instanceof Error ? error.message : String(error))
      })
    // DeepSeek 余额：任何失败（含未配置 key）都安静地不显示这一行。
    void window.api
      .getDeepseekBalance()
      .then((result) => setDeepseek(result.ok ? result.data : null))
      .catch(() => setDeepseek(null))
  }, [])

  // 挂载即拉一次：环上要有数字，不能等到用户悬停才开始转。
  useEffect(() => {
    refreshPlan()
  }, [refreshPlan])

  useEffect(() => {
    if (!open) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      setAnchor({
        right: Math.max(8, window.innerWidth - rect.right),
        bottom: window.innerHeight - rect.top + CARD_GAP_PX
      })
    }
    if (Date.now() - planFetchedAtRef.current > PLAN_STALE_MS) refreshPlan()
    const sessionId = useSessionStore.getState().meta?.sessionId
    const usage = useSessionStore.getState().contextUsage
    if (sessionId && (!usage?.at || Date.now() - usage.at > 30_000)) {
      void window.api.refreshSessionUsage(sessionId).catch(() => {})
    }
  }, [open, refreshPlan])

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

  const rollingRatio = windowRatio(plan?.rolling)
  const weeklyRatio = windowRatio(plan?.weekly)
  const contextPct =
    contextUsage && contextUsage.total > 0
      ? Math.min(100, (contextUsage.used / contextUsage.total) * 100)
      : null
  const rollingLabel = plan?.rolling?.label ?? '5h'

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
        className="flex items-center gap-2.5 rounded px-1.5 py-0.5 transition hover:bg-white/[0.06]"
        aria-expanded={open}
        title="用量（点击钉住）"
      >
        <Ring
          pct={rollingRatio !== undefined ? rollingRatio * 100 : null}
          label={rollingLabel}
          title={`${rollingLabel} 额度 ${pct2(rollingRatio) ?? '—'}`}
        />
        <Ring
          pct={weeklyRatio !== undefined ? weeklyRatio * 100 : null}
          label="周"
          title={`每周额度 ${pct2(weeklyRatio) ?? '—'}`}
        />
        <Ring
          pct={contextPct}
          label="上下文"
          title={`上下文 ${contextPct === null ? '—' : `${contextPct.toFixed(2)}%`}`}
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
            <span className="flex-1 text-xs font-semibold text-zinc-100">用量</span>
            {plan?.membershipLevel && (
              <span className="text-[10px] text-zinc-600" title="Kimi 会员等级">
                {formatMembershipLevel(plan.membershipLevel)}
              </span>
            )}
          </div>

          <div className="space-y-3">
            <QuotaRow title={`${rollingLabel} 额度`} {...(plan?.rolling ? { window: plan.rolling } : {})} />
            <QuotaRow title="每周额度" {...(plan?.weekly ? { window: plan.weekly } : {})} />

            {deepseek && (
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="text-zinc-400">DeepSeek 余额</span>
                <span className="whitespace-nowrap text-zinc-500">
                  {deepseek.currency === 'USD' ? '$' : '¥'}
                  {deepseek.totalBalance}
                  <span className="text-zinc-600">{` · 充值 ${deepseek.toppedUpBalance} / 赠金 ${deepseek.grantedBalance}`}</span>
                </span>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-zinc-400">上下文窗口</span>
                <span className="text-zinc-500">
                  {contextPct === null ? '—' : `${contextPct.toFixed(2)}%`}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
                <div
                  className={`h-full rounded-full ${contextPct !== null && contextPct >= 80 ? 'bg-red-500' : 'bg-accent'}`}
                  style={{ width: `${contextPct ?? 0}%` }}
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

          {planError && (
            <div className="mt-3 rounded-lg border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-300/90">
              额度读取失败：{planError}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
