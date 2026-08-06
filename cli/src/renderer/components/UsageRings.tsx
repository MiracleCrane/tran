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

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 重置信息拆两段：倒计时（左）+ 具体到期时刻（右），同一行两端错开——
 *  塞在一段里太长会撞车（2026-08 用户反馈）。 */
function resetParts(resetAt?: number): { countdown: string; moment: string } | null {
  if (!resetAt) return null
  const ms = resetAt - Date.now()
  if (ms <= 0) return { countdown: '即将重置', moment: '' }
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const countdown =
    hours >= 24
      ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
      : `${hours} 小时 ${minutes} 分钟后重置`
  const at = new Date(resetAt)
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  const now = new Date()
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  const moment = sameDay
    ? `今天 ${time}`
    : `${at.getMonth() + 1}月${at.getDate()}日 周${WEEKDAY_NAMES[at.getDay()]} ${time}`
  return { countdown, moment }
}

/** API 给的窗口标签可能是英文缩写（"5h"），卡里统一成中文（紧凑无空格，
 *  和「每周额度」对齐——"5 小时 额度"中间那道缝用户看着不对）。 */
function zhWindowLabel(label: string): string {
  return label.replace(/^(\d+)\s*h$/i, '$1小时')
}

/** used/limit → 0–1 比例；任一缺失或 limit 为 0 时返回 undefined（显示"—"）。 */
function windowRatio(w?: UsageLimitWindow): number | undefined {
  if (!w || w.used === undefined || !w.limit) return undefined
  return Math.min(1, w.used / w.limit)
}

function pct2(ratio: number | undefined): string | null {
  // 取整显示：两位小数在这个尺寸下既看不清也没意义（2026-08 用户要求）。
  return ratio === undefined ? null : `${Math.round(ratio * 100)}%`
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

/** 预览卡里的一行额度：标题 + 整数百分比 + 重置时间 + 用量明细。 */
function QuotaRow({
  title,
  window: w
}: {
  title: string
  window?: UsageLimitWindow
}): JSX.Element {
  const ratio = windowRatio(w)
  const pctText = pct2(ratio)
  const reset = resetParts(w?.resetAt)
  return (
    <div>
      {/* 布局纪律（2026-08 两次迭代）：标题和百分比**永不换行**；明细行只放
          重置信息——用量数字（24/100 剩余 76）按用户要求移除，进度条和百分比
          已经表达了。倒计时靠左、具体时刻靠右，两端错开不撞车。 */}
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="shrink-0 whitespace-nowrap text-zinc-400">{title}</span>
        <span className="shrink-0 whitespace-nowrap text-zinc-500">{pctText ?? '—'}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
        <div
          className={`h-full rounded-full ${ratio !== undefined && ratio >= 0.8 ? 'bg-red-500' : 'bg-accent'}`}
          style={{ width: `${(ratio ?? 0) * 100}%` }}
        />
      </div>
      {reset && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-zinc-600">
          <span className="min-w-0 truncate">{reset.countdown}</span>
          {reset.moment && <span className="shrink-0 whitespace-nowrap">{reset.moment}</span>}
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
  /** 摘要 API 是否指向 DeepSeek —— 只有它有公开的余额接口。 */
  const [summaryIsDeepseek, setSummaryIsDeepseek] = useState(true)
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
        } else if (!result.disabled) {
          // disabled = 功能关着（opt-in 门），正常态不弹错误框，额度环显示 —。
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

  // 余额行只对 DeepSeek 有意义（别家没有公开的余额接口）。
  // 判断依据必须是**当前激活的那套摘要配置**，不是旧的 summaryApiBaseUrl 字段——
  // 多套配置上线后旧字段只是迁移遗留，跟实际生效的可能不一致。
  useEffect(() => {
    void window.api
      .listSummaryProfiles()
      .then(({ profiles, activeId }) => {
        const active = profiles.find((p) => p.id === activeId) ?? profiles[0]
        setSummaryIsDeepseek(/(?:^|\.)deepseek\.com/i.test(active?.baseUrl ?? ''))
      })
      .catch(() => setSummaryIsDeepseek(true))
  }, [])

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
          title={`上下文 ${contextPct === null ? '—' : `${Math.round(contextPct)}%`}`}
        />
      </button>

      {open && anchor && createPortal(
        // 宽度自适应：原先写死 w-80(320px)。窗口窄到 320px 上下时整张卡会顶出
        // 视口——而它是 fixed + 右下角锚定，顶出去的那半边完全够不着。
        // min() 保证够宽时仍是 20rem，窄时收到「视口宽 − 2rem」。
        <div
          ref={cardRef}
          className="glass-panel tran-enter fixed z-[90] w-[min(20rem,calc(100vw-2rem))] rounded-2xl p-4 shadow-2xl"
          style={{ right: anchor.right, bottom: anchor.bottom }}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="flex-1 text-xs font-semibold text-zinc-100">用量</span>
          </div>

          <div className="space-y-3">
            <QuotaRow title={`${zhWindowLabel(rollingLabel)}额度`} {...(plan?.rolling ? { window: plan.rolling } : {})} />
            <QuotaRow title="每周额度" {...(plan?.weekly ? { window: plan.weekly } : {})} />

            {/* 这一行最容易堆字：右侧「$余额 · 充值 X / 赠金 Y」很长且整段不可断。
                拆成两段——总额跟标题同排并保持 nowrap（数字断行没法看），
                充值/赠金明细占满一行、自己换到第二行去。 */}
            {/* 非 DeepSeek 的摘要 API 不显示余额，但要说明原因——直接留白会让人
                以为坏了（用户明确要求"说明一下"）。 */}
            {!summaryIsDeepseek && (
              <div className="text-[11px] leading-relaxed text-zinc-600">
                当前摘要 API 不是 DeepSeek，无余额可查（该服务未提供公开的余额接口）。
              </div>
            )}
            {summaryIsDeepseek && deepseek && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
                <span className="shrink-0 whitespace-nowrap text-zinc-400">DeepSeek 余额</span>
                <span className="shrink-0 whitespace-nowrap text-zinc-500">
                  {deepseek.currency === 'USD' ? '$' : '¥'}
                  {deepseek.totalBalance}
                </span>
                <span className="w-full text-right text-[11px] text-zinc-600">
                  {`充值 ${deepseek.toppedUpBalance} / 赠金 ${deepseek.grantedBalance}`}
                </span>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="shrink-0 whitespace-nowrap text-zinc-400">上下文窗口</span>
                <span className="shrink-0 whitespace-nowrap text-zinc-500">
                  {contextPct === null ? '—' : `${Math.round(contextPct)}%`}
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
                  <div
                    key={label}
                    // min-w-0：grid 子项默认 min-width:auto，内容撑得下就不收缩，
                    // 三列会一起把卡片顶宽/顶破。加了它数字才肯 truncate。
                    className="min-w-0 rounded-lg border border-white/[0.06] bg-black/20 px-1.5 py-1.5"
                  >
                    <div className="truncate text-xs font-semibold text-zinc-100">
                      {value !== undefined ? fmtK(value) : '—'}
                    </div>
                    <div className="mt-0.5 truncate text-[9px] text-zinc-500">{label}</div>
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
