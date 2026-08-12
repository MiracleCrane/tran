import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import { probeCommit } from '../utils/streamProbe'
import type { AssistantBlock, AssistantItem, UserAttachment, UserItem, TranscriptItem, ItemNode, ToolBlock } from '../types'
import MessageText, { InlineMarkdown } from './MessageText'
import { ToolGlyph, FoldChevron } from './toolIcons'
import { showImageContextMenu } from './ImageContextMenu'
import { formatTimeFull, formatTimeShort, messageTime } from '../utils/messageTimes'
import { initSentImageRecording, loadSentImages, matchHistoryImages } from '../utils/sentImages'
import SkillCard, { matchSkillInvocation } from './SkillCard'
import ToolCallCard from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import CompactionDivider from './CompactionDivider'
import EmptyState from './EmptyState'
import QueryResultCard from './QueryResultCard'
import TurnChangesCard from './TurnChangesCard'
import { emitForgeEvent } from '../events'
import UserMessageNav, { type UserNavEntry } from './UserMessageNav'
import { useCheapNote } from '../hooks/useCheapNote'
import { useThinkingTranslateStatus } from '../hooks/useThinkingTranslateStatus'

const INITIAL_HIGHLIGHT_DELAY_MS = 420
const SCROLL_HIGHLIGHT_RESUME_MS = 180
const SCROLL_INTENT_IDLE_MS = 220
const FOLLOW_OUTPUT_LOCK_MS = 1200
const TOPBAR_RESERVE_NEAR_BOTTOM_THRESHOLD_PX = 120
// #8b 滚动意图：距底部多少 px 内算"回到底部附近"，恢复跟随输出。
const FOLLOW_RESUME_AT_BOTTOM_THRESHOLD_PX = 40
// 鼠标在 bar（思考块/工具卡）上"停留"的判定窗口：最近这么多 ms 内有过真实
// 指针移动，悬停才算主动停留（内容滚动从静止指针下方滑过不算）。
const BAR_HOVER_INTENT_WINDOW_MS = 600
// 参与悬停/聚焦意图判定的 bar 元素。
const TRANSCRIPT_BAR_SELECTOR = '.thinking-block, .tool-call-card'
// #48 用户消息导航条：摘要截取长度与条目上限（超出只留最近若干条）。
const USER_NAV_SUMMARY_CHARS = 24
// 短于这个长度的思考块不送去总结：折叠态本来就把前 60 字显示全了，再花一次
// 调用换不来任何信息。
//
// 阈值从 120 降到 70：120 太高，一屏里常出现「有的有摘要、有的没有」，看起来
// 像是坏了而不像是有意为之。70 之后绝大多数思考块都有摘要；剩下真正的短块
// （"Done. Report briefly." 这种）原文就是它自己的摘要，不需要再概括一遍。
const THINKING_SUMMARY_MIN_CHARS = 70
// 模块级常量，保证 useCheapNote 的依赖项稳定（每次渲染新建函数会反复触发 effect）。
const fetchThinkingNote = (text: string): Promise<string | null> => window.api.summarizeThinking(text)
const fetchThinkingTranslation = (text: string): Promise<string | null> =>
  window.api.translateThinking(text)

/**
 * 这段思考是不是以英文为主 —— 是才值得翻译。
 *
 * 判据用「CJK 字符占比」而不是「有没有英文」：技术类思考里夹英文术语是常态，
 * 那种不该整段翻。CJK 少于 15% 才认为是英文段落。
 */
function looksEnglish(text: string): boolean {
  const sample = text.slice(0, 400)
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length
  return cjk / Math.max(1, sample.length) < 0.15
}
const USER_NAV_MAX_ENTRIES = 30
/** Virtuoso firstItemIndex 的起始基数：头部每插入 N 条就减 N，够减很久。 */
const FIRST_ITEM_INDEX_BASE = 1_000_000
/** 思考框内距底多少像素以内算"还贴着底"（继续跟随流式输出）。 */
const THINKING_FOLLOW_BOTTOM_THRESHOLD_PX = 24
// #48/#50 高亮判定：用户消息行顶距视口顶多少 px 内算"视口顶部附近"。
const USER_NAV_TOP_SLACK_PX = 8
// #50 长距跳转（行数差超过该值）用 auto 一次到位——动态高度列表里 smooth
// 长跳会边滚边补渲染重测高，卡在半途并持续闪；短距保留 smooth 过渡感。
const USER_NAV_SMOOTH_MAX_ROWS = 40
/** #45 无历史附件时的共享空 Map（避免每次渲染新引用击穿 UserMessage memo）。 */
const EMPTY_HISTORY_ATTACHMENTS: ReadonlyMap<string, UserAttachment[]> = new Map()

/**
 * 底部状态区（只剩"正在压缩上下文…"提示和 bottomReserve 占位）。
 *
 * 必须是模块级组件：此前它是写在 Virtuoso `components={{ Footer: () => ... }}`
 * 里的内联箭头函数，每次 Transcript 重渲染都会产生一个新的组件类型，React
 * 据此卸载旧节点、挂载新节点——CSS 动画随之从头播放。流式输出期间
 * Transcript 每帧都重渲染，于是转圈不停被打断（用户可见为"转到一半跳回起点"）。
 *
 * compacting 自己从 store 订阅，bottomReserve 走 Virtuoso 的 context，
 * 两者都是 props/state 变化而非类型变化，不会触发 remount。
 *
 * 注：这里原来还有一行"Tran 正在处理…"运行指示，已删——它与输入框上方的
 * "AI 正在输出中"（带计时+排队数）和消息内的"输出中…"三处同屏重复，留信息
 * 最全的两处即可。
 */
const TranscriptFooter = memo(function TranscriptFooter({
  context
}: {
  context?: { bottomReserve: number }
}): JSX.Element {
  const compacting = useSessionStore((s) => s.status.compacting)
  const bottomReserve = context?.bottomReserve ?? 0
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-2">
      {compacting && <div className="text-center text-xs text-zinc-500">正在压缩上下文…</div>}
      {bottomReserve > 0 && <div aria-hidden="true" style={{ height: bottomReserve }} />}
    </div>
  )
})

/** 稳定引用：components 对象每次新建同样会让 Virtuoso 重建内部结构。 */
const VIRTUOSO_COMPONENTS = { Footer: TranscriptFooter }

interface TranscriptProps {
  layoutTransitioning?: boolean
  bottomReserve?: number
  bottomReserveVersion?: number
  onAtBottomChange?: (atBottom: boolean) => void
}


/** Group the flat `items` into a forest. Top level = items with no
 *  parentToolUseId; an assistant item's tool_use block (id X) owns every item
 *  whose parentToolUseId === X (the forwarded subagent conversation). Recursive
 *  — a subagent's own tool calls can nest further. Order preserved, O(n). */
