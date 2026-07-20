import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { PlanUsageInfo, SessionUsageInfo, UsageLimitWindow } from '../../shared/ipc'

/** 复刻 Kimi TUI /usage 面板的 Tran 原生模态窗（紫色玻璃风）。
 *  数据：云端套餐额度（getPlanUsage）+ 会话用量（getSessionUsage，ACP 侧）。
 *  打开即拉取，先显示骨架加载态。 */

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

function UsageBar({ used, limit }: { used: number; limit: number }): JSX.Element {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  const danger = pct >= 80
  return (
    <div className="h-2 overflow-hidden rounded-full bg-black/30">
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct}%`,
          background: danger
            ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
            : 'linear-gradient(90deg, #8b5cf6, #a78bfa)'
        }}
      />
    </div>
  )
}

function LimitSection({ title, window }: { title: string; window: UsageLimitWindow }): JSX.Element {
  const used = window.used ?? 0
  const limit = window.limit ?? 0
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  const reset = resetLabel(window.resetAt)
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-zinc-400">{title}</span>
        <span className="text-zinc-500">
          {pct}% used{reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <UsageBar used={used} limit={limit} />
      <div className="mt-1 text-[11px] text-zinc-600">
        {fmtK(used)} / {fmtK(limit)}
        {window.remaining !== undefined ? ` · 剩余 ${fmtK(window.remaining)}` : ''}
      </div>
    </div>
  )
}

function Skeleton(): JSX.Element {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-4 w-1/3 rounded bg-white/[0.06]" />
      <div className="h-2 rounded bg-white/[0.06]" />
      <div className="h-2 w-2/3 rounded bg-white/[0.06]" />
      <div className="h-4 w-1/4 rounded bg-white/[0.06]" />
      <div className="h-2 rounded bg-white/[0.06]" />
    </div>
  )
}

export default function UsageModal(): JSX.Element | null {
  const open = useUiStore((s) => s.usageOpen)
  const setOpen = useUiStore((s) => s.setUsageOpen)
  const meta = useSessionStore((s) => s.meta)
  const [loading, setLoading] = useState(true)
  const [sessionUsage, setSessionUsage] = useState<SessionUsageInfo | null>(null)
  const [plan, setPlan] = useState<PlanUsageInfo | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setPlan(null)
    setPlanError(null)
    const sessionId = meta?.sessionId
    void Promise.all([
      sessionId
        ? window.api.getSessionUsage(sessionId).catch(() => null)
        : Promise.resolve(null),
      window.api.getPlanUsage().catch(() => ({ ok: false as const, error: '网络错误，无法连接 Kimi 云端接口' }))
    ]).then(([usage, planResult]) => {
      if (!alive) return
      setSessionUsage(usage)
      if (planResult.ok) setPlan(planResult.data)
      else setPlanError(planResult.error)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, meta?.sessionId])

  if (!open) return null

  const hasTokenUsage =
    sessionUsage != null &&
    (sessionUsage.inputTokens !== undefined ||
      sessionUsage.outputTokens !== undefined ||
      sessionUsage.totalTokens !== undefined)
  const hasContext = sessionUsage?.contextUsed !== undefined
  const membership = membershipLabel(plan?.membershipLevel)
  const wallet = plan?.boosterWallet

  return (
    <div
      className="tran-modal-backdrop fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-6 backdrop-blur-md"
      onClick={() => setOpen(false)}
    >
      <div
        className="tran-modal-panel glass-panel max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-[22px] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="flex-1 text-base font-semibold text-zinc-100">用量</h2>
          {membership && (
            <span className="rounded bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              {membership}
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
          >
            关闭
          </button>
        </div>

        {loading ? (
          <Skeleton />
        ) : (
          <div className="space-y-5">
            {/* Session usage */}
            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Session usage{sessionUsage?.model ? ` · ${sessionUsage.model}` : ''}
              </h3>
              {hasTokenUsage ? (
                <div className="grid grid-cols-3 gap-2 text-center">
                  {([
                    ['输入', sessionUsage?.inputTokens],
                    ['输出', sessionUsage?.outputTokens],
                    ['总计', sessionUsage?.totalTokens]
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/[0.06] bg-black/20 px-2 py-2.5">
                      <div className="text-sm font-semibold text-zinc-100">
                        {value !== undefined ? fmtK(value) : '—'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-500">{label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs text-zinc-500">
                  kimi ACP 暂未上报本会话 token 用量（0.26.0 实测不下发 usage 事件）。
                </p>
              )}
            </section>

            {/* Context window */}
            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Context window
              </h3>
              {hasContext && sessionUsage ? (
                <div>
                  <UsageBar used={sessionUsage.contextUsed!} limit={sessionUsage.contextSize} />
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {Math.round((sessionUsage.contextUsed! / sessionUsage.contextSize) * 100)}% · (
                    {fmtK(sessionUsage.contextUsed!)} / {fmtK(sessionUsage.contextSize)})
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs text-zinc-500">
                  暂无数据（上限 {sessionUsage ? fmtK(sessionUsage.contextSize) : '1M'}，已用值待 kimi 上报）。
                </p>
              )}
            </section>

            {/* Plan usage */}
            <section className="space-y-3">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Plan usage
              </h3>
              {planError && (
                <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
                  {planError}
                </div>
              )}
              {plan?.weekly && <LimitSection title="每周额度" window={plan.weekly} />}
              {plan?.rolling && <LimitSection title={`${plan.rolling.label}滚动窗口`} window={plan.rolling} />}
              {plan?.parallelLimit !== undefined && (
                <div className="text-xs text-zinc-500">并行任务上限：{plan.parallelLimit}</div>
              )}
              {!planError && !plan?.weekly && !plan?.rolling && (
                <p className="text-xs text-zinc-600">云端未返回额度数据。</p>
              )}
            </section>

            {/* 加油包 */}
            {wallet && (wallet.monthlyUsedCny !== undefined || wallet.monthlyLimitCny !== undefined) && (
              <section>
                <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  加油包
                </h3>
                <div className="text-xs text-zinc-400">
                  本月已用 ¥{(wallet.monthlyUsedCny ?? 0).toFixed(2)}
                  {wallet.monthlyLimitCny !== undefined ? ` / 上限 ¥${wallet.monthlyLimitCny.toFixed(2)}` : ''}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
