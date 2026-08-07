import { memo, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PlanEntry } from '../types'
import Collapse from './Collapse'

/** 超过这个时长没更新就显示陈旧提示。注意"陈旧"指的是**待办内容本身**没推进
 *  （kimi 的设计：待办只在模型调 todo_list 时才变，后台任务完成只在下一轮注入），
 *  不是 Tran 没去拉——真值补拉见下面的 refreshTodos。 */
const PLAN_STALE_AFTER_MS = 90_000

/** 待办真值补拉间隔。打的是本机 kimi server 的 REST，零 token；间隔取 10s 是
 *  因为待办本来就只在模型跑 turn 时才会变，再密没有意义。 */
const TODO_POLL_MS = 10_000
/** turn 结束后延这么久再补拉一次：给服务端落盘留出时间，否则拉到的还是旧的。 */
const AFTER_TURN_DELAY_MS = 1200
/** 自动催更前的静置窗口。后台任务刚收尾时用户很可能正要自己发消息——先让一步，
 *  这几秒内他发了话，会话就不空闲了，催更自然不会触发。 */
const NUDGE_DELAY_MS = 4000
/** 一个会话最多催几次。催更是"有则更好"，连着发就是刷屏——用户看到的是
 *  Tran 自己在跟 AI 聊天。宁可少催一次。 */
const NUDGE_MAX_PER_SESSION = 2

/** 已催过的任务：sessionId → 那些"收尾时催过一次"的任务 id + 已催次数。
 *
 *  放在模块级而不是 useRef：组件重挂载（切会话切回来、热更新）会把 ref 清成
 *  null，于是同一批任务被重新催一遍。放模块级才是"每个任务只催一次"。
 *
 *  记 Set 而不是"上一次的 key"：原先存的是排序后拼起来的 key，只要任务集合
 *  发生任何变化——多一个子 Agent 收尾、服务端把过期任务清掉、轮询拿到一份不
 *  完整的列表——key 就跟上次不等，于是再催一轮。这正是"怎么一直在发"。 */
const nudgeState = new Map<string, { ids: Set<string>; count: number }>()