function buildForest(items: TranscriptItem[]): ItemNode[] {
  const nodes = new Map<string, ItemNode>()
  const toolOwner = new Map<string, ItemNode>()
  for (const item of items) {
    if (!item) continue // defensive: skip any malformed/undefined entries
    const node: ItemNode = { item, childrenByTool: new Map() }
    nodes.set(item.id, node)
    if (item.kind === 'assistant') {
      for (const b of item.blocks) {
        // `b` can be undefined when streamed content_block indices created holes
        // in the blocks array (interleaved subagent stream events) — skip those.
        if (b && b.kind === 'tool') toolOwner.set(b.toolUseId, node)
      }
    }
  }
  const roots: ItemNode[] = []
  for (const item of items) {
    if (!item) continue
    const node = nodes.get(item.id)
    if (!node) continue
    const pt = item.parentToolUseId
    if (pt && toolOwner.has(pt)) {
      const parent = toolOwner.get(pt)!
      const arr = parent.childrenByTool.get(pt) ?? []
      arr.push(node)
      parent.childrenByTool.set(pt, arr)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/** 顶层渲染行：普通消息节点，或"连续相邻的纯工具调用消息"聚成的分组块，
 *  或"连续相邻的系统信封"聚成的折叠组（纯渲染层聚合，不改后端事件；
 *  单个工具调用/单个信封仍按普通消息渲染）。 */
type DisplayRow =
  | { kind: 'item'; node: ItemNode }
  | { kind: 'toolGroup'; id: string; blocks: ToolBlock[] }
  /** B 方案：跨消息的「思考 + 工具」活动组（含思考时才用，纯工具仍走 toolGroup）。 */
  | { kind: 'activityGroup'; id: string; blocks: AssistantBlock[] }
  | { kind: 'envelopeGroup'; id: string; entries: Array<{ id: string; text: string }> }

/** 该节点是否"整条消息只有工具调用块"（可聚合）。 */
function toolBlocksOf(node: ItemNode): ToolBlock[] | null {
  const item = node.item
  if (item.kind !== 'assistant' || item.error || item.blocks.length === 0) return null
  if (!item.blocks.every((b): b is ToolBlock => !!b && b.kind === 'tool')) return null
  return item.blocks as ToolBlock[]
}

/**
 * B 方案：该节点是否"整条消息只有活动块（思考 / 工具），没有正文"。
 *
 * 为什么必须跨消息聚合：AssistantMessage 内部的折叠只在**一条消息内**生效，而
 * KimiBackend 重放历史时每个 tool_call 都 push 一条**独立的** assistant 消息、
 * 思考封在另一条——于是每条都只有 1 个块，谁也够不着"≥2 才折"的门槛。结果就是
 * 点开老会话，思考和工具全是散开的。原有的 toolGroup 只认纯工具消息，中间夹一条
 * 思考消息就断开，同样盖不住。
 *
 * 流式中的消息一律不参与聚合：正在跑的活动必须实时可见。
 */
function activityBlocksOf(node: ItemNode): AssistantBlock[] | null {
  const item = node.item
  if (item.kind !== 'assistant' || item.error || item.streaming) return null
  const blocks = item.blocks.filter((b): b is AssistantBlock => !!b)
  if (blocks.length === 0) return null
  if (!blocks.every((b) => b.kind === 'tool' || b.kind === 'thinking')) return null
  return blocks
}

/** 该节点是否**要显示**的系统信封（后台任务通知/cron）。 */
function envelopeTextOf(node: ItemNode): string | null {
  const item = node.item
  if (item.kind !== 'user' || !item.text) return null
  return VISIBLE_ENVELOPE_RE.test(item.text.trimStart()) ? item.text : null
}

/** 该节点是否要整条丢弃的噪音信封（system-reminder / 技能注入）。 */
function isHiddenEnvelope(node: ItemNode): boolean {
  const item = node.item
  return item.kind === 'user' && !!item.text && HIDDEN_ENVELOPE_RE.test(item.text.trimStart())
}

/** 行的稳定 key（与 Virtuoso 的 computeItemKey 同一套，务必保持一致）。 */
function rowKeyOf(row: DisplayRow): string {
  return row.kind === 'item' ? row.node.item.id : row.id
}

function buildDisplayRows(roots: ItemNode[], shouldFold: (groupKey: string) => boolean): DisplayRow[] {
  const rows: DisplayRow[] = []
  let toolRun: { node: ItemNode; blocks: AssistantBlock[] }[] = []
  let envelopeRun: ItemNode[] = []
  const flushTools = (): void => {
    const all = toolRun.flatMap((r) => r.blocks)
    // 聚合门槛按**块数**而不是消息数：重放历史里一条消息常常只有 1 个块，
    // 按消息数算永远够不着 2。
    // 2026-08 滚动稳定：折叠与否交给 shouldFold 判定（组件侧按"组创建时用户
    // 是否在底部" sticky 记忆）——用户上翻阅读时新收尾的活动**不折叠**，
    // 已折叠的组也不因上翻而展开，布局在阅读位置脚下绝不变。
    if (all.length >= 2) {
      const pureTools = all.every((b): b is ToolBlock => b.kind === 'tool')
      if (pureTools) {
        const key = `tool-group-${all[0].toolUseId}`
        if (shouldFold(key)) {
          // 纯工具组维持原有的 ToolGroupCard（带运行/错误态），不回归现有设计。
          rows.push({ kind: 'toolGroup', id: key, blocks: all })
        } else {
          for (const r of toolRun) rows.push({ kind: 'item', node: r.node })
        }
      } else {
        const key = `activity-group-${toolRun[0].node.item.id}`
        if (shouldFold(key)) {
          // 含思考的混合组：走一行规则摘要，点开还原完整渲染。
          rows.push({ kind: 'activityGroup', id: key, blocks: all })
        } else {
          for (const r of toolRun) rows.push({ kind: 'item', node: r.node })
        }
      }
    } else {
      for (const r of toolRun) rows.push({ kind: 'item', node: r.node })
    }
    toolRun = []
  }
  const flushEnvelopes = (): void => {
    // 连续 ≥2 个信封才折叠；单个维持单张卡。组 id 取首条 id——live 期间新到
    // 的信封进尾部已有组时组 id 不变，展开状态和位置都不闪。
    if (envelopeRun.length >= 2) {
      const key = `envelope-group-${envelopeRun[0].item.id}`
      if (shouldFold(key)) {
        rows.push({
          kind: 'envelopeGroup',
          id: key,
          entries: envelopeRun.map((n) => ({ id: n.item.id, text: envelopeTextOf(n) ?? '' }))
        })
      } else {
        for (const n of envelopeRun) rows.push({ kind: 'item', node: n })
      }
    } else {
      for (const n of envelopeRun) rows.push({ kind: 'item', node: n })
    }
    envelopeRun = []
  }
  for (const node of roots) {
    // 噪音信封：整条丢弃，且**不打断**前后的聚合 run——它在视觉上根本不存在，
    // 不该让一条看不见的消息把两组工具调用劈成两块。
    if (isHiddenEnvelope(node)) continue
    // B 方案：思考消息也进 run（原先只有 toolBlocksOf，中间夹一条思考就断开）。
    const blocks = activityBlocksOf(node)
    if (blocks) {
      flushEnvelopes()
      toolRun.push({ node, blocks })
      continue
    }
    if (envelopeTextOf(node) !== null) {
      flushTools()
      envelopeRun.push(node)
      continue
    }
    // 正常消息：两类 run 都在此断开，不跨消息合并。
    flushTools()
    flushEnvelopes()
    rows.push({ kind: 'item', node })
  }
  flushTools()
  flushEnvelopes()
  return rows
}

/** Memoized on `item`. With stream-batched updates only the streaming item
 *  gets a new reference each frame, so finished user messages never re-render
 *  when the transcript re-renders during a sibling's stream. The `backdrop-blur`
 *  that used to be here was removed — it stacked a backdrop-filter surface per
 *  message (cost grew with message count) for a barely-visible effect over the
 *  already-frosted shell. */
/**
 * kimi CLI 往会话历史里注入的系统信封，按"该不该看"分成两类。
 *
 * 实测本机 110 个会话的全部历史：真人消息 237 条，注入的信封 304 条——比真人
 * 说的话还多。其中 system-reminder（196 条，待办提醒之类）和技能注入（6 条，
 * 整篇技能 markdown）对读历史的人毫无价值；即便收成灰卡片，也是每 1 条真话夹
 * 1.25 张卡。点进一个老会话该看到的是当时的对话本身，不是一屏机器自言自语。
 * 这两类直接不渲染。
 *
 * 后台任务结果（notification）与 cron 触发（cron-fire）：2026-08 用户定夺——
 * 也不显示（"系统消息有什么意义"）。完成状态有后台命令 chip 和待办横幅表达，
 * 对话流里只留人说的话。SystemEnvelope/EnvelopeGroupRow 随之不再被触达，
 * 组件保留（将来若要恢复展示，从 HIDDEN_ENVELOPE_RE 里摘掉即可）。
 *
 * 技能注入有两种形态，锚在 `^<` 的正则只盖得住第一种：
 *   `<kimi-skill-loaded name=...>`                          —— 标签开头
 *   `Skill tool loaded instructions for this request...`     —— 前面还有一句白话
 * 第二种此前整条漏网，被当成**用户说的话**把整篇技能文档渲染出来（实测 6 条）。
 */
const HIDDEN_ENVELOPE_RE =
  /^(?:<(?:system-reminder|kimi-skill-loaded|notification|cron-fire)[\s>]|User activated the skill\b|Skill tool loaded instructions\b)/

/** 值得保留的信封：后台任务通知与 cron 触发，渲染成系统卡片。 */
const VISIBLE_ENVELOPE_RE = /^<(notification|cron-fire)[\s>]/

/** 是不是信封（两类都算）——"别把它当成用户发言"的判断用（如自动滚动）。 */
function isEnvelopeText(text: string): boolean {
  const head = text.trimStart()
  return HIDDEN_ENVELOPE_RE.test(head) || VISIBLE_ENVELOPE_RE.test(head)
}

type EnvelopeStatus = 'completed' | 'failed' | 'lost'

/** 信封状态只认结构化字段：kimi CLI 的通知信封是
 *  `<notification … type="task.completed|task.failed|task.killed|task.lost" …>`
 *  （实测自 kimi.exe 内嵌模板），正文另有 `status: "completed"` 一类字段。
 *  此前对信封全文裸搜 /(completed|failed|lost)/，标题或正文里随便出现一个
 *  "failed" 单词（比如路径、任务描述）就会把整条信封误标成失败。 */
function envelopeStatusOf(text: string): EnvelopeStatus | null {
  const match =
    /\btype="task\.(completed|failed|killed|lost)"/.exec(text)?.[1] ??
    /\bstatus\s*[:=]\s*"?(completed|failed|killed|lost)\b/.exec(text)?.[1]
  if (!match) return null
  // killed 与 failed 同样按「未正常完成」呈现。
  return match === 'killed' ? 'failed' : (match as EnvelopeStatus)
}

function SystemEnvelope({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // 标题优先级：XML title 属性 → 通知正文的 "Title: xxx" 行（后台任务通知
  // 的标题在这里，拿不到就只显示「系统消息」这种没信息量的词——2026-08 用户
  // 反馈"这卡片有什么意义"）→ cron 标记 → 兜底。
  const title =
    /title="([^"]*)"/.exec(text)?.[1] ??
    /^Title:\s*(.+)$/m.exec(text)?.[1]
  const kind = envelopeStatusOf(text)
  const label = title ?? (text.startsWith('<cron-fire') ? '定时任务触发' : '系统消息')
  return (
    <div className="flex justify-center">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="max-w-[85%] rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-left transition hover:bg-white/[0.04]"
        title={expanded ? '收起' : '展开原文'}
      >
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span aria-hidden>⚙</span>
          <span className="truncate">{label}</span>
          {kind && (
            <span className={kind === 'completed' ? 'text-emerald-400/80' : 'text-red-300/80'}>
              {kind === 'completed' ? '完成' : kind === 'failed' ? '失败' : '丢失'}
            </span>
          )}
        </div>
        {expanded && (
          <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-zinc-600">
            {text}
          </pre>
        )}
      </button>
    </div>
  )
}

/** 连续系统信封的折叠汇总行：比单张卡更克制（text-[11px] text-zinc-600），
 *  展开后内部列表 max-h 滚动，子项复用 SystemEnvelope。 */
function EnvelopeGroupRow({ entries }: { entries: Array<{ id: string; text: string }> }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  let completed = 0
  let failed = 0
  for (const entry of entries) {
    // 与 SystemEnvelope 同一套结构化状态判定，不做全文裸搜。
    const kind = envelopeStatusOf(entry.text)
    if (kind === 'completed') completed++
    else if (kind === 'failed' || kind === 'lost') failed++
  }
  return (
    <div className="flex justify-center">
      <div className="max-w-[85%]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] text-zinc-600 transition hover:bg-white/[0.04] hover:text-zinc-500"
          title={expanded ? '收起' : '展开'}
        >
          <span aria-hidden>⚙</span>
          <span>系统消息 ×{entries.length}</span>
          {completed > 0 && <span className="text-emerald-400/70">{completed} 完成</span>}
          {failed > 0 && <span className="text-red-300/70">{failed} 失败</span>}
          <span className="text-[9px]">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="mt-1 max-h-64 space-y-1 overflow-y-auto">
            {entries.map((entry) => (
              <SystemEnvelope key={entry.id} text={entry.text} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const UserMessage = memo(function UserMessage({
  item,
  hydratedAttachments
}: {
  item: UserItem
  /** #45 历史重放补回的图片附件（发送时渲染层落盘，按文本匹配）。 */
  hydratedAttachments?: UserAttachment[]
}): JSX.Element {
  const atts = item.attachments ?? hydratedAttachments ?? []
  const at = messageTime(item.id)
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const slashSkills = useSessionStore((s) => s.slashCommands)
  const openAttachmentPreview = useUiStore((s) => s.openAttachmentPreview)
  // kimi CLI 系统信封（后台任务通知等）：渲染成系统卡片而不是原始 XML 气泡。
  // 噪音信封正常情况下已被 buildDisplayRows 滤掉，这里是兜底——万一有别的
  // 入口直接渲染 UserMessage，也绝不能把系统提醒/整篇技能文档当成用户发言。
  if (item.text && isHiddenEnvelope({ item } as ItemNode)) return <></>
  if (item.text && VISIBLE_ENVELOPE_RE.test(item.text.trimStart())) {
    return <SystemEnvelope text={item.text} />
  }
  // 斜杠命令（skill）调用：Codex 风格专属卡片替代普通气泡（纯文本消息才走；
  // 带附件的保持原气泡，附件展示不进卡片）。
  const skillInvocation = atts.length === 0 ? matchSkillInvocation(item.text, slashSkills) : null
  if (skillInvocation) {
    return (
      <div className="tran-user-msg group/msg relative flex justify-end">
        <SkillCard invocation={skillInvocation} {...(item.cutIn ? { cutIn: true } : {})} />
        {at !== undefined && (
          <div className="tran-msg-time tran-msg-time-gutter-left" title={formatTimeFull(at)}>
            {formatTimeShort(at)}
          </div>
        )}
      </div>
    )
  }
  const handleAttachmentClick = (
    event: MouseEvent<HTMLButtonElement>,
    attachment: NonNullable<UserItem['attachments']>[number]
  ): void => {
    if (event.ctrlKey && attachment.path) {
      void window.api.revealInExplorer(cwd, attachment.path)
      return
    }
    openAttachmentPreview(attachment)
  }
  return (
    // tran-user-msg / tran-user-bubble 是给外观主题用的稳定钩子：简约风把这里
    // 从「右对齐气泡」改成「左对齐 + 左侧强调竖线」，Tailwind 的转义类名不好选中。
    <div className="tran-user-msg group/msg relative flex justify-end">
      <div className="tran-user-bubble max-w-[85%] rounded-[16px] rounded-tr-md border border-white/10 bg-gradient-to-br from-accent/[0.14] via-white/[0.06] to-white/[0.03] px-4 py-2.5 shadow-lg shadow-black/10">
        {(item.swarm || item.cutIn) && (
          <div className="mb-1 flex justify-end gap-1">
            {item.swarm && (
              <span
                className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent"
                title="该条发送时注入了 Swarm 并行指令前缀"
              >
                Swarm
              </span>
            )}
            {item.cutIn && (
              <span
                className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[9px] font-medium text-zinc-300"
                title="Ctrl+S 打断并发送（插队）"
              >
                插队
              </span>
            )}
          </div>
        )}
        {item.text && (
          <div className="whitespace-pre-wrap break-words text-sm text-zinc-200">{item.text}</div>
        )}
        {atts.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {atts.map((a, i) => {
              const canPreviewText = a.kind === 'text' && typeof a.text === 'string'
              const canOpen = canPreviewText || !!a.dataUrl || !!a.path
              return a.kind === 'image' && a.dataUrl ? (
                <button
                  key={i}
                  type="button"
                  onClick={(event) => handleAttachmentClick(event, a)}
                  onContextMenu={(event) => showImageContextMenu(event, a.dataUrl ?? '', a.name)}
                  className="rounded-lg outline-none ring-accent/50 transition hover:brightness-110 focus-visible:ring-2"
                  title={`预览 ${a.name}；右键复制/另存图片`}
                >
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="max-h-44 max-w-[220px] rounded-lg border border-white/10 object-cover"
                  />
                </button>
              ) : (
                <button
                  key={i}
                  type="button"
                  onClick={canOpen ? (event) => handleAttachmentClick(event, a) : undefined}
                  disabled={!canOpen}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-zinc-300 transition enabled:hover:bg-white/[0.06] disabled:cursor-default disabled:opacity-80"
                  title={canOpen ? `预览 ${a.name}；Ctrl+点击在资源管理器中显示` : a.name}
                >
                  <span className="text-zinc-500">{a.kind === 'text' ? '📄' : '📎'}</span>
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {/* #43 时间戳：默认隐藏、悬停该条消息才浮出 HH:mm:ss，title 给完整年月日时分秒；
          绝对定位落在气泡左侧的留白里（见 styles.css 的 .tran-msg-time 注释）。
          挂在外层 flex 容器上而不是气泡里——气泡是靠右的，留白在它外面。 */}
      {at !== undefined && (
        <div className="tran-msg-time tran-msg-time-gutter-left" title={formatTimeFull(at)}>
          {formatTimeShort(at)}
        </div>
      )}
    </div>
  )
})

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false,
  forceExpanded = false
}: {
  text: string
  streaming?: boolean
  /** "最新块"保持展开（渲染期派生，见 Transcript 的 lastExpandableKey）。 */
  forceExpanded?: boolean
}): JSX.Element {
  // 默认收起（一行摘要"思考过程 · N 字"）；流式期间或作为"最新块"时自动展开，
  // 出现下一个块后收回；用户手动点击后以其选择为准。展开态定高 200px 内部滚动。
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? (forceExpanded || streaming)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 是否还跟随底部。用户在框内往上滚就置 false，滚回底部自动恢复。 */
  const followBodyRef = useRef(true)

  /**
   * 流式期间内容跟随底部——但**只在用户没有主动往上翻时**。
   *
   * 原先是无条件 `scrollTop = scrollHeight`：思考还在写，你想回头看前面几行，
   * 每来一个 chunk 就被硬拽回最底部，等于根本没法读。现在按"贴底才跟随"处理，
   * 和转录区外层那套跟随/解除是同一个约定。
   *
   * 注意这里的 scrollTop 赋值会触发下面的 onScroll，届时算出的距底距离≈0，
   * 跟随状态保持 true，不会自己把自己关掉。
   */
  // rAF 合帧（2026-08 卡顿治理）：原先每个 chunk 同步赋 scrollTop，等于每帧
  // 强制一次全文回流；长思考 + 高频 chunk 时这是主要的掉帧来源之一。改成
  // 一帧内多个 chunk 合并成一次滚动。
  const followFrameRef = useRef<number | null>(null)
  useEffect(() => {
    if (!(open && streaming) || followFrameRef.current !== null) return
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = null
      const body = bodyRef.current
      if (body && followBodyRef.current) body.scrollTop = body.scrollHeight
    })
  }, [text, open, streaming])
  useEffect(
    () => () => {
      if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current)
    },
    []
  )

  // 重新展开（或换到新的一段思考）时恢复跟随：上一次的"我在往回看"不该粘住。
  useEffect(() => {
    if (open) followBodyRef.current = true
  }, [open])

  const handleBodyScroll = (): void => {
    const body = bodyRef.current
    if (!body) return
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight
    followBodyRef.current = distanceFromBottom <= THINKING_FOLLOW_BOTTOM_THRESHOLD_PX
  }

  // 折叠态摘要：优先便宜模型给的一句话概括，拿不到就退回正文前 ~60 字截断。
  // 只在块收尾后才请求（流式期间输入还不完整，而且不该跟主链路抢带宽）；
  // 太短的思考块不值得花一次调用——60 字截断本来就把它显示全了。
  const worthSummarizing = !streaming && text.length >= THINKING_SUMMARY_MIN_CHARS
  const note = useCheapNote(fetchThinkingNote, text, worthSummarizing).value

  // 展开即翻译（2026-08 用户要"边输出边翻译"）：流式期间翻展开那一刻的快照
  // （只打一发，不逐帧烧额度），流式收尾后自动按全文再翻一发（内容 hash 变了
  // 自然触发）。不展开不翻。
  const [showOriginal, setShowOriginal] = useState(false)
  const openSnapshotRef = useRef('')
  useEffect(() => {
    if (open) openSnapshotRef.current = text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const wantsTranslation = open && looksEnglish(text)
  const translateInput = streaming && openSnapshotRef.current ? openSnapshotRef.current : text
  const translationState = useCheapNote(fetchThinkingTranslation, translateInput, wantsTranslation)
  // auto 在没配百度时会回落到付费的摘要 API——回落必须可见，否则就是悄悄花钱。
  const translateStatus = useThinkingTranslateStatus(wantsTranslation)
  const translated = translationState.value

  if (!text) return <></>
  // 预览只在收起态渲染；展开时不算（原先流式期间每帧对**全文**跑一遍 \s+ 正则,
  // 纯浪费）。计算也只吃前 400 字——60 字预览用不到更多。
  const preview = open ? '' : (note ?? text.slice(0, 400).replace(/\s+/g, ' ').trim().slice(0, 60))
  const bodyText = translated && !showOriginal ? translated : text
  return (
    // 完全裸排版（Codex 风）：无框无竖条无底，唯一的动态信号是流式时
    // 标题的紫黄流光（flow-text）。.thinking-block 类名保留给 TRANSCRIPT_BAR_SELECTOR。
    <div className="thinking-block my-[3px] py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserToggled(!open)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 text-left text-xs font-medium text-zinc-500 hover:text-zinc-400"
      >
        <FoldChevron open={open} />
        {/* 火花图标 + 微光（2026-08 用户点名"思考也要有图标和流光"）：
            流式中保留紫黄 flow-text（动态=正在想），完成后落到收敛的灰紫微光。 */}
        <span className={`shrink-0 ${streaming ? 'text-accent/80' : 'text-zinc-500'}`}>
          <ToolGlyph kind="think" size={12} />
        </span>
        <span
          className={`shrink-0 ${
            streaming ? 'flow-text flow-text-violet' : 'seg-shimmer seg-shimmer-think'
          }`}
        >
          思考过程 · {text.length} 字
        </span>
        {!open && (
          <span className="min-w-0 truncate font-normal text-zinc-600">{preview}</span>
        )}
      </button>
      {open && (
        <>
          {/* 只在真的译出来了才给切换；没译出来（限流/失败）就安静地显示原文，
              不留任何"出错了"的痕迹。 */}
          {translated && (
            <span className="mt-1 flex flex-wrap items-baseline gap-x-2 pl-1.5">
              <button
                type="button"
                onClick={() => setShowOriginal((v) => !v)}
                className="text-[10px] text-zinc-600 transition hover:text-zinc-400"
              >
                {showOriginal ? '看译文' : '看原文'}
              </button>
              {/* 回落提示：没配百度 → 走的是按量计费的摘要 API。设置里选了
                  「自动」的人未必知道这一点，不说等于替他做了花钱的决定。 */}
              {translateStatus.autoFellBack && (
                <span
                  className="text-[10px] text-amber-500/70"
                  title="翻译引擎选的是「自动」，但未配置百度密钥，因此走了摘要 / 命名 API（按量计费）。在 设置 → 翻译 里填百度密钥即可免费。"
                >
                  未配百度 · 本次用模型翻译（计费）
                </span>
              )}
            </span>
          )}
          {wantsTranslation && !translated && !translationState.settled && (
            <div className="mt-1 pl-1.5 text-[10px] text-zinc-600">
              <span className="tran-shimmer">翻译中…</span>
            </div>
          )}
          {/* 翻译落地但没译出来（通道没配 key / 接口失败）：别永远转"翻译中"，
              给一句轻提示然后显示原文（2026-08 用户要求）。 */}
          {wantsTranslation && !translated && translationState.settled && (
            <div className="mt-1 pl-1.5 text-[10px] text-zinc-700">
              翻译不可用（未配置或接口失败），已显示原文
            </div>
          )}
          <div
            ref={bodyRef}
            onScroll={handleBodyScroll}
            // overscroll-contain：在思考框内滚到顶/底时不再把滚动"甩"给外层转录区。
            // 没有它的话，你在框里往回翻、一碰到边界就连带整个对话一起滚走。
            className="mt-1.5 max-h-[200px] overflow-auto overscroll-contain whitespace-pre-wrap pl-1.5 text-xs leading-relaxed text-zinc-500"
          >
            {/* 流式期间纯文本（每帧重渲 markdown 不值）；收尾后轻量行内渲染
                ——加粗/行内代码/链接可见，不开段落级排版（2026-08 用户拍板）。 */}
            {streaming ? bodyText : <InlineMarkdown>{bodyText}</InlineMarkdown>}
          </div>
        </>
      )}
    </div>
  )
})

/** 折叠指示（2026-08：文本字形 ▸/▾ 太小太糊，用户反馈）：12px V 形图标，
 *  收起时旋转 -90° 带过渡——比瞬时换字形顺眼。已挪到 toolIcons.tsx 共享。 */

/** Takes `item` (not the wrapping forest node) precisely so React.memo's shallow
 *  compare can short-circuit: the forest node is rebuilt every frame, but the
 *  underlying item keeps its reference when unchanged. */
/** 完成轮活动摘要里工具名 → 中文动作（纯规则统计，不调 API）。 */
/** 「回到最新」按钮：自己订阅 running——主组件刻意不订阅它（turn 起止会
 *  引发全列表重渲染，见 Transcript 顶部注释），按钮独立重渲染代价为零。
 *
 *  形态（2026-08 重做）：干净的圆形按钮 + 居中 V 形箭头（Codex 风）。
 *  输出中不在箭头上玩花样（上次把 flow-text 套 SVG 上渲成了残圈），
 *  而是整圈外面挂一圈缓慢的扩散脉冲环——动态感在按钮外圈，箭头永远干净。 */
const LatestButton = memo(function LatestButton({
  onJump
}: {
  onJump: (behavior: 'auto' | 'smooth') => void
}): JSX.Element {
  const running = useSessionStore((s) => s.status.running)
  return (
    <div className="group/latest absolute bottom-4 left-1/2 -translate-x-1/2" data-follow-no-lock>
      <button
        onClick={() => onJump(running ? 'auto' : 'smooth')}
        title="回到最新"
        aria-label="回到最新"
        className="glass-control relative flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition hover:text-zinc-200"
      >
        {running && <span aria-hidden className="latest-pulse-ring" />}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
})

/** 完成轮活动摘要里工具名 → 中文动作 + 图标 + 微光色调（纯规则统计，不调 API）。
 *  覆盖两套命名：渲染层规范名（Bash/Read…）和 wire 原始名（terminal/read_file…）
 *  ——后者漏配会直接露出「使用了 read_file」这种中英混排（2026-08 用户反馈丑）。
 *  icon 对应 toolIcons.tsx 的键（Codex 原版 SVG）；tone 对应 styles.css 的
 *  seg-shimmer-* 微光类，每种动作一种淡色，扫一眼就能分出谁是谁。 */
const TOOL_ACTIVITY_META: Record<string, { label: string; icon: string; tone: string }> = {
  Bash: { label: '运行命令', icon: 'bash', tone: 'bash' },
  terminal: { label: '运行命令', icon: 'bash', tone: 'bash' },
  Edit: { label: '编辑文件', icon: 'edit', tone: 'edit' },
  patch: { label: '编辑文件', icon: 'edit', tone: 'edit' },
  edit_file: { label: '编辑文件', icon: 'edit', tone: 'edit' },
  Write: { label: '创建文件', icon: 'edit', tone: 'edit' },
  write_file: { label: '创建文件', icon: 'edit', tone: 'edit' },
  Read: { label: '读取文件', icon: 'read', tone: 'read' },
  read_file: { label: '读取文件', icon: 'read', tone: 'read' },
  Glob: { label: '查找文件', icon: 'glob', tone: 'web' },
  Grep: { label: '搜索内容', icon: 'grep', tone: 'web' },
  search: { label: '搜索内容', icon: 'grep', tone: 'web' },
  Agent: { label: '派发子代理', icon: 'agent', tone: 'agent' },
  AgentSwarm: { label: '派发子代理', icon: 'agent', tone: 'agent' },
  Task: { label: '派发子代理', icon: 'agent', tone: 'agent' },
  WebSearch: { label: '搜索网页', icon: 'web', tone: 'web' },
  web_search: { label: '搜索网页', icon: 'web', tone: 'web' },
  FetchURL: { label: '抓取网页', icon: 'web', tone: 'web' },
  WebFetch: { label: '抓取网页', icon: 'web', tone: 'web' },
  TodoList: { label: '更新待办', icon: '', tone: 'todo' },
  todo_list: { label: '更新待办', icon: '', tone: 'todo' },
  Skill: { label: '使用 Skill', icon: 'skill', tone: 'agent' },
  skill: { label: '使用 Skill', icon: 'skill', tone: 'agent' }
}

interface ActivityEntry {
  block: AssistantBlock
  index: number
}

interface ActivitySegment {
  /** thinking = 想了什么（过程），tool = 做了什么（结果）。两者视觉权重不同。 */
  kind: 'thinking' | 'tool'
  label: string
  /** >1 才显示次数。 */
  count: number
  /** toolIcons.tsx 的图标键（空 = 不显示图标）。 */
  icon?: string
  /** seg-shimmer-* 的微光色调（仅 tool 段有）。 */
  tone?: string
}

/**
 * 折叠摘要的分段结构（渲染见 ActivitySummary）。
 *
 * 原先直接返回一整条字符串 "思考 2 段 · 运行命令 ×5 · 编辑文件"：同色、同
 * 字重、挤在一行，扫一眼分不出哪段是思考、哪段是动作、各做了几次——用户反馈的
 * "区分度不够"就是这个。分段后每段带 Codex 原版小图标 + 一种淡色微光，
 * 思考段保持收敛（无图标、暗色）。
 */
function summarizeActivity(blocks: AssistantBlock[]): ActivitySegment[] {
  let thinking = 0
  const tools = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind === 'thinking') thinking += 1
    else if (block.kind === 'tool') tools.set(block.name, (tools.get(block.name) ?? 0) + 1)
  }
  const segments: ActivitySegment[] = []
  // 思考排最前：时间上它也确实发生在动作之前。2026-08：思考段也要图标 +
  // 微光（用户点名），只是色调比动作段更收敛（灰紫）。
  if (thinking > 0) segments.push({ kind: 'thinking', label: '思考', count: thinking, icon: 'think', tone: 'think' })
  for (const [name, count] of tools) {
    const meta = TOOL_ACTIVITY_META[name]
    segments.push({
      kind: 'tool',
      label: meta?.label ?? `使用了 ${name}`,
      count,
      ...(meta?.icon ? { icon: meta.icon } : {}),
      ...(meta?.tone ? { tone: meta.tone } : {})
    })
  }
  return segments
}

/** 折叠摘要的一行渲染：每段「图标 + 淡色微光动作名 + 次数」，段间靠间距
 *  自然分开（2026-08：不要「·」——那玩意儿小到根本看不见还显脏）。 */
function ActivitySummary({ segments }: { segments: ActivitySegment[] }): JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
      {segments.map((seg) => (
        <span key={`${seg.kind}-${seg.label}`} className="inline-flex items-center gap-1">
          {seg.icon && (
            <span className="text-zinc-500">
              <ToolGlyph kind={seg.icon} size={11} />
            </span>
          )}
          <span
            className={
              seg.kind === 'tool'
                ? `seg-shimmer seg-shimmer-${seg.tone ?? 'read'}`
                : 'seg-shimmer seg-shimmer-think'
            }
          >
            {seg.label}
          </span>
          {seg.count > 1 && (
            <span className="text-[10px] tabular-nums text-zinc-600">
              {seg.kind === 'thinking' ? `${seg.count} 段` : `×${seg.count}`}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

/** 完成轮的一段折叠活动（Codex 风）：默认一行规则摘要，点开还原成
 *  ThinkingBlock / ToolCallCard 的完整渲染——数据不动，纯视图折叠。
 *  必须是模块级组件：open 状态随组件实例走，内联定义会被父级重渲染重建。 */
const ActivityGroupRow = memo(function ActivityGroupRow({
  entries,
  renderBlock
}: {
  entries: ActivityEntry[]
  renderBlock: (entry: ActivityEntry) => JSX.Element
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1 text-left text-xs text-zinc-500 transition hover:bg-white/[0.055] hover:text-zinc-400"
      >
        <FoldChevron open={open} />
        <ActivitySummary segments={summarizeActivity(entries.map((e) => e.block))} />
      </button>
      {open && entries.map(renderBlock)}
    </div>
  )
})

/**
 * B 方案的跨消息活动组：连续若干条「只有思考/工具」的消息收成一行规则摘要，
 * 点开还原成 ThinkingBlock / ToolCallCard 的完整渲染（数据不动，纯视图折叠）。
 *
 * 与消息内的 ActivityGroupRow 是两套：那个只能看到单条消息的 blocks，这个跨消息。
 * 组内含"最新块"时默认展开，用户手动点过之后以其选择为准。
 */
const ActivityGroupCard = memo(function ActivityGroupCard({
  blocks,
  forceOpen = false,
  expandedBlockKey = null
}: {
  blocks: AssistantBlock[]
  forceOpen?: boolean
  expandedBlockKey?: string | null
}): JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? forceOpen
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserToggled(!open)}
        className="flex w-fit cursor-pointer select-none items-center gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1 text-left text-xs text-zinc-500 transition hover:bg-white/[0.055] hover:text-zinc-400"
      >
        <FoldChevron open={open} />
        <ActivitySummary segments={summarizeActivity(blocks)} />
      </button>
      {open &&
        blocks.map((block, i) =>
          block.kind === 'thinking' ? (
            <ThinkingBlock key={i} text={block.text} streaming={false} />
          ) : block.kind === 'tool' ? (
            <ToolCallCard key={i} block={block} forceExpanded={expandedBlockKey === block.toolUseId} />
          ) : null
        )}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({
  item,
  depth,
  deferHighlight = false,
  expandedBlockKey = null
}: {
  item: AssistantItem
  depth: number
  deferHighlight?: boolean
  /** "最新块"的 key（toolUseId 或 `${item.id}:thinking`），该块保持展开。 */
  expandedBlockKey?: string | null
}): JSX.Element {
  const isStreaming = !!item.streaming
  const at = messageTime(item.id)

  return (
    <div className={`group/msg relative ${depth === 0 ? 'tran-ai-col' : ''}`}>
      {item.error && (
        <div className="mb-2 rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-1.5 text-xs text-red-300">
          {item.error}
        </div>
      )}
      {/* key 用「过滤前」的原始下标：blocks 在流式期间会出现空洞（子代理事件
          交错，见文件头注释）。若用过滤后的下标做 key，空洞被填上时后续块的
          key 会整体前移，React 认为是不同元素——工具卡片被 remount，展开状态、
          滚动位置丢失或错位。原始下标不随空洞填充而变。

          同理：块的包裹层不能随 isStreaming 变化。这里原先在流式期间套一层
          <Profiler>（#8 埋点），turn 结束时 isStreaming 翻转，包裹层类型从
          Profiler 变成 MessageText/ThinkingBlock——React 按位置比对类型不同即
          卸载重建，代价是每轮结束都：思考块的用户折叠/展开状态被丢弃（最新块
          会自己弹回展开）、正文 markdown 整棵树重建 + highlight.js 重跑（正好
          卡在用户开始读答案的那一刻）。而 Profiler 的 onRender 在生产构建里
          本就不回调（要 react-dom/profiling 才生效），纯负收益，故移除。

          完成轮的活动折叠（Codex 风）：!isStreaming 时，连续 ≥2 个非正文块
          （思考 + 工具调用）收进一行规则摘要（ActivityGroupRow），点开还原完整
          渲染。正文块的 key/组件路径不变，不会被这次折叠波及重建。 */}
      {(() => {
        const entries: ActivityEntry[] = item.blocks
          .map((block, index) => ({ block, index }))
          .filter((entry): entry is ActivityEntry => !!entry.block)

        const renderBlock = ({ block, index: i }: ActivityEntry): JSX.Element => {
          if (block.kind === 'text') {
            const highlight = !isStreaming && !deferHighlight
            return (
              <div key={i}>
                <MessageText highlight={highlight}>{block.text}</MessageText>
                {isStreaming && <span className="tran-stream-cursor" aria-hidden />}
              </div>
            )
          }
          if (block.kind === 'thinking') {
            return (
              <div key={i}>
                <ThinkingBlock
                  text={block.text}
                  streaming={isStreaming}
                  forceExpanded={expandedBlockKey === `${item.id}:thinking`}
                />
              </div>
            )
          }
          return (
            <ToolCallCard
              key={i}
              block={block}
              forceExpanded={expandedBlockKey === block.toolUseId}
            />
          )
        }

        if (isStreaming) return entries.map(renderBlock)

        const rows: JSX.Element[] = []
        let run: ActivityEntry[] = []
        const flush = (): void => {
          // 单个块不值得多包一层：ThinkingBlock 自己就是一行摘要，ToolCallCard
          // 本身已是紧凑卡片。
          if (run.length >= 2) {
            rows.push(<ActivityGroupRow key={run[0].index} entries={run} renderBlock={renderBlock} />)
          } else {
            rows.push(...run.map(renderBlock))
          }
          run = []
        }
        for (const entry of entries) {
          if (entry.block.kind === 'text') {
            flush()
            rows.push(renderBlock(entry))
          } else {
            run.push(entry)
          }
        }
        flush()
        return rows
      })()}
      {/* 流式不再单独挂"输出中…"指示——思考标题的紫黄流光 + 正文滚动本身
          就是信号；全局状态（计时/排队）由输入框上方那条承担。 */}
      {/* #43 时间戳：默认隐藏、悬停该条消息才浮出 HH:mm:ss，title 给完整年月日时分秒；
          绝对定位落在容器右侧的留白里（见 styles.css 的 .tran-msg-time 注释）。
          只在 depth 0 显示：嵌套的子代理消息没有那条 92% 宽度限制，右侧没有
          留白可用，标上去只会压在字上——顶层那条时间已经够定位了。 */}
      {!isStreaming && at !== undefined && depth === 0 && (
        <div className="tran-msg-time tran-msg-time-gutter-right" title={formatTimeFull(at)}>
          {formatTimeShort(at)}
        </div>
      )}
    </div>
  )
})

export default function Transcript({
  layoutTransitioning = false,
  bottomReserve = 0,
  bottomReserveVersion = 0,
  onAtBottomChange
}: TranscriptProps): JSX.Element {
  const items = useSessionStore((s) => s.items)
  const sessionKey = useSessionStore((s) => s.meta?.sessionId ?? '')
  // Virtuoso 头部插入补偿（见下面 displayRows 的注释）。基数取大数，只减不加。
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX_BASE)
  const prevFirstRowKeyRef = useRef<string | null>(null)
  const prevSessionKeyRef = useRef(sessionKey)
  /** #45 附件持久化分桶键：sdkSessionId 重启 resume 后稳定（bridge id 每次都变）。 */
  const attachmentKey = useSessionStore((s) => s.meta?.sdkSessionId ?? s.meta?.sessionId ?? '')
  const agentBackend = useSessionStore((s) => s.meta?.agentBackend)
  const starting = useSessionStore((s) => s.starting)
  // running / compacting 已下沉到 TranscriptFooter 自订阅：主组件不再因它们
  // 变化而重渲染（每个 turn 起止都会触发一次全列表重渲染）。
  const setTranscriptScrolling = useSessionStore((s) => s.setTranscriptScrolling)
  // #36：turn 运行中发送会进 pendingQueue 而不是 items，只看 items 的话
  // 这一路不会回底（而排队恰恰是运行中发送的默认路径）。
  const pendingQueueLength = useSessionStore((s) => s.pendingQueue.length)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const scrollIntentTimeoutRef = useRef<number | null>(null)
  const deferHighlightRef = useRef(true)
  const appliedScrollingRef = useRef(false)
  const virtuosoScrollingRef = useRef(false)
  const scrollIntentActiveRef = useRef(false)
  const followOutputLockedUntilRef = useRef(0)
  const layoutTransitioningRef = useRef(layoutTransitioning)
  const restoreBottomAfterLayoutRef = useRef(false)
  const bottomReserveScrollFrameRef = useRef<number | null>(null)
  const bottomReserveRestoreFrameRef = useRef<number | null>(null)
  const restoreBottomAfterReserveRef = useRef(false)
  const atBottomRef = useRef(true)
  /** 最近一次真实指针移动的时间戳（bar 悬停意图判定用，见 onPointerOverCapture）。 */
  const lastPointerMoveAtRef = useRef(0)
  const reserveEligibleRef = useRef(true)
  /** 已渲染过的消息 id（Virtuoso 滚动复用行时不重播入场动画；新消息才入场）。 */
  const seenItemIdsRef = useRef<Set<string>>(new Set())
  /** #36 已处理过"发送滚到底"的用户消息 id（items 每次流式更新都变，去重）。 */
  const lastSendScrollItemIdRef = useRef<string | null>(null)
  const lastPendingQueueLengthRef = useRef(0)
  // Footer 的 context：只在 bottomReserve 变化时换引用，不影响组件类型。
  const footerContext = useMemo(() => ({ bottomReserve }), [bottomReserve])
  // "stick to bottom": Virtuoso reports this via atBottomStateChange. While at
  // the bottom, followOutput pins to the newest content; scroll up to read and
  // it stops following until the ↓ button returns you.
  const [atBottom, setAtBottom] = useState(true)
  /**
   * 「回到最新」按钮的显示状态——与 atBottom（钉住/跟随）**刻意分开**。
   * 2026-08 重做：原先按钮直接用 `!atBottom`，而点击/悬停 bar 会主动解除钉住
   * （#8b），结果人还贴在底部、只是点了下折叠，按钮就蹦出来。现在钉住只管
   * 跟不跟随，按钮只管"视口是否真的离开了底部"。
   */
  const [showLatest, setShowLatest] = useState(false)
  const [deferHighlight, setDeferHighlight] = useState(true)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  /** #48 视口顶部附近对应的导航条目 id（高亮）。 */
  const [activeUserNavId, setActiveUserNavId] = useState<string | null>(null)
  /** #45 历史用户消息补回的图片附件（itemId → 附件）。 */
  const [historyAttachments, setHistoryAttachments] = useState<ReadonlyMap<string, UserAttachment[]>>(
    EMPTY_HISTORY_ATTACHMENTS
  )

  // #45 发送成功的图片附件落盘（渲染层订阅 store，内部幂等）。
  useEffect(() => {
    initSentImageRecording()
  }, [])

  // #45 历史重放的用户消息不带图片（kimi ACP 重放只合成文本块）：从 IndexedDB
  // 里按文本顺序匹配补回缩略图。historyUserIds 作签名，流式帧不触发重查。
  const historyUserIds = useMemo(
    () =>
      items
        .filter((it) => it.kind === 'user' && it.isHistory && !it.attachments?.length)
        .map((it) => it.id)
        .join(','),
    [items]
  )
  useEffect(() => {
    if (!attachmentKey || !historyUserIds) {
      setHistoryAttachments(EMPTY_HISTORY_ATTACHMENTS)
      return
    }
    let cancelled = false
    void loadSentImages(attachmentKey).then((records) => {
      if (cancelled) return
      setHistoryAttachments(matchHistoryImages(useSessionStore.getState().items, records))
    })
    return () => {
      cancelled = true
    }
  }, [attachmentKey, historyUserIds])

  const roots = useMemo(() => buildForest(items), [items])
  /**
   * 折叠决策的 sticky 记忆（2026-08 滚动稳定）：组第一次出现时，用户**在底部**
   * 才折成摘要行；在上翻阅读时出现的组保持展开——布局绝不在用户脚下变化。
   * 一旦定了就不再翻转（已经折的组不因为你上翻而重新展开，反之亦然），
   * 换会话时清空（见下面 useMemo 里的 prevSessionKeyRef 分支）。
   */
  const foldDecisionsRef = useRef(new Map<string, boolean>())
  const foldDecisionFor = (groupKey: string): boolean => {
    const map = foldDecisionsRef.current
    const existing = map.get(groupKey)
    if (existing !== undefined) return existing
    const decision = atBottomRef.current
    map.set(groupKey, decision)
    return decision
  }
  /**
   * 历史渐进注水会往 items **头部**插入旧消息（每次 50 条）。虚拟列表默认按
   * 下标定位，头部多出 N 条 = 当前可视内容整体往下推 N 条的高度——表现就是
   * 「往上滚、一停住、内容自己往下跳一大截」。触发链路：滚动时注水暂停，
   * `setTranscriptScrolling(false)` 一到就立刻续上并 set 一批到最前面。
   *
   * Virtuoso 对这个场景的正解是 `firstItemIndex`：取一个大基数，每次头部插入
   * 就把它减去插入条数，Virtuoso 据此把视觉位置钉住不动。这里用「上一帧的首行
   * key 在新数组里的下标」反推插入了多少——比让 store 额外上报计数更难出错，
   * 分组（toolGroup/envelopeGroup）导致的行数变化也一并算对。
   */
  const { displayRows, firstItemIndex } = useMemo(() => {
    const rows = buildDisplayRows(roots, foldDecisionFor)
    // 换会话：整表重来，基数复位，别把上个会话的偏移带过来。
    if (prevSessionKeyRef.current !== sessionKey) {
      prevSessionKeyRef.current = sessionKey
      firstItemIndexRef.current = FIRST_ITEM_INDEX_BASE
      prevFirstRowKeyRef.current = null
      foldDecisionsRef.current.clear()
    }
    const firstKey = rows.length ? rowKeyOf(rows[0]) : null
    const prevKey = prevFirstRowKeyRef.current
    if (prevKey !== null && firstKey !== prevKey) {
      const insertedAbove = rows.findIndex((row) => rowKeyOf(row) === prevKey)
      // >0 才是"头部插入"；-1 是旧首行已不在（换会话/清空），不动基数。
      if (insertedAbove > 0) firstItemIndexRef.current -= insertedAbove
    }
    prevFirstRowKeyRef.current = firstKey
    return { displayRows: rows, firstItemIndex: firstItemIndexRef.current }
  }, [roots, sessionKey])
  // #48 导航条目：顶层用户消息（排除系统信封；子代理转发的本就不在顶层行），
  // 按行号顺序排列，最新在下；条数封顶只留最近若干条。
  const userNavEntries = useMemo(() => {
    const entries: UserNavEntry[] = []
    displayRows.forEach((row, rowIndex) => {
      if (row.kind !== 'item') return
      const item = row.node.item
      if (item.kind !== 'user') return
      if (envelopeTextOf(row.node) !== null) return
      const text = item.text.replace(/\s+/g, ' ').trim()
      const summary = text
        ? text.slice(0, USER_NAV_SUMMARY_CHARS)
        : item.attachments?.length
          ? '[附件]'
          : ''
      if (!summary) return
      entries.push({ id: item.id, rowIndex, summary })
    })
    return entries.slice(-USER_NAV_MAX_ENTRIES)
  }, [displayRows])
  // "最新块"保持展开：最新一条 live（非历史）assistant 消息里的最后一个思考/
  // 工具块。纯文本段落开头的消息 → 无最新块（上一个收起）；最新是历史 → 不收。
  const lastExpandableKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind !== 'assistant') continue
      if (it.isHistory) return null
      for (let j = it.blocks.length - 1; j >= 0; j--) {
        const b = it.blocks[j]
        if (b && b.kind === 'tool') return b.toolUseId
        if (b && b.kind === 'thinking') return `${it.id}:thinking`
      }
      return null
    }
    return null
  }, [items])
  const scrollTuning = useMemo(
    () =>
      agentBackend === 'kimi'
        ? {
            increaseViewportBy: { top: 900, bottom: 1300 },
            overscan: { main: 900, reverse: 650 }
          }
        : {
            increaseViewportBy: { top: 260, bottom: 420 },
            overscan: { main: 260, reverse: 220 }
          },
    [agentBackend]
  )

  useEffect(() => {
    deferHighlightRef.current = deferHighlight
  }, [deferHighlight])

  // #8 埋点：items 每次因流式 flush 变化后，记录 store→commit 耗时（见 streamProbe）。
  useLayoutEffect(() => {
    probeCommit()
  }, [items])

  const setReserveEligible = (eligible: boolean, force = false): void => {
    if (!force && reserveEligibleRef.current === eligible) return
    reserveEligibleRef.current = eligible
    onAtBottomChange?.(eligible)
  }

  const setPinnedAtBottom = (nextAtBottom: boolean): void => {
    atBottomRef.current = nextAtBottom
    setAtBottom(nextAtBottom)
    // 重新钉住 = 回到底部跟随，按钮必然该收；解除钉住则**不**反过来亮按钮
    // ——解除可能只是点了下 bar，人还在底部（按钮由几何距离/atBottomStateChange 管）。
    if (nextAtBottom) setShowLatest(false)
  }

  // "↓ 最新"按钮的钉住路径：滚到底并显式重新钉住跟随。悬停/点击解除跟随后
  // Virtuoso 内部可能仍 atBottom（不会再次触发 atBottomStateChange），所以必须
  // 本地显式钉住才能恢复跟随（#8b）。#36 发送消息也走这条路径。
  const pinToBottom = (behavior: 'auto' | 'smooth'): void => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior })
    setReserveEligible(true, true)
    setPinnedAtBottom(true)
  }

  // #48 导航跳转 = 主动离开当前位置：解除底部钉住（若目标就在底部附近，落地
  // 后 atBottomStateChange 会自动恢复跟随），并记一次滚动意图（途中延迟高亮）。
  // #50 长距跳转用 auto：1000+ 动态高度列表里 smooth 会边滚边补渲染重测高，
  // 滚动动画被高度修正反复打断（半途卡住、目标附近持续闪），auto 一次到位。
  const jumpToUserMessage = (rowIndex: number): void => {
    lockFollowOutput()
    markScrollIntent()
    setPinnedAtBottom(false)
    // 传了 firstItemIndex 之后，Virtuoso 对外的下标空间是**绝对**的
    // （rangeChanged 上报的、scrollToIndex 接收的都含基数偏移），而
    // userNavEntries.rowIndex 是 displayRows 里的相对下标——必须先加基数，
    // 否则跳转会偏到十万八千里。
    const absoluteIndex = firstItemIndexRef.current + rowIndex
    const distance = Math.abs(absoluteIndex - lastRenderedRangeRef.current.startIndex)
    virtuosoRef.current?.scrollToIndex({
      index: absoluteIndex,
      align: 'start',
      behavior: distance > USER_NAV_SMOOTH_MAX_ROWS ? 'auto' : 'smooth'
    })
  }

  const userNavEntriesRef = useRef(userNavEntries)
  useEffect(() => {
    userNavEntriesRef.current = userNavEntries
  }, [userNavEntries])

  // #50 高亮按 DOM 实际几何算（不再用 range.startIndex 启发式）：rangeChanged
  // 上报的是含 overscan 的渲染范围，kimi 后端顶部多渲染 900px（约 2~4 条消息），
  // 滚到底时 startIndex 远在视口顶之上，启发式会把高亮偏到更早的用户消息。
  // 改为：scroller 滚动/渲染范围变化后，在 rAF 里取视口顶上方最后一条用户消息行。
  const lastRenderedRangeRef = useRef<ListRange>({ startIndex: 0, endIndex: 0 })
  const navHighlightFrameRef = useRef<number | null>(null)

  const cancelNavHighlightFrame = (): void => {
    if (navHighlightFrameRef.current !== null) {
      window.cancelAnimationFrame(navHighlightFrameRef.current)
      navHighlightFrameRef.current = null
    }
  }

  const updateActiveUserNav = (): void => {
    const entries = userNavEntriesRef.current
    if (entries.length === 0) {
      setActiveUserNavId((current) => (current === null ? current : null))
      return
    }
    if (!scrollElement) return
    let active: string | null = null
    // 贴底特判：底部时视口顶可能还落在倒数第二条消息的回合里（最新一条完整
    // 露在视口中），纯几何规则会少算一格——用户预期"在底部 = 高亮最新条"。
    const distanceFromBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
    if (distanceFromBottom <= FOLLOW_RESUME_AT_BOTTOM_THRESHOLD_PX) {
      active = entries[entries.length - 1].id
    } else {
      const scrollerTop = scrollElement.getBoundingClientRect().top
      const nodes = scrollElement.querySelectorAll<HTMLElement>('[data-user-msg-id]')
      for (const node of nodes) {
        if (node.getBoundingClientRect().top - scrollerTop <= USER_NAV_TOP_SLACK_PX) {
          active = node.dataset.userMsgId ?? null
        } else {
          break
        }
      }
    }
    // 视口顶上方没有用户消息行（或该行在导航窗口之外，被 MAX_ENTRIES 截掉）：
    // 视同处于窗口之上，高亮首条——与旧启发式的边界行为一致。
    if (active === null || !entries.some((entry) => entry.id === active)) {
      active = entries[0].id
    }
    setActiveUserNavId((current) => (current === active ? current : active))
  }

  const scheduleActiveUserNavUpdate = (): void => {
    if (navHighlightFrameRef.current !== null) return
    navHighlightFrameRef.current = window.requestAnimationFrame(() => {
      navHighlightFrameRef.current = null
      updateActiveUserNav()
    })
  }

  const handleRangeChanged = (range: ListRange): void => {
    lastRenderedRangeRef.current = range
    scheduleActiveUserNavUpdate()
  }

  // 会话切换/新消息改变条目后重算高亮（不依赖滚动事件）；scrollElement 晚于
  // 条目就绪时（如 HMR 重挂）也要补一次，否则高亮会一直空到下次滚动。
  useEffect(() => {
    scheduleActiveUserNavUpdate()
  }, [userNavEntries, scrollElement])

  const refreshReserveEligibleFromScroller = (element: HTMLElement | null = scrollElement): void => {
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    setReserveEligible(distanceFromBottom <= TOPBAR_RESERVE_NEAR_BOTTOM_THRESHOLD_PX)
  }

  const cancelBottomReserveScrollFrame = (): void => {
    if (bottomReserveScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomReserveScrollFrameRef.current)
      bottomReserveScrollFrameRef.current = null
    }
  }

  const cancelBottomReserveRestoreFrame = (): void => {
    if (bottomReserveRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomReserveRestoreFrameRef.current)
      bottomReserveRestoreFrameRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      cancelBottomReserveScrollFrame()
      cancelBottomReserveRestoreFrame()
      cancelNavHighlightFrame()
    }
  }, [])

  useEffect(() => {
    if (!scrollElement) return

    const updateReserveEligibility = (): void => {
      refreshReserveEligibleFromScroller(scrollElement)
      // 「回到最新」按钮按真实几何刷新：离底且未钉住才显示。钉住时的瞬时
      // 离底（内容增长、补滚在途）不算——马上会被跟随收敛，闪按钮只会晃眼。
      // 不能只靠 atBottomStateChange：它只在转变沿触发，补滚把内部状态拉回
      // at-bottom 之后用户再上滚，false 沿已经消费过、不会再报。
      const distanceFromBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
      setShowLatest(distanceFromBottom > FOLLOW_RESUME_AT_BOTTOM_THRESHOLD_PX && !atBottomRef.current)
      // #50 滚动即重算导航高亮（rAF 节流；短距 smooth 跳不触发 rangeChanged，
      // 只靠 rangeChanged 会漏更新）。
      scheduleActiveUserNavUpdate()
    }

    updateReserveEligibility()
    scrollElement.addEventListener('scroll', updateReserveEligibility, { passive: true })
    return () => {
      scrollElement.removeEventListener('scroll', updateReserveEligibility)
    }
  }, [scrollElement])

  useEffect(() => {
    layoutTransitioningRef.current = layoutTransitioning

    if (layoutTransitioning) {
      followOutputLockedUntilRef.current = window.performance.now() + FOLLOW_OUTPUT_LOCK_MS
      if (atBottom && bottomReserve <= 0) {
        restoreBottomAfterLayoutRef.current = true
        setPinnedAtBottom(false)
      }
      return
    }

    if (!restoreBottomAfterLayoutRef.current) return
    restoreBottomAfterLayoutRef.current = false

    window.requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      setReserveEligible(true, true)
      setPinnedAtBottom(true)
    })
  }, [atBottom, bottomReserve, layoutTransitioning])

  useEffect(() => {
    cancelBottomReserveScrollFrame()
    if (bottomReserve <= 0 || bottomReserveVersion <= 0 || !reserveEligibleRef.current) return

    followOutputLockedUntilRef.current = window.performance.now() + FOLLOW_OUTPUT_LOCK_MS
    restoreBottomAfterLayoutRef.current = false
    restoreBottomAfterReserveRef.current = true
    setPinnedAtBottom(false)
    bottomReserveScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomReserveScrollFrameRef.current = window.requestAnimationFrame(() => {
        bottomReserveScrollFrameRef.current = null
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
      })
    })
  }, [bottomReserve, bottomReserveVersion])

  useEffect(() => {
    cancelBottomReserveRestoreFrame()
    if (bottomReserve > 0 || !restoreBottomAfterReserveRef.current) return

    restoreBottomAfterReserveRef.current = false
    bottomReserveRestoreFrameRef.current = window.requestAnimationFrame(() => {
      bottomReserveRestoreFrameRef.current = window.requestAnimationFrame(() => {
        bottomReserveRestoreFrameRef.current = null
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' })
        setReserveEligible(true, true)
        setPinnedAtBottom(true)
      })
    })
  }, [bottomReserve])

  const clearHighlightTimer = (): void => {
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current)
      highlightTimeoutRef.current = null
    }
  }

  const clearScrollIntentTimer = (): void => {
    if (scrollIntentTimeoutRef.current !== null) {
      window.clearTimeout(scrollIntentTimeoutRef.current)
      scrollIntentTimeoutRef.current = null
    }
  }

  const resumeHighlightAfter = (delay: number): void => {
    clearHighlightTimer()
    highlightTimeoutRef.current = window.setTimeout(() => {
      highlightTimeoutRef.current = null
      setDeferHighlight(false)
    }, delay)
  }

  const applyTranscriptScrolling = (scrolling: boolean): void => {
    if (appliedScrollingRef.current === scrolling) return
    appliedScrollingRef.current = scrolling
    setTranscriptScrolling(scrolling)
    if (scrolling) {
      clearHighlightTimer()
      if (!deferHighlightRef.current) {
        deferHighlightRef.current = true
        setDeferHighlight(true)
      }
      return
    }
    resumeHighlightAfter(SCROLL_HIGHLIGHT_RESUME_MS)
  }

  const handleTranscriptScrolling = (scrolling: boolean): void => {
    virtuosoScrollingRef.current = scrolling
    applyTranscriptScrolling(scrolling || scrollIntentActiveRef.current)
  }

  const markScrollIntent = (): void => {
    scrollIntentActiveRef.current = true
    applyTranscriptScrolling(true)
    clearScrollIntentTimer()
    scrollIntentTimeoutRef.current = window.setTimeout(() => {
      scrollIntentTimeoutRef.current = null
      scrollIntentActiveRef.current = false
      applyTranscriptScrolling(virtuosoScrollingRef.current)
    }, SCROLL_INTENT_IDLE_MS)
  }

  const lockFollowOutput = (): void => {
    followOutputLockedUntilRef.current = window.performance.now() + FOLLOW_OUTPUT_LOCK_MS
  }

  const shouldFollowOutput = (isAtBottom: boolean): 'auto' | false => {
    // atBottomRef 是本地 pin 状态：用户在 bar 上点击/悬停解除跟随后，Virtuoso
    // 内部可能仍认为 atBottom——必须以本地状态为准，否则会继续强制下拽（#8b）。
    if (!isAtBottom || !atBottomRef.current) return false
    if (layoutTransitioningRef.current) return false
    if (window.performance.now() < followOutputLockedUntilRef.current) return false
    return 'auto'
  }

  const prevScrollTopRef = useRef(0)
  /** 最近一次滚动是不是"向上"（用户上滚 = true；内容增长/跟随下滚 = false）。 */
  const scrollWentUpRef = useRef(false)
  const handleScrollerScroll = (event: React.UIEvent<HTMLElement>): void => {
    const st = event.currentTarget.scrollTop
    scrollWentUpRef.current = st < prevScrollTopRef.current - 2
    prevScrollTopRef.current = st
  }

  const handleAtBottomStateChange = (nextAtBottom: boolean): void => {
    if (nextAtBottom) setReserveEligible(true)
    if (layoutTransitioningRef.current) {
      if (!nextAtBottom) setPinnedAtBottom(false)
      return
    }
    // 2026-08 重做「最新按钮误现」修复（第一版三处误伤，全在流式期间暴露）：
    // 1. 补滚只在**仍钉住**时做——点击/悬停 bar 主动解除跟随（#8b）后内容一
    //    增长就强拉回底，等于展开了也白展开，正在读的东西被抽走；
    // 2. "用户上滚"必须有真实输入佐证（scrollIntentActive：滚轮/指针/触摸都会
    //    标记）——流式中上一个块自动收起时内容变矮，浏览器钳制 scrollTop 也表现
    //    为"scrollTop 变小"，光看方向会把自动收起误判成上滚，跟随莫名断掉；
    // 3. 跟随锁生效期间不补滚（点击选中文本被拽走就是锁防的场景），锁过期后
    //    followOutput 会在下一次内容变化时自己接上。
    if (!nextAtBottom && atBottomRef.current) {
      const userScrolledUp = scrollWentUpRef.current && scrollIntentActiveRef.current
      if (!userScrolledUp) {
        if (window.performance.now() >= followOutputLockedUntilRef.current) {
          virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' })
        }
        return
      }
    }
    setPinnedAtBottom(nextAtBottom)
    setShowLatest(!nextAtBottom)
  }

  useEffect(() => {
    cancelBottomReserveScrollFrame()
    cancelBottomReserveRestoreFrame()
    restoreBottomAfterLayoutRef.current = false
    restoreBottomAfterReserveRef.current = false
    virtuosoScrollingRef.current = false
    scrollIntentActiveRef.current = false
    appliedScrollingRef.current = false
    seenItemIdsRef.current.clear()
    clearScrollIntentTimer()
    cancelNavHighlightFrame()
    setReserveEligible(true, true)
    setPinnedAtBottom(true)
    setActiveUserNavId(null)
    setDeferHighlight(true)
    resumeHighlightAfter(INITIAL_HIGHLIGHT_DELAY_MS)

    return () => {
      clearHighlightTimer()
      clearScrollIntentTimer()
      setTranscriptScrolling(false)
    }
  }, [sessionKey, setTranscriptScrolling])

  // #36 发送消息 = 明确"去底部"意图：即使用户之前上翻/点击/悬停解除了跟随，
  // 自己发出消息时也重新钉住并滚到底（与"↓ 最新"按钮同一条路径）。判定：
  // 末尾出现一条新的顶层用户消息（非历史重放、非子代理转发、非系统信封）。
  useEffect(() => {
    const last = items[items.length - 1]
    if (!last || last.kind !== 'user') return
    if (last.isHistory || last.parentToolUseId) return
    if (isEnvelopeText(last.text)) return
    if (lastSendScrollItemIdRef.current === last.id) return
    lastSendScrollItemIdRef.current = last.id
    pinToBottom('auto')
  }, [items])

  // #36 补齐排队路径：turn 忙时 sendMessage 推的是 pendingQueue，items 不变，
  // 上面那条 effect 不触发。队列变长同样是用户刚发了消息，一样要回底。
  // 只在"变长"时触发——出队（队列消费）不该抢用户的滚动位置。
  useEffect(() => {
    const previous = lastPendingQueueLengthRef.current
    lastPendingQueueLengthRef.current = pendingQueueLength
    if (pendingQueueLength > previous) pinToBottom('auto')
  }, [pendingQueueLength])

  if (items.length === 0) {
    return (
      <div className="transcript-scroll h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col items-center justify-center px-6 py-6 text-center">
          {starting ? (
            /* 会话打开骨架（replay 到达前）：气泡形占位 shimmer + 提示。 */
            <div className="flex w-full max-w-3xl flex-col gap-4">
              <div className="ml-auto h-9 w-2/5 animate-pulse rounded-2xl bg-white/[0.05]" />
              <div
                className="h-16 w-3/5 animate-pulse rounded-2xl bg-white/[0.04]"
                style={{ animationDelay: '150ms' }}
              />
              <div
                className="h-9 w-1/2 animate-pulse rounded-2xl bg-white/[0.05]"
                style={{ animationDelay: '300ms' }}
              />
              <p className="pt-2 text-center text-xs text-zinc-600">正在进入会话，历史在后台接上…</p>
            </div>
          ) : (
            <>
          <EmptyState />
            </>
          )}
        </div>
      </div>
    )
  }

  const renderRow = (row: DisplayRow): JSX.Element => {
    if (row.kind === 'toolGroup') {
      // 与 AssistantMessage 的 depth-0 容器同宽（.tran-ai-col，56rem），保证工具
      // 分组 bar 与思考/文本/单个工具 bar 等宽（#9）。tran-ai-col 是给外观
      // 主题用的稳定钩子：简约风把这一列居中，用户发言再对齐到同一列。
      return (
        <div className="tran-ai-col">
          <ToolGroupCard
            blocks={row.blocks}
            forceOpen={row.blocks.some((b) => b.toolUseId === lastExpandableKey)}
            expandedBlockKey={lastExpandableKey}
          />
        </div>
      )
    }
    if (row.kind === 'activityGroup') {
      return (
        <div className="tran-ai-col">
          <ActivityGroupCard
            blocks={row.blocks}
            forceOpen={row.blocks.some(
              (b) => b.kind === 'tool' && b.toolUseId === lastExpandableKey
            )}
            expandedBlockKey={lastExpandableKey}
          />
        </div>
      )
    }
    if (row.kind === 'envelopeGroup') {
      return <EnvelopeGroupRow entries={row.entries} />
    }
    if (row.node.item.kind === 'user')
      return (
        <UserMessage
          item={row.node.item as UserItem}
          hydratedAttachments={historyAttachments.get(row.node.item.id)}
        />
      )
    if (row.node.item.kind === 'compaction') return <CompactionDivider item={row.node.item} />
    if (row.node.item.kind === 'query') return <QueryResultCard item={row.node.item} />
    if (row.node.item.kind === 'turnChanges') {
      return (
        <TurnChangesCard
          item={row.node.item}
          onReview={() => emitForgeEvent('openChangesPanel')}
        />
      )
    }
    return (
      <AssistantMessage
        item={row.node.item as AssistantItem}
        depth={0}
        deferHighlight={deferHighlight}
        expandedBlockKey={lastExpandableKey}
      />
    )
  }

  return (
    <div
      className="relative h-full"
      onPointerDownCapture={(event) => {
        // 「回到最新」按钮自身不该触发跟随锁（2026-08 bug：点它时先吃了
        // lockFollowOutput，流式期间被锁在半路，怎么点都滑不到真底）。
        if ((event.target as HTMLElement).closest?.('[data-follow-no-lock]')) return
        lockFollowOutput()
        markScrollIntent()
        // #8b 聚焦意图：点击某个 bar（展开思考/工具卡、选中文本）即视为停下
        // 阅读，解除跟随；回到底部附近（atBottomThreshold）后自动恢复。
        if ((event.target as HTMLElement).closest?.(TRANSCRIPT_BAR_SELECTOR)) {
          setPinnedAtBottom(false)
        }
      }}
      onPointerMoveCapture={() => {
        lastPointerMoveAtRef.current = window.performance.now()
      }}
      onPointerOverCapture={(event) => {
        // #8b 停留意图：流式期间指针主动移上某个 bar 并停留（最近有真实移动），
        // 解除跟随，避免内容从静止的阅读焦点下被拽走。内容自动滚动从静止指针
        // 下方滑过时不触发（无 pointermove）。
        if (!useSessionStore.getState().status.running) return
        if (window.performance.now() - lastPointerMoveAtRef.current > BAR_HOVER_INTENT_WINDOW_MS) return
        if (!(event.target as HTMLElement).closest?.(TRANSCRIPT_BAR_SELECTOR)) return
        lockFollowOutput()
        markScrollIntent()
        setPinnedAtBottom(false)
      }}
      onWheelCapture={(event) => {
        // #48 导航条内部的滚轮（滚动摘要列表）不算转录区的滚动意图，不误解除跟随。
        if ((event.target as HTMLElement).closest?.('[data-user-msg-nav]')) return
        lockFollowOutput()
        markScrollIntent()
        if (event.deltaY < 0) setPinnedAtBottom(false)
      }}
      onTouchMoveCapture={markScrollIntent}
    >
      <Virtuoso
        ref={virtuosoRef}
        data={displayRows}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: Math.max(displayRows.length - 1, 0), align: 'end' }}
        computeItemKey={(_, row) => rowKeyOf(row)}
        increaseViewportBy={scrollTuning.increaseViewportBy}
        overscan={scrollTuning.overscan}
        scrollerRef={(element) => {
          const nextElement = element instanceof HTMLElement ? element : null
          setScrollElement((current) => (current === nextElement ? current : nextElement))
        }}
        isScrolling={handleTranscriptScrolling}
        onScroll={handleScrollerScroll}
        rangeChanged={handleRangeChanged}
        itemContent={(index, row) => {
          // Per-row wrapper preserves the centered, padded column the old single
          // container provided; py-1.5 keeps the block rhythm tight (#9, Kimi Web feel).
          // 入场动画只给"新到"的消息（seenItemIdsRef 去重，滚动复用不重播）；
          // 批量历史同帧挂载时 stagger 封顶 300ms。
          const rowKey = rowKeyOf(row)
          const isNew = !seenItemIdsRef.current.has(rowKey)
          if (isNew) seenItemIdsRef.current.add(rowKey)
          // 历史/实况分界：上一行是重放历史、当前行不是 → 加分隔小字。
          // ⚠ 传了 firstItemIndex 后这里的 index 是**绝对**下标（含百万级基数），
          // 直接拿去索引 displayRows 一律 undefined——分隔线会静默消失。
          const relIndex = index - firstItemIndex
          const prevRow = relIndex > 0 ? displayRows[relIndex - 1] : null
          const prevItem = prevRow && prevRow.kind === 'item' ? prevRow.node.item : null
          const curItem = row.kind === 'item' ? row.node.item : null
          const showHistoryDivider = !!prevItem?.isHistory && !!curItem && !curItem.isHistory
          // #50 顶层用户消息行打标：导航高亮按 DOM 几何定位（见 updateActiveUserNav）。
          const userMsgId =
            row.kind === 'item' && row.node.item.kind === 'user' && envelopeTextOf(row.node) === null
              ? row.node.item.id
              : undefined
          return (
            <div
              data-user-msg-id={userMsgId}
              className={`mx-auto w-full max-w-5xl px-6 py-1.5 ${isNew ? 'tran-msg-enter' : ''}`}
              style={isNew ? { animationDelay: `${Math.min(relIndex * 24, 280)}ms` } : undefined}
            >
              {showHistoryDivider && (
                <div className="mb-2 flex items-center gap-2 text-[10px] text-zinc-600">
                  <span className="h-px flex-1 bg-white/[0.06]" />
                  以上为历史消息
                  <span className="h-px flex-1 bg-white/[0.06]" />
                </div>
              )}
              {renderRow(row)}
            </div>
          )
        }}
        followOutput={shouldFollowOutput}
        atBottomThreshold={FOLLOW_RESUME_AT_BOTTOM_THRESHOLD_PX}
        atBottomStateChange={handleAtBottomStateChange}
        className="transcript-scroll h-full"
        components={VIRTUOSO_COMPONENTS}
        context={footerContext}
      />
      <UserMessageNav entries={userNavEntries} activeId={activeUserNavId} onJump={jumpToUserMessage} />
      {/* 回到最新：底部居中（Codex 风，2026-08 用户点名）。输出中箭头挂
          紫黄流光（动态=正在干活），非输出静态箭头。按钮带 data-follow-no-lock：
          点它不吃 pointerdown 的跟随锁，否则流式期间永远差一截到不了底。 */}
      {!layoutTransitioning && showLatest && (
        <LatestButton onJump={pinToBottom} />
      )}
    </div>
  )
}
