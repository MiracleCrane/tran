import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  QuotaAction,
  QuotaActionItem,
  QuotaOverview
} from '../../shared/ipc'

/** 额度明细面板（对齐 Kimi 网页版"我的额度/使用明细"）：从状态栏圆环悬停卡
 *  打开，模态弹层。只保留使用明细列表 + 加油包卡片——额度进度条（月度/5h/7天）
 *  已上移到 UsageRings 悬停卡。数据走 forge:getQuotaOverview /
 *  forge:listQuotaActions（MembershipService RPC，ratio ×100 保留两位小数）；
 *  登录态缺失时给"登录 Kimi"兜底按钮（forge:quotaLogin 网页登录）。 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function absTime(ms?: number): string | null {
  if (!ms) return null
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  const body = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-${body}` : body
}

const FEATURE_LABELS: Record<string, string> = {
  FEATURE_OMNI: 'Kimi',
  FEATURE_CODING: 'Kimi Code',
  FEATURE_CHAT: 'Kimi 对话',
  FEATURE_DEEP_RESEARCH: '深度研究',
  FEATURE_SWARM: 'Agent Swarm',
  FEATURE_AGENT: 'Agent',
  FEATURE_SLIDES: 'PPT',
  FEATURE_DOCUMENTS: '文档',
  FEATURE_SHEETS: '表格',
  FEATURE_WEBSITES: '网站',
  FEATURE_CLAW: 'Kimi Claw',
  FEATURE_DREAM: 'Dream'
}

function actionTitle(action: QuotaAction): string {
  if (action.title) return action.title
  if (action.feature) return FEATURE_LABELS[action.feature] ?? action.feature.replace(/^FEATURE_/, '')
  return '额度消耗'
}

const UNIT_LABELS: Record<string, string> = {
  UNIT_COUNT: '次',
  UNIT_CREDIT: '额度',
  UNIT_CURRENCY: '元'
}

function itemAmountLabel(item: QuotaActionItem): string {
  if (item.amountRatio !== undefined) return `${(item.amountRatio * 100).toFixed(2)}%`
  if (item.amount !== undefined) return `${item.amount} ${UNIT_LABELS[item.unit ?? ''] ?? item.unit ?? ''}`.trim()
  if (item.amountMoneyCny !== undefined) return `¥${item.amountMoneyCny.toFixed(2)}`
  return '—'
}

interface OverviewState {
  data: QuotaOverview | null
  error: string | null
  needsLogin: boolean
}

export default function QuotaPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [overview, setOverview] = useState<OverviewState>({ data: null, error: null, needsLogin: false })
  const [actions, setActions] = useState<QuotaAction[]>([])
  const [nextPageToken, setNextPageToken] = useState<string | null>(null)
  const [actionsError, setActionsError] = useState<string | null>(null)
  const [actionsNeedsLogin, setActionsNeedsLogin] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)

  const loadOverview = useCallback((): void => {
    setOverview({ data: null, error: null, needsLogin: false })
    void window.api
      .getQuotaOverview()
      .then((result) => {
        if (result.ok) setOverview({ data: result.data, error: null, needsLogin: false })
        else setOverview({ data: null, error: result.error, needsLogin: result.needsLogin === true })
      })
      .catch(() => setOverview({ data: null, error: '网络错误，无法连接 Kimi 云端接口', needsLogin: false }))
  }, [])

  const loadActions = useCallback((pageToken?: string): void => {
    setLoadingMore(true)
    if (!pageToken) {
      setActions([])
      setNextPageToken(null)
      setActionsError(null)
      setActionsNeedsLogin(false)
    }
    void window.api
      .listQuotaActions(pageToken)
      .then((result) => {
        if (result.ok) {
          setActions((prev) => (pageToken ? [...prev, ...result.actions] : result.actions))
          setNextPageToken(result.nextPageToken ?? null)
          setActionsError(null)
          setActionsNeedsLogin(false)
        } else {
          setActionsError(result.error)
          setActionsNeedsLogin(result.needsLogin === true)
        }
      })
      .catch(() => {
        setActionsError('网络错误，无法连接 Kimi 云端接口')
        setActionsNeedsLogin(false)
      })
      .finally(() => setLoadingMore(false))
  }, [])

  const reload = useCallback((): void => {
    loadOverview()
    loadActions()
  }, [loadOverview, loadActions])

  useEffect(() => {
    if (open) reload()
  }, [open, reload])

  const login = useCallback((): void => {
    setLoggingIn(true)
    void window.api
      .quotaLogin()
      .then((result) => {
        if (result.ok) reload()
      })
      .finally(() => setLoggingIn(false))
  }, [reload])

  if (!open) return null

  const data = overview.data
  const wallet = data?.boosterWallet
  const needsLogin = overview.needsLogin || actionsNeedsLogin

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="glass-panel tran-enter flex max-h-[78vh] w-[26rem] flex-col rounded-2xl p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <span className="flex-1 text-xs font-semibold text-zinc-100">额度明细</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
          >
            关闭
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {needsLogin && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
              <span className="flex-1">{overview.error ?? actionsError ?? '需要登录'}</span>
              <button
                type="button"
                disabled={loggingIn}
                onClick={login}
                className="shrink-0 rounded bg-accent/20 px-2 py-1 text-[11px] font-medium text-accent transition hover:bg-accent/30 disabled:opacity-50"
              >
                {loggingIn ? '登录中…' : '登录 Kimi'}
              </button>
            </div>
          )}
          {!needsLogin && overview.error && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
              <span className="flex-1">{overview.error}</span>
              <button
                type="button"
                onClick={reload}
                className="shrink-0 rounded bg-white/[0.06] px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.1]"
              >
                重试
              </button>
            </div>
          )}

          {!overview.error && !data && (
            <div className="animate-pulse space-y-2.5">
              <div className="h-2.5 w-full rounded bg-white/[0.06]" />
              <div className="h-2.5 w-2/3 rounded bg-white/[0.06]" />
              <div className="h-2.5 w-full rounded bg-white/[0.06]" />
            </div>
          )}

          {data && (
            <>
              {/* 额度加油包 */}
              {wallet && (
                <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-zinc-400">额度加油包</span>
                    <span className={wallet.enabled ? 'text-emerald-400' : 'text-zinc-500'}>
                      {wallet.enabled ? '已开启' : '已关闭'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-center">
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 px-1.5 py-1.5">
                      <div className="text-xs font-semibold text-zinc-100">
                        {wallet.balanceCny !== undefined ? `¥${wallet.balanceCny.toFixed(2)}` : '—'}
                      </div>
                      <div className="mt-0.5 text-[9px] text-zinc-500">
                        余额{wallet.totalCny !== undefined ? ` / 共 ¥${wallet.totalCny.toFixed(2)}` : ''}
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 px-1.5 py-1.5">
                      <div className="text-xs font-semibold text-zinc-100">
                        {wallet.monthlyUsedCny !== undefined ? `¥${wallet.monthlyUsedCny.toFixed(2)}` : '—'}
                      </div>
                      <div className="mt-0.5 text-[9px] text-zinc-500">
                        本月消费{wallet.monthlyLimitCny !== undefined ? ` / 上限 ¥${wallet.monthlyLimitCny.toFixed(2)}` : ''}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* 使用明细（分页加载） */}
          <div>
            <div className="mb-1.5 text-xs text-zinc-400">使用明细</div>
            {actions.length > 0 && (
              <div className="divide-y divide-white/[0.04] rounded-lg border border-white/[0.06] bg-black/20">
                {actions.map((action) => (
                  <div key={action.id} className="flex items-baseline gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-xs text-zinc-200">
                        <span className={`truncate ${action.status === 'UNDO' ? 'text-zinc-500 line-through' : ''}`}>
                          {actionTitle(action)}
                        </span>
                        {action.status === 'ONGOING' && (
                          <span className="shrink-0 rounded bg-accent/15 px-1 py-px text-[9px] text-accent">进行中</span>
                        )}
                        {action.status === 'UNDO' && (
                          <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px text-[9px] text-zinc-500">已撤销</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-600">{absTime(action.timestamp) ?? '—'}</div>
                    </div>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {action.items.length > 0 ? action.items.map(itemAmountLabel).join(' + ') : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {actionsError && !actionsNeedsLogin && (
              <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200/90">
                <span className="flex-1">{actionsError}</span>
                <button
                  type="button"
                  onClick={() => loadActions(nextPageToken ?? undefined)}
                  className="shrink-0 rounded bg-white/[0.06] px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.1]"
                >
                  重试
                </button>
              </div>
            )}
            {!actionsError && !loadingMore && actions.length === 0 && !needsLogin && (
              <div className="px-1 py-2 text-[11px] text-zinc-600">暂无消耗记录。</div>
            )}
            {nextPageToken && !actionsError && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => loadActions(nextPageToken)}
                className="mt-2 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-1.5 text-[11px] text-zinc-400 transition hover:bg-white/[0.06] disabled:opacity-50"
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