function staleLabel(sinceMs: number): string {
  const min = Math.floor(sinceMs / 60000)
  if (min < 60) return `${min} 分钟前更新`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前更新`
  return `${Math.floor(hour / 24)} 天前更新`
}

const ListGlyph = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
)

/** 待办清单卡片：ACP plan 事件驱动，整体样式对齐 ToolCallCard 玻璃风。
 *  completed 打勾、in_progress 紫色高亮（优先显示 activeForm）。 */
const PlanCard = memo(function PlanCard(): JSX.Element | null {
  const entries = useSessionStore((s) => s.planEntries)
  const planUpdatedAt = useSessionStore((s) => s.planUpdatedAt)
  const running = useSessionStore((s) => s.status.running)
  const swarmTasks = useSessionStore((s) => s.swarmTasks)
  // 默认收起：待办是"想看时才看"的东西，展开着就长期占住正文顶部——一屏
  // 五六条，把真正在读的对话往下挤。标题行本身已经带了"已完成 2/5"。
  const [collapsed, setCollapsed] = useState(true)
  // 陈旧文案要随时间走，但待办本身不会再变——用一个低频 tick 驱动重算。
  const [, setTick] = useState(0)
  // 自动催更：最近一次催更时刻（界面标注用）。防重复的账记在模块级
  // nudgeState 里——组件重挂载不能把它清掉。
  const [nudgedAt, setNudgedAt] = useState<number | null>(null)
  // 开关读设置（默认开）。主进程侧还会再校验一次——这一轮会真的花额度，
  // 不能只靠渲染层自觉。
  const [autoNudge, setAutoNudge] = useState(false)
  useEffect(() => {
    void window.api
      .getPreferences()
      .then((p) => setAutoNudge(p?.autoTodoNudge === true))
      .catch(() => setAutoNudge(false))
  }, [])

  const hasUnfinished = entries.some((e) => e.status !== 'completed')
  useEffect(() => {
    if (!hasUnfinished || running) return
    const timer = window.setInterval(() => setTick((v) => v + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [hasUnfinished, running])

  // --- 待办真值补拉 ---
  // 这些 effect **必须声明在下面那句 `entries.length === 0` 早返回之前**：
  // 待办为空正是最需要补拉的时候（切走再切回、重启之后面板就是空的），
  // 放在早返回之后就永远不会执行——那样这个功能等于没做。
  const refreshTodos = useSessionStore((s) => s.refreshTodos)
  // 两个 id 不能混用：REST 拉待办认的是 ACP 会话 id（sdkSessionId），而隐藏轮
  // 走 bridge，认的是桥接 id（sessionId）。传错的话 bridge 找不到后端，静默返回
  // false——功能看着"没报错"却永远不生效。
  const sdkSessionId = useSessionStore((s) => s.meta?.sdkSessionId)
  const bridgeSessionId = useSessionStore((s) => s.meta?.sessionId)

  // turn 刚结束：模型这一轮很可能动过待办，这是最值得补一次的时刻。
  useEffect(() => {
    if (running || !sdkSessionId) return
    const timer = window.setTimeout(() => void refreshTodos(), AFTER_TURN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [running, sdkSessionId, refreshTodos])

  // 会话开着就低频补拉：覆盖后台会话、以及 plan 帧丢失的情况。
  useEffect(() => {
    if (!sdkSessionId) return
    const timer = window.setInterval(() => void refreshTodos(), TODO_POLL_MS)
    return () => window.clearInterval(timer)
  }, [sdkSessionId, refreshTodos])

  // --- 后台任务收尾后自动催更 ---
  // 补拉只能拿到服务端**已有**的待办；而后台任务刚结束时，服务端那份本来就还是
  // 旧的——模型还没收到完成通知（kimi 的通知只在下一轮注入），也就没调过
  // todo_list。所以要让待办真的往前走，必须有一次 turn。这里就是那一次。
  //
  // 门槛必须严，因为这一轮**是真的花额度、而且模型可能顺手接着干活**：
  //   后台任务刚收尾 + 有未完成待办 + 会话空闲 + 同一批任务只催一次 + 用户可关。
  // 并且催完要在卡片上标出来（下面的 nudgedAt），不能是幽灵行为。
  const settledTaskKey = (swarmTasks ?? [])
    .filter((t) => {
      const s = (t.status ?? '').toLowerCase()
      return s === 'completed' || s === 'failed' || s === 'stopped'
    })
    .map((t) => t.id)
    .sort()
    .join(',')

  useEffect(() => {
    if (!autoNudge || !bridgeSessionId || running || !hasUnfinished || !settledTaskKey) return
    const state = nudgeState.get(bridgeSessionId) ?? { ids: new Set<string>(), count: 0 }
    nudgeState.set(bridgeSessionId, state)
    if (state.count >= NUDGE_MAX_PER_SESSION) return
    // 只为「这次新收尾、以前没催过」的任务催一轮；老任务再怎么进出列表都不算。
    const fresh = settledTaskKey.split(',').filter((id) => !state.ids.has(id))
    if (fresh.length === 0) return
    fresh.forEach((id) => state.ids.add(id))
    state.count += 1
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api
        .nudgeTodos(bridgeSessionId)
        .then((sent) => {
          if (cancelled || !sent) return
          setNudgedAt(Date.now())
          // 催更那一轮的 plan 帧会自己推过来；再补拉一次兜底（模型改了待办但
          // plan 帧没推的情况）。
          window.setTimeout(() => void refreshTodos(), AFTER_TURN_DELAY_MS)
        })
        .catch(() => {
          /* 催更失败静默：下次后台任务收尾还有机会 */
        })
    }, NUDGE_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [autoNudge, bridgeSessionId, running, hasUnfinished, settledTaskKey, refreshTodos])

  if (entries.length === 0) return null

  const done = entries.filter((e) => e.status === 'completed').length
  const allDone = done === entries.length

  // 后台任务已收尾但待办还停在未完成 + 会话空闲。
  // 2026-08 修正认知：kimi 会把完成通知 steer 进会话并**自动开新一轮**
  // （wire 实证全历史 91 例零例外），所以正常情况下 AI 自己就会接续更新——
  // 横幅只是告诉用户"已收尾、AI 接续中"；若长时间不动（steer 丢失/接续轮
  // 没动待办），提示用户发条消息即可，不再声称"必须等你发消息"。
  //
  // 2026-08 误报修复：swarmTasks 里躺着全部历史任务，「存在一个已收尾任务」
  // 几乎永远为真，横幅变成常驻。加 30 分钟新鲜度窗口——只有**刚刚**收尾的
  // 任务才提示；老任务早就被后续 turn 通知过了，再挂横幅只是噪声。
  const SETTLED_NOTICE_WINDOW_MS = 30 * 60 * 1000
  const settledBackgroundTask =
    !running &&
    hasUnfinished &&
    (swarmTasks ?? []).some((t) => {
      const status = (t.status ?? '').toLowerCase()
      if (status !== 'completed' && status !== 'failed' && status !== 'stopped') return false
      const completedMs = t.completedAt ? Date.parse(t.completedAt) : NaN
      // 没有收尾时间的记录不参与判断（无法证明它"刚"收尾）。
      return Number.isFinite(completedMs) && Date.now() - completedMs <= SETTLED_NOTICE_WINDOW_MS
    })

  const staleSince = planUpdatedAt === null ? 0 : Date.now() - planUpdatedAt
  const showStale = !running && hasUnfinished && planUpdatedAt !== null && staleSince >= PLAN_STALE_AFTER_MS

  const rowOf = (entry: PlanEntry, index: number): JSX.Element => {
    const active = entry.status === 'in_progress'
    const completed = entry.status === 'completed'
    return (
      // key 带状态：完成瞬间重挂载，打勾弹入 + 划线动画只播一次。
      <div key={`${index}-${entry.status}`} className="flex items-start gap-2 py-1">
        <span
          className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
            completed
              ? 'tran-check-pop border-green-500/60 bg-green-500/20 text-green-400'
              : active
                ? 'border-accent/70 bg-accent/25 text-accent'
                : 'border-white/20 text-transparent'
          }`}
        >
          {/* 与待办浮层（taskRows.PlanRow）同一枚 SVG 勾：文本字形在小圆圈里基线对不齐。 */}
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span
          className={`min-w-0 flex-1 break-words text-xs leading-relaxed ${
            completed
              ? 'text-zinc-500'
              : active
                ? 'text-accent'
                : 'text-zinc-300'
          }`}
        >
          <span className={completed ? 'plan-strike' : undefined}>
            {active && entry.activeForm ? entry.activeForm : entry.content}
          </span>
        </span>
      </div>
    )
  }

  return (
    // pb + 底部发丝线：和正文之间要有明确分隔（2026-08 用户反馈"待办和正文之间没有分隔"）。
    <div className="mx-auto w-full max-w-5xl border-b border-white/[0.05] px-6 pb-2.5 pt-3">
      {/* #44 与工具 bar 同宽（宽度统一由 .tran-ai-col 给，见 styles.css）。
          tran-ai-col：简约风把正文列居中，待办条要跟着走，否则它左对齐、
          底下的回复居中，两条边界对不上。 */}
      <div className="tool-call-card tran-ai-col overflow-hidden rounded-lg border border-accent/30 bg-[#101116]">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center gap-2 bg-[#14151b] px-3 py-2 text-left transition-colors hover:bg-[#1b1c23]"
        >
          <span className={`shrink-0 ${allDone ? 'text-green-400' : 'text-accent'}`}>
            <ListGlyph />
          </span>
          <span className="shrink-0 text-xs font-medium text-zinc-200">待办 {entries.length} 项</span>
          <span className="text-[11px] text-zinc-500">
            {allDone ? '已完成' : `已完成 ${done}/${entries.length}`}
          </span>
          {showStale && (
            <span className="shrink-0 text-[11px] text-zinc-600" title="待办由 AI 主动推送，会话空闲时不会自行刷新">
              · {staleLabel(staleSince)}
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-zinc-600">{collapsed ? '▸' : '▾'}</span>
        </button>
        {/* 催更已经发出去了：这一轮是 Tran 自己发的，必须让用户看见——否则就是
            幽灵行为（对话里凭空多出一轮，用户不知道是谁触发的）。 */}
        {nudgedAt !== null && (
          <div className="flex items-start gap-2 border-t border-accent/25 bg-accent/[0.07] px-3 py-2 text-[11px] leading-relaxed text-accent/90">
            <span aria-hidden className="mt-px shrink-0">↻</span>
            <span>
              后台任务结束后，Tran 自动请求了一次待办更新。
              <span className="text-accent/60">（设置 → 系统 可关闭）</span>
            </span>
          </div>
        )}
        {/* 还没催（或催更已关）时才提示"要等你发消息"——催过之后这句话就不成立了。 */}
        {settledBackgroundTask && nudgedAt === null && (
          <div className="flex items-start gap-2 border-t border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
            <span aria-hidden className="mt-px shrink-0">⏱</span>
            <span>
              {autoNudge
                ? '后台任务已结束，Tran 正在替你请求一次待办更新…'
                : '后台任务已结束，AI 会自动接续处理并更新待办；若长时间没有动静，发一条消息即可。'}
            </span>
          </div>
        )}
        <Collapse open={!collapsed}>
          <div className="border-t border-border-subtle bg-[#0f1015] px-3 py-1.5">
            {entries.map(rowOf)}
          </div>
        </Collapse>
      </div>
    </div>
  )
})

export default PlanCard
