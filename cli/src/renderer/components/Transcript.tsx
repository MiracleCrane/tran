import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import { probeCommit } from '../utils/streamProbe'
import type { AssistantBlock, AssistantItem, TextBlock, UserAttachment, UserItem, TranscriptItem, ItemNode, ToolBlock } from '../types'
import MessageText from './MessageText'
import { ToolGlyph, FRIENDLY_TOOL_NAMES } from './toolIcons'
import { showImageContextMenu } from './ImageContextMenu'
import { formatTimeFull, formatTimeShort, messageTime } from '../utils/messageTimes'
import { initSentImageRecording, loadSentImages, matchHistoryImages } from '../utils/sentImages'
import SkillCard, { matchSkillInvocation } from './SkillCard'
import ToolCallCard, { summaryForTool } from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import CompactionDivider from './CompactionDivider'
import Collapse from './Collapse'
import EmptyState from './EmptyState'
import QueryResultCard from './QueryResultCard'
import TurnChangesCard from './TurnChangesCard'
import { openChangesPanel } from '../events'
import UserMessageNav, { type UserNavEntry } from './UserMessageNav'
import { useCheapNote } from '../hooks/useCheapNote'
import { useTransientFlag } from '../hooks/useTransientFlag'

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
/** Virtuoso firstItemIndex 的起始基数：头部每插入 N 条就减 N，够减很久。 */
const FIRST_ITEM_INDEX_BASE = 1_000_000
/** 注水龙头（2026-08-26）：非钉底时，首条可见行距已加载顶部不足这么多行
 *  算 edge 区（需要续注历史），否则是 mid 阅读区（暂停注水）。 */
const HISTORY_PRELOAD_EDGE_ROWS = 40
/** prepend 补偿的头部锚点行数（见 displayRows memo 补偿段注释）。 */
const PREPEND_ANCHOR_ROW_COUNT = 8
/** 思考框内距底多少像素以内算"还贴着底"（继续跟随流式输出）。 */
const THINKING_FOLLOW_BOTTOM_THRESHOLD_PX = 24
// #48/#50 高亮判定：用户消息行顶距视口顶多少 px 内算"视口顶部附近"。
const USER_NAV_TOP_SLACK_PX = 8
// #50 长距跳转（行数差超过该值）用 auto 一次到位——动态高度列表里 smooth
// 长跳会边滚边补渲染重测高，卡在半途并持续闪；短距保留 smooth 过渡感。
const USER_NAV_SMOOTH_MAX_ROWS = 40
/** #45 无历史附件时的共享空 Map（避免每次渲染新引用击穿 UserMessage memo）。 */
const EMPTY_HISTORY_ATTACHMENTS: ReadonlyMap<string, UserAttachment[]> = new Map()
/** 导航条无高亮时的共享空 Set（同上，避免新引用触发无谓重渲染）。 */
const EMPTY_NAV_IDS: ReadonlySet<string> = new Set()
/** 导航条悬停卡片里 AI 回复预览的截断长度（卡片只显示三行）。 */
const USER_NAV_PREVIEW_CHARS = 160
/** 跳转后目标气泡的高亮闪烁（同 Codex 的时序：亮起 → 停住 35% → 淡出）。 */
const USER_NAV_FLASH_FROM = '0 0 0 2px rgba(139, 92, 246, 0.55)'
const USER_NAV_FLASH_TO = '0 0 0 2px rgba(139, 92, 246, 0)'

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
  // 2026-08 用户要求：发消息后到首个输出之前的等待提示（Codex 风）。
  // running 且最后一条 assistant 还没有任何块（思考/正文都还没来）时显示；
  // 思考块一开始流式，它自己的流光标题就接棒了。
  const waitingFirstOutput = useSessionStore((s) => {
    if (!s.status.running) return false
    const last = s.items[s.items.length - 1]
    if (!last || last.kind !== 'assistant') return true
    return last.blocks.every((b) => !b || (b.kind === 'text' && !b.text.trim()))
  })
  const bottomReserve = context?.bottomReserve ?? 0
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-2">
      {waitingFirstOutput && (
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-zinc-500">
            <ToolGlyph kind="think" size={12} />
          </span>
          <span className="flow-text flow-text-violet">正在思考…</span>
        </div>
      )}
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
  /** 段级折叠下的混合消息：只渲染文本块（思考/工具已收进该段的集合组）。 */
  | { kind: 'itemText'; node: ItemNode }
  | { kind: 'toolGroup'; id: string; blocks: ToolBlock[] }
  /** B 方案：跨消息的「思考 + 工具」活动组（含思考时才用，纯工具仍走 toolGroup）。
   *  live=true 表示组还在流式生长（整组总结等收尾后再问，见 ActivityGroupCard）。 */
  | { kind: 'activityGroup'; id: string; blocks: AssistantBlock[]; live?: boolean }
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
  return row.kind === 'item' || row.kind === 'itemText' ? row.node.item.id : row.id
}

/** 轮级折叠时混合消息的"只留文本块"过滤结果缓存：以原 item 引用为键——
 *  流式合帧只换 streaming 消息的引用，已完成消息全程命中缓存，不破坏
 *  AssistantMessage 的 memo。 */
const textOnlyItemCache = new WeakMap<AssistantItem, AssistantItem>()
function textOnlyItemOf(item: AssistantItem): AssistantItem {
  let cached = textOnlyItemCache.get(item)
  if (!cached) {
    cached = { ...item, blocks: item.blocks.filter((b): b is AssistantBlock => !!b && b.kind === 'text') }
    textOnlyItemCache.set(item, cached)
  }
  return cached
}

function buildDisplayRows(
  roots: ItemNode[],
  shouldFold: (groupKey: string, inheritFrom?: string | null, forceFold?: boolean) => boolean,
  holdLiveOpen = false
): DisplayRow[] {
  const rows: DisplayRow[] = []
  let envelopeRun: ItemNode[] = []
  /** 当前轮（上一条轮边界消息之后）的助手消息。 */
  let turnNodes: ItemNode[] = []

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

  /** 混合消息（既有正文又有思考/工具）里的活动块。 */
  const mixedActivityOf = (node: ItemNode): AssistantBlock[] | null => {
    const item = node.item
    if (item.kind !== 'assistant' || item.error || item.streaming) return null
    if (activityBlocksOf(node)) return null // 纯活动消息不在这里
    const acts = item.blocks.filter((b): b is AssistantBlock => !!b && (b.kind === 'tool' || b.kind === 'thinking'))
    const hasText = item.blocks.some((b) => !!b && b.kind === 'text')
    return acts.length > 0 && hasText ? acts : null
  }

  /**
   * 收段消息**流式期间**的混合活动块（2026-08-26 修折叠延迟）：mixedActivityOf
   * 对流式消息一律返回 null（「正在跑的活动必须实时可见」），于是段尾混合消息
   * 自身的思考/工具块要等消息**封口**（下一个 tool_call 或轮末，秒级）才进组
   * ——短段（前序块 + 收段消息自身的块才够 ≥2）因此正文都流半天了还没折。
   * 正文块已出现即收段（textBearing 不看 streaming）：kimi/claude 的消息都是
   * 先思考后正文，正文开流时前面的思考/工具事实已定稿，直接并入组行；组行
   *  blocks 每帧随流式重建（计数动态性已验证），即便有迟到 delta 也照更新。
   * 仅用于 closing——段内/尾段的流式节点仍按原规则保持展开。
   */
  const streamingClosingActsOf = (node: ItemNode): AssistantBlock[] | null => {
    const item = node.item
    if (item.kind !== 'assistant' || item.error || !item.streaming) return null
    const acts = item.blocks.filter((b): b is AssistantBlock => !!b && (b.kind === 'tool' || b.kind === 'thinking'))
    return acts.length > 0 ? acts : null
  }

  /**
   * 段级折叠（2026-08-20 用户拍板：「以 AI 输出的实在文字为界，一轮可能有多个
   * 折叠 bar，按顺序排好」）：同一轮里被**正文文本**隔开的活动（思考/工具）各自
   * 成组——每段收成一条集合摘要行。已闭合的段：组行落在段内第一个被折节点的
   * 位置（与 wire 重建的历史布局一致）；正在跑的开口段：组行贴着 live 尾巴
   * （折点在用户眼前、计数实时涨，不会"bar 凭空消失"，2026-08-18）。解说/回答
   * 文本保持原位可见（混合消息只留文本块）。
   *
   * 前身是轮级一整条（2026-08-18「一整个思考块命令块执行完了就整个收起来」）：
   * 整轮所有活动收进一条组行落在轮首，几段解说之间的 bar 全被抽走合并，工作
   * 过程与解说错位（2026-08-20 用户：「你现在都收到一起去了是不对的」）。
   *
   * live 尾巴规则不变：开口段只留最后 KEEP_TAIL_OPEN 条活动节点展开（正在输出
   * 的 + 上一个），更早的即刻折进该段集合行。live 闸门只盖当前轮的开口段。
   */
  const flushTurn = (isLiveSegment: boolean): void => {
    if (turnNodes.length === 0) return
    // live 尾巴起点：最后一条含正文块（且非历史）的消息之后。没有正文就是
    // 轮刚起步，整段都算尾巴（先保持展开）。
    let liveTailStart = turnNodes.length
    if (isLiveSegment) {
      for (let i = turnNodes.length - 1; i >= 0; i--) {
        const item = turnNodes[i].item
        if (
          item.kind === 'assistant' &&
          !item.isHistory &&
          item.blocks.some((b): b is AssistantBlock => !!b && b.kind === 'text')
        ) {
          liveTailStart = i + 1
          break
        }
      }
    }
    // 尾巴里的活动节点：只留最后 2 条展开（正在输出的 + 上一个）。
    let lastAct = -1
    let prevAct = -1
    if (isLiveSegment) {
      for (let i = liveTailStart; i < turnNodes.length; i++) {
        const node = turnNodes[i]
        if (node.item.isHistory) continue
        if (activityBlocksOf(node) ?? mixedActivityOf(node)) {
          prevAct = lastAct
          lastAct = i
        }
      }
    }
    const live = (index: number, node: ItemNode): boolean =>
      isLiveSegment &&
      !node.item.isHistory &&
      index >= liveTailStart &&
      (index === lastAct || index === prevAct)
    const textBearing = (node: ItemNode): boolean =>
      node.item.kind === 'assistant' &&
      node.item.blocks.some((b) => !!b && b.kind === 'text')
    /** 轮内最后一条含正文消息 id：开口尾段的组 id 锚点（见 flushSegment 注释）。 */
    let lastTextId: string | null = null

    /** 当前段（正文边界之间）的节点 + 轮内下标。 */
    let seg: Array<{ node: ItemNode; index: number }> = []

    /** 收一段。closing 是闭段的含正文消息（混合消息的活动块并入本段组行）；
     *  开口段传 null。返回 closing 的渲染方式：'text' = 只留文本块（活动已进
     *  组行），'full' = 整条原样。 */
    const flushSegment = (closing: ItemNode | null, isOpenTail: boolean): 'text' | 'full' => {
      const groupBlocks: AssistantBlock[] = []
      let firstId: string | null = null
      const foldedIndexes = new Set<number>()
      for (const { node, index } of seg) {
        if (live(index, node)) continue
        const blocks = activityBlocksOf(node)
        if (blocks) {
          if (!firstId) firstId = node.item.id
          groupBlocks.push(...blocks)
          foldedIndexes.add(index)
        }
      }
      // 收段消息流式期间的活动块也并入（streamingClosingActsOf，见上方注释）——
      // 正文开流即折，不等封口。
      const closingActs = closing ? (mixedActivityOf(closing) ?? streamingClosingActsOf(closing) ?? []) : []
      if (closingActs.length) {
        if (!firstId && closing) firstId = closing.item.id
        groupBlocks.push(...closingActs)
      }
      // 组 id 锚点（2026-08-25 改）：闭段锚在**收段的正文消息** id 上，开口尾段
      // 锚在轮内最后一条正文消息 id 上（加 tail 前缀避免与该正文消息闭合的前一段
      // 撞键）；整轮还没有正文（轮刚起步的流式开口段）才退回段内第一个被折节点。
      // 旧锚点就是 firstId——历史注水把段**向前**延伸时 firstId 变、组行换 id
      // 重挂载，sticky 折叠态查找落空退回 atBottom 判定，组被意外摊开（且
      // firstItemIndex 补偿的旧 key 反推法也死在同一个 id 漂移上）。注水只往
      // 头部加更早的条目，收段/轮内最后的正文消息永远在已加载部分里，id 稳定。
      let groupId: string | null = null
      if (closing) groupId = `turn-group-${closing.item.id}`
      else if (lastTextId) groupId = `turn-group-tail-${lastTextId}`
      else if (firstId) groupId = `turn-group-${firstId}`
      // 决策继承（2026-08-26 修 live 不折回归，两轮修复）：
      // 轮级血缘——v1.1.21「边输出边折叠」之所以稳，是因为整轮只有一条组、键在
      // 轮首（发送后必钉住）登记一次 sticky=true，之后边长边折不再重判。段级化
      // （2026-08-20）后每段/每尾各拿新键各自登记，live 期间悬停/点击 bar（#8b）
      // 或上滚解除跟随钉住后，新键按当时的 atBottom=false 登记且 sticky 不可翻，
      // 该段本轮剩余时间一直摊开（实证：首批折成一行后，闭段再长 13+ 块全摊开，
      // 轮末才被 turnJustEnded 收起）。修复＝把整轮的折叠决定串成一条血缘：
      // ① 闭段键继承该段开口尾段时期已登记的决策（闭段只是换锚不是新组）；
      // ② 闭段后新生的开口尾段继承刚闭合段的决策（同轮同决定）。
      // 链路只在某段从未成组（<2 块无登记）处断开，退回按当时 atBottom 新判。
      // 注（2026-08-26 第三轮）：live 轮的组现已一律折（见 foldDecisionFor 的
      // forceFold），血缘只是兜底；atBottom 门控只剩历史/已结束轮的组在用。
      let inheritFrom: string | null = null
      if (closing) {
        inheritFrom = lastTextId
          ? `turn-group-tail-${lastTextId}`
          : firstId
            ? `turn-group-${firstId}`
            : null
        if (inheritFrom === groupId) inheritFrom = null
      } else if (lastTextId) {
        inheritFrom = `turn-group-${lastTextId}`
      }
      // ≥2 块才折：单块段（纯文本解说 + 每步单命令的轮次）保持普通卡片 inline
      // 显示——那不属于"该折没折"，是用户定稿的直排（2026-08-21 拍板）。
      // isLiveSegment 透传为 forceFold：进行中的这轮一律边长边折。
      const fold =
        groupBlocks.length >= 2 && groupId !== null && shouldFold(groupId, inheritFrom, isLiveSegment)
      if (!fold || groupId === null) {
        for (const { node } of seg) rows.push({ kind: 'item', node })
        seg = []
        return 'full'
      }
      const stableGroupId: string = groupId
      const groupRow = (): DisplayRow => {
        const id = stableGroupId
        const pureTools = groupBlocks.every((b): b is ToolBlock => b.kind === 'tool')
        return pureTools
          ? { kind: 'toolGroup', id, blocks: groupBlocks as ToolBlock[] }
          : { kind: 'activityGroup', id, blocks: groupBlocks, live: isOpenTail }
      }
      const segHasLive = seg.some(({ node, index }) => live(index, node))
      let groupEmitted = false
      for (const { node, index } of seg) {
        // 开口段：组行贴在第一个 live 节点之前；闭段：落在段内第一个被折节点处。
        if (!groupEmitted && (segHasLive ? live(index, node) : foldedIndexes.has(index))) {
          rows.push(groupRow())
          groupEmitted = true
        }
        if (foldedIndexes.has(index)) continue
        rows.push({ kind: 'item', node })
      }
      // 段内没有可落点的节点（段为空、组块全部来自 closing 混合消息；或开口段
      // 尚无 live 节点）：组行补在段尾——仍在 closing 文本之前，顺序不乱。
      if (!groupEmitted) rows.push(groupRow())
      seg = []
      return closingActs.length > 0 ? 'text' : 'full'
    }

    for (let i = 0; i < turnNodes.length; i++) {
      const node = turnNodes[i]
      if (textBearing(node)) {
        const mode = flushSegment(node, false)
        lastTextId = node.item.id
        rows.push({ kind: mode === 'text' ? 'itemText' : 'item', node })
      } else {
        seg.push({ node, index: i })
      }
    }
    // 尾巴段：正在跑的这轮的开口部分（轮已结束/历史时就是最后一段）。
    flushSegment(null, isLiveSegment)
    turnNodes = []
  }

  for (const node of roots) {
    // 噪音信封：整条丢弃，不打断轮（它在视觉上根本不存在）。
    if (isHiddenEnvelope(node)) continue
    if (node.item.kind === 'assistant') {
      turnNodes.push(node)
      continue
    }
    // 用户发言 / 压缩分隔 / 轮末改动卡 / 信封：轮边界，先把上一轮收掉。
    // 已结束的段不是 live 段（live 闸门只留给最后一段，见 flushTurn 注释）。
    flushTurn(false)
    if (envelopeTextOf(node) !== null) {
      envelopeRun.push(node)
      continue
    }
    flushEnvelopes()
    rows.push({ kind: 'item', node })
  }
  // 最后一段：holdLiveOpen 时就是正在跑的这一轮。
  flushTurn(holdLiveOpen)
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

/* --- 复制控件的小图标（inline SVG，同 GitToolbar 的惯例） --- */
const CopyIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
    <path d="M5.25 1.75C5.25.784 6.034 0 7 0h7.25C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11H7a1.75 1.75 0 0 1-1.75-1.75Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.25a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
  </svg>
)

/** 悬停复制控件（2026-08-24 改版：Kimi Web 风格的小图标行，替代侧边留白里
 *  的文字按钮）。与时间戳（#43）共用 group/msg 悬停淡入机制，但不再占侧边
 *  留白——AI 挂在正文列末尾的左下、用户挂在气泡右下角，都贴在消息块底边
 *  外侧（样式见 styles.css 的 .tran-msg-copy）。
 *  两个图标：复制（渲染后的富文本——从 .prose-forge DOM 读 innerHTML 写
 *  text/html，纯文本回退用同批节点的 textContent）在前，Markdown 源文在后。
 *  用户消息也渲染成 markdown 之后，两种消息同一套口径。
 *
 *  2026-08-24 起 AI 侧按「整轮」复制：一轮（一条用户发言到下一轮边界之间的
 *  所有 AI 消息）只在本轮最后一条消息上挂一组图标，复制内容聚合整轮——
 *  MD 源文由 Transcript 预先拼好传入，富文本按 turnKey 从 DOM 捞本轮全部
 *  消息的 .prose-forge（每条消息根节点都打着 data-turn-id）。 */
const MessageCopyControls = memo(function MessageCopyControls({
  placement,
  text,
  richRootRef,
  turnKey
}: {
  /** 挂在哪：AI 正文列末尾左下 / 用户气泡右下角（对应 .tran-msg-copy-*）。 */
  placement: 'assistant' | 'user'
  /** Markdown 源文（MD 图标复制的内容；AI 为整轮聚合，用户消息即原始输入）。 */
  text: string
  /** 「复制」从这里捞渲染后的 .prose-forge（仅用户气泡用；AI 走 turnKey 按轮捞）。 */
  richRootRef?: RefObject<HTMLDivElement | null>
  /** AI 整轮复制的轮标识（本轮首条 AI 消息 id）：按 data-turn-id 捞本轮所有
   *  消息的 .prose-forge。 */
  turnKey?: string
}): JSX.Element {
  // useTransientFlag 管定时器的取消与卸载清理（同 PreRenderer 的复制钮）。
  const [copiedText, flashText] = useTransientFlag(1200)
  const [copiedRich, flashRich] = useTransientFlag(1200)

  const copyText = async (): Promise<void> => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      flashText()
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  const copyRich = async (): Promise<void> => {
    // AI 按轮捞（整轮所有消息的 .prose-forge，DOM 顺序即输出顺序）；用户消息
    // 只捞自己气泡里的。注意：虚拟列表把本轮更早的消息卸载出 DOM 时，富文本
    // 复制只能拿到仍在渲染窗口内的部分（MD 源文复制始终是整轮全文）。
    const nodes = turnKey
      ? document.querySelectorAll(`[data-turn-id="${CSS.escape(turnKey)}"] .prose-forge`)
      : richRootRef?.current?.querySelectorAll('.prose-forge')
    if (!nodes || nodes.length === 0) return
    const html = Array.from(nodes).map((n) => n.innerHTML).join('\n')
    // text/plain 给 Markdown 源文而不是拍扁的 textContent（2026-08-24 用户反馈）：
    // 粘到纯文本目标（含 Tran 自己的输入框——输入框不做 md 自动解析）时结构以
    // markdown 形态保留；textContent 只剩肉眼排版，**、#、列表记号全丢。
    const plain =
      text || Array.from(nodes).map((n) => n.textContent ?? '').join('\n\n')
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' })
        })
      ])
      flashRich()
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return (
    <div className={`tran-msg-copy tran-msg-copy-${placement}`}>
      <button
        type="button"
        className="tran-msg-copy-btn"
        onClick={() => void copyRich()}
        title="复制（渲染后的排版）"
        aria-label="复制（渲染后的排版）"
      >
        {copiedRich ? '✓' : <CopyIcon />}
      </button>
      <button
        type="button"
        className="tran-msg-copy-btn"
        onClick={() => void copyText()}
        title="复制 Markdown（源文）"
        aria-label="复制 Markdown（源文）"
      >
        {copiedText ? '✓' : <span className="tran-msg-copy-md">MD</span>}
      </button>
    </div>
  )
})

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
  // 气泡根节点 ref：「复制」（富文本）从这里捞渲染后的 .prose-forge DOM
  // （AI 侧 2026-08-24 起改按轮复制，走 data-turn-id，不再用 rootRef）。
  const bubbleRef = useRef<HTMLDivElement>(null)
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
      <div ref={bubbleRef} className="tran-user-bubble max-w-[85%] rounded-[16px] rounded-tr-md border border-white/10 bg-gradient-to-br from-accent/[0.14] via-white/[0.06] to-white/[0.03] px-4 py-2.5 shadow-lg shadow-black/10">
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
        {/* 用户消息也走 markdown 管线（2026-08-24，与 AI 正文同一个 MessageText，
            链接/路径可点、加粗代码可渲染；气泡内的排版微调见 styles.css 的
            .tran-user-bubble .prose-forge——段落内软换行保留、段落间距收紧）。 */}
        {item.text && <MessageText>{item.text}</MessageText>}
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
                    // 高度占位（2026-08-25）：图片无固有尺寸声明，解码完成后行高
                    // 才撑开，历史注水补图时整片视口抖动。先给 4/3 中性占位，
                    // onLoad 换成真实宽高比（直接改 DOM：style prop 值不变，React
                    // 重渲染不会回拨）。max-h-44/max-w 约束不变。
                    style={{ aspectRatio: '4 / 3' }}
                    onLoad={(e) => {
                      const img = e.currentTarget
                      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`
                      }
                    }}
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
      {/* 悬停复制：与时间戳同一套显隐机制，图标行挂在气泡右下角。
          无文本（纯附件）时没有可复制内容，不显示。 */}
      {item.text && <MessageCopyControls placement="user" text={item.text} richRootRef={bubbleRef} />}
    </div>
  )
})

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false,
  forceExpanded = false,
  autoTranslate = false
}: {
  text: string
  streaming?: boolean
  /** "最新块"保持展开（渲染期派生，见 Transcript 的 lastExpandableKey）。 */
  forceExpanded?: boolean
  /** 允许自动翻译：仅「整轮的最新块」（且非 holdOpen 撑开的轮次中途块）。
   *  2026-08-14：holdOpen 让整轮所有块都展开，open 即翻译的规则把一轮里每段
   *  思考都打成一次 LLM 翻译调用——洪峰排队，翻译变慢。回到旧口径：自动翻的
   *  只有最终那块，其余块用户手动展开（userToggled）才翻。 */
  autoTranslate?: boolean
}): JSX.Element {
  // 默认收起（一行摘要"思考过程 · N 字"）；流式期间或作为"最新块"时自动展开，
  // 出现下一个块后收回；用户手动点击后以其选择为准。展开态定高 200px 内部滚动。
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? (forceExpanded || streaming)
  // 懒挂载：从没展开过的思考块不渲染正文（长会话里几十段全文 markdown 白
  // 渲染）；第一次展开后常驻，之后开合才能走 Collapse 的高度动画。
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
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

  // 展开且**思考收尾后**才翻译（2026-08 用户定夺：边输出边翻会卡——流式期间
  // 快照译文和滚动的原文对不上，回退到收尾统一翻）。不展开不翻。
  // 自动翻只给「用户手动展开」或「整轮最终块」（autoTranslate，见组件注释）——
  // holdOpen 撑开的中途块不自动翻，防一轮 N 段的翻译洪峰。
  const [showOriginal, setShowOriginal] = useState(false)
  const wantsTranslation = open && !streaming && looksEnglish(text) && (userToggled === true || autoTranslate)
  const translationState = useCheapNote(fetchThinkingTranslation, text, wantsTranslation)
  const translated = translationState.value

  if (!text) return <></>
  // 预览只在收起态渲染；展开时不算（原先流式期间每帧对**全文**跑一遍 \s+ 正则,
  // 纯浪费）。计算也只吃前 400 字——60 字预览用不到更多。
  const preview = open ? '' : (note ?? text.slice(0, 400).replace(/\s+/g, ' ').trim().slice(0, 60))
  const bodyText = translated && !showOriginal ? translated : text
  return (
    // 完全裸排版（Codex 风）：无框无竖条无底，唯一的动态信号是流式时
    // 标题的紫黄流光（flow-text）。.thinking-block 类名保留给 TRANSCRIPT_BAR_SELECTOR。
    <div className="thinking-block my-0 py-0.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserToggled(!open)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 text-left text-xs font-medium text-zinc-500 hover:text-zinc-400"
      >
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
          {/* 本轮计时已挪到对话区顶部的 TurnTimerStrip（2026-08-14 用户要求：
              钉住不动、贴左、数字换 Bahnschrift），标题行不再挂。 */}
        </span>
        {!open && (
          <span className="min-w-0 truncate font-normal text-zinc-600">{preview}</span>
        )}
      </button>
      {everOpened && (
        // 开合走 Collapse 原语（grid-rows 0fr↔1fr 高度动画 + 内容淡入淡出），
        // 收起不再瞬时消失（2026-08-14 用户：「收起来不要这么突兀，丝滑一点」）。
        <Collapse open={open}>
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
            {/* 流式期间纯文本（每帧重渲 markdown 不值）；收尾后走完整 markdown
                渲染（代码块/列表/标题都有，2026-08-18 用户：「思考里面的渲染做多
                一点」）——译文落地即渲染译文；翻译失败也照样渲染（bodyText 回退
                原文），不会因为没有译文就不渲。 */}
            {streaming ? bodyText : <MessageText>{bodyText}</MessageText>}
          </div>
        </Collapse>
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
  TodoList: { label: '更新待办', icon: 'todo', tone: 'todo' },
  todo_list: { label: '更新待办', icon: 'todo', tone: 'todo' },
  Skill: { label: '使用 Skill', icon: 'skill', tone: 'agent' },
  skill: { label: '使用 Skill', icon: 'skill', tone: 'agent' },
  ReadMediaFile: { label: '读取图片', icon: 'image', tone: 'read' },
  TaskStop: { label: '停止后台任务', icon: 'agent', tone: 'agent' },
  TaskList: { label: '查看后台任务', icon: 'agent', tone: 'agent' },
  TaskOutput: { label: '查看任务输出', icon: 'agent', tone: 'agent' },
  CronCreate: { label: '创建定时任务', icon: 'todo', tone: 'todo' },
  CronDelete: { label: '删除定时任务', icon: 'todo', tone: 'todo' },
  CronList: { label: '查看定时任务', icon: 'todo', tone: 'todo' },
  AskUserQuestion: { label: '向你提问', icon: 'ask', tone: 'ask' },
  CreateGoal: { label: '创建目标', icon: 'todo', tone: 'todo' },
  UpdateGoal: { label: '更新目标', icon: 'todo', tone: 'todo' }
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
/** MCP 工具（mcp__server__tool）在折叠摘要里的统一条目：全名太长（2026-08-17
 *  用户：「为什么这么长」），摘要么显示叶名要么大类——成组摘要里按大类收敛。 */
const MCP_ACTIVITY_META = { label: '使用 MCP 工具', icon: 'mcp', tone: 'web' }

function summarizeActivity(blocks: AssistantBlock[]): ActivitySegment[] {
  let thinking = 0
  // 按「展示 label」分桶而不是按工具全名：mcp__desktop__x / mcp__browser__y /
  // mcp__yuque__z 全名各不相同，曾各自成段——一行里出现三个「使用 MCP 工具」
  // （2026-08-20 用户截图）。patch/edit_file、Read/read_file 这类同义工具同理。
  const tools = new Map<string, { meta: { label: string; icon: string; tone: string }; count: number }>()
  for (const block of blocks) {
    if (block.kind === 'thinking') {
      thinking += 1
      continue
    }
    if (block.kind !== 'tool') continue
    // 未收录的工具也给兜底图标 + 中性灰微光（与单卡头部的 other 同一套）。
    const meta =
      TOOL_ACTIVITY_META[block.name] ??
      (block.name.startsWith('mcp__') ? MCP_ACTIVITY_META : { label: `使用了 ${block.name}`, icon: 'other', tone: 'think' })
    const bucket = tools.get(meta.label)
    if (bucket) bucket.count += 1
    else tools.set(meta.label, { meta, count: 1 })
  }
  const segments: ActivitySegment[] = []
  // 思考排最前：时间上它也确实发生在动作之前。2026-08：思考段也要图标 +
  // 微光（用户点名），只是色调比动作段更收敛（灰紫）。
  if (thinking > 0) segments.push({ kind: 'thinking', label: '思考', count: thinking, icon: 'think', tone: 'think' })
  for (const { meta, count } of tools.values()) {
    segments.push({
      kind: 'tool',
      label: meta.label,
      count,
      ...(meta.icon ? { icon: meta.icon } : {}),
      ...(meta.tone ? { tone: meta.tone } : {})
    })
  }
  return segments
}

/** 折叠摘要的一行渲染：每段「图标 + 淡色微光动作名 + 次数」，段间靠间距
 *  自然分开（2026-08：不要「·」——那玩意儿小到根本看不见还显脏）。
 *
 *  一排是硬约束（2026-08-20 用户：「以后这种一定放到一排」），三层保险：
 *  1. 段数上限 MAX_VISIBLE_SEGMENTS，超出的尾部收成一段「等 N 类」；
 *  2. flex-nowrap + 每段 shrink-0，物理上不允许换行；
 *  3. overflow-hidden 兜底——窗口太窄时宁可裁掉尾部，也不换行。 */
const MAX_VISIBLE_SEGMENTS = 8

function ActivitySummary({ segments }: { segments: ActivitySegment[] }): JSX.Element {
  const visible =
    segments.length > MAX_VISIBLE_SEGMENTS ? segments.slice(0, MAX_VISIBLE_SEGMENTS - 1) : segments
  const hidden = segments.length - visible.length
  return (
    <span className="flex min-w-0 shrink-0 flex-nowrap items-center gap-x-2.5 overflow-hidden whitespace-nowrap">
      {visible.map((seg) => (
        <span key={`${seg.kind}-${seg.label}`} className="inline-flex shrink-0 items-center gap-1">
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
      {hidden > 0 && (
        <span className="shrink-0 text-[10px] text-zinc-600">等 {hidden} 类</span>
      )}
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
    <div className="my-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit max-w-full cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-lg bg-white/[0.03] px-2 py-1 text-left text-xs text-zinc-500 transition hover:bg-white/[0.055] hover:text-zinc-400"
      >
        <ActivitySummary segments={summarizeActivity(entries.map((e) => e.block))} />
      </button>
      {open && entries.map((entry) => <div key={entry.index} className="py-1.5">{renderBlock(entry)}</div>)}
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
/** 模块级常量，保证 useCheapNote 依赖稳定（每次渲染新建会反复触发 effect）。 */
const fetchGroupNote = (sample: string): Promise<string | null> =>
  window.api.summarizeActivityGroup(sample)

/** 集合行整组总结的输入样本：思考取首句、工具取中文动作 + 规则摘要，截 800 字。 */
function activityGroupSampleOf(blocks: AssistantBlock[]): string {
  const lines: string[] = []
  for (const b of blocks) {
    if (!b) continue
    if (b.kind === 'thinking') {
      const head = b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
      if (head) lines.push(`思考: ${head}`)
    } else if (b.kind === 'tool') {
      const label = TOOL_ACTIVITY_META[b.name]?.label ?? b.name
      lines.push(`${label}: ${summaryForTool(b.name, b.input).slice(0, 80)}`)
    }
    if (lines.join('\n').length > 800) break
  }
  return lines.join('\n').slice(0, 800)
}

/**
 * 整组总结的悬停全文气泡（2026-08-24：总结预算放宽到 60 字，一行可能放不下——
 * 截断交给 CSS 省略号，全文悬停查看，同次用户拍板）。外层按钮 overflow-hidden
 * 会裁掉绝对定位子元素，气泡走 portal 挂到 body（同 ImageContextMenu 的套路）。
 */
function GroupNoteText({ note }: { note: string }): JSX.Element {
  const [tip, setTip] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const [shown, setShown] = useState(false)

  const hide = (): void => {
    setTip(null)
    setShown(false)
  }

  const show = (event: MouseEvent<HTMLSpanElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    // 默认放上方（bottom 锚定，不用量气泡高度）；上方贴顶不够 72px 才翻到下边。
    const below = rect.top < 72
    // max-w-md = 448px，左边往屏内 clamp 一档防出屏。
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 456))
    setTip({ left, top: below ? rect.bottom + 6 : rect.top - 6, below })
  }

  // 挂载后下一帧再转正透明度/位移，做出 ~120ms 淡入。
  useEffect(() => {
    if (!tip) return
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [tip])

  // 滚动（捕获阶段，虚拟列表自己的滚动容器也接得到）时收起；卸载随 effect 清理。
  useEffect(() => {
    if (!tip) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [tip])

  return (
    <span className="ml-1 min-w-0 truncate text-zinc-600" onMouseEnter={show} onMouseLeave={hide}>
      · {note}
      {tip &&
        createPortal(
          <div
            className={`pointer-events-none fixed z-[100] max-w-md whitespace-normal rounded-lg border border-white/10 bg-zinc-900/95 px-2.5 py-1.5 text-xs text-zinc-300 shadow-xl backdrop-blur transition duration-[120ms] ease-out ${
              shown ? 'translate-y-0 opacity-100' : `opacity-0 ${tip.below ? '-translate-y-1' : 'translate-y-1'}`
            }`}
            style={
              tip.below
                ? { left: tip.left, top: tip.top }
                : { left: tip.left, bottom: window.innerHeight - tip.top }
            }
          >
            {note}
          </div>,
          document.body
        )}
    </span>
  )
}

const ActivityGroupCard = memo(function ActivityGroupCard({
  blocks,
  forceOpen = false,
  expandedBlockKey = null,
  live = false
}: {
  blocks: AssistantBlock[]
  forceOpen?: boolean
  expandedBlockKey?: string | null
  /** 组还在流式生长：整组总结等收尾（live=false）后再问，省得每长一块重打一发。 */
  live?: boolean
}): JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? forceOpen
  // 与 ThinkingBlock 同款懒挂载：收起态不渲染整组卡片，第一次展开后常驻，
  // 之后开合走 Collapse 高度动画（2026-08-14 用户：收起要丝滑）。
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
  // 整组 AI 总结（2026-08-18 用户：「这整个块有总结」）：跟在计数后面。
  const groupSample = activityGroupSampleOf(blocks)
  const groupNote = useCheapNote(fetchGroupNote, groupSample, !live && groupSample.length > 0).value
  return (
    <div className="my-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserToggled(!open)}
        className="flex w-fit max-w-full cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-lg bg-white/[0.03] px-2 py-1 text-left text-xs text-zinc-500 transition hover:bg-white/[0.055] hover:text-zinc-400"
      >
        <ActivitySummary segments={summarizeActivity(blocks)} />
        {/* AI 整组总结跟在计数后面，但优先级最低：pill 段 shrink-0 保住完整，
            空间不够时这句先截断（min-w-0 + truncate），绝不能把 pill 挤换行。 */}
        {groupNote && <GroupNoteText note={groupNote} />}
      </button>
      {everOpened && (
        <Collapse open={open}>
          {blocks.map((block, i) => (
            // 组内展开也走 12px 行节奏（2026-08-18 用户：「历史消息间隔怎么
            // 这么小」——组内块原先裸排挤在一起）。
            <div key={i} className="py-1.5">
              {block.kind === 'thinking' ? (
                <ThinkingBlock text={block.text} streaming={false} />
              ) : block.kind === 'tool' ? (
                <ToolCallCard block={block} forceExpanded={expandedBlockKey === block.toolUseId} />
              ) : null}
            </div>
          ))}
        </Collapse>
      )}
    </div>
  )
})

const AssistantMessage = memo(function AssistantMessage({
  item,
  depth,
  deferHighlight = false,
  expandedBlockKey = null,
  holdOpen = false,
  turnKey,
  turnMarkdown
}: {
  item: AssistantItem
  depth: number
  deferHighlight?: boolean
  /** "最新块"的 key（toolUseId 或 `${item.id}:thinking`），该块保持展开。 */
  expandedBlockKey?: string | null
  /** turn 进行中且本条是本轮 live 消息：消息内不做成组折叠（等整轮结束）；
   *  单个卡片的完成即收起不受影响（2026-08-14 用户澄清的两层语义）。 */
  holdOpen?: boolean
  /** 本条所属轮的标识（本轮首条 AI 消息 id）：打在消息根节点 data-turn-id 上，
   *  整轮复制的富文本按它捞本轮全部 .prose-forge（2026-08-24 起复制按轮聚合）。 */
  turnKey?: string
  /** 整轮聚合的 Markdown 源文：只在本轮最后一条 AI 消息上有值（复制图标也只
   *  挂在这条上）；中间消息不传、整轮无正文时为空。 */
  turnMarkdown?: string
}): JSX.Element {
  const isStreaming = !!item.streaming
  const at = messageTime(item.id)

  return (
    <div data-turn-id={turnKey} className={`group/msg relative ${depth === 0 ? 'tran-ai-col' : ''}`}>
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
                  autoTranslate={!holdOpen && expandedBlockKey === `${item.id}:thinking`}
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

        // holdOpen（本轮 live + turn 在跑）：延迟的只是「成组折叠」这一层
        // （消息内 run 折叠 + 跨消息组都等整轮结束）；单个命令卡完成照样收起
        // （2026-08-14 用户澄清两层语义）。
        if (isStreaming || holdOpen) return entries.map(renderBlock)

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
      {/* 悬停复制（2026-08-24 起按轮）：一轮 AI 输出只在最后一条消息上挂一组
          图标，复制的是整轮聚合（turnMarkdown 由 Transcript 拼好，仅轮末消息
          有值——中间消息和整轮无正文的轮次都不显示）。显隐机制与时间戳相同。 */}
      {!isStreaming && depth === 0 && turnMarkdown && (
        <MessageCopyControls placement="assistant" text={turnMarkdown} turnKey={turnKey} />
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
  /** 已消费的历史注水事件号（与 sessionStore.historyPrependSeq 对齐）。 */
  const consumedPrependSeqRef = useRef(0)
  /** 上一帧的显示行数：锚点全灭时退回行数净增量（见下方补偿段注释）。 */
  const prevDisplayRowCountRef = useRef(0)
  /** 上一帧头部若干行的 key：prepend 补偿的锚点（行数 = 后移量，精确到行）。 */
  const prevHeadRowKeysRef = useRef<string[]>([])
  const prevSessionKeyRef = useRef(sessionKey)
  /** #45 附件持久化分桶键：sdkSessionId 重启 resume 后稳定（bridge id 每次都变）。 */
  const attachmentKey = useSessionStore((s) => s.meta?.sdkSessionId ?? s.meta?.sessionId ?? '')
  const agentBackend = useSessionStore((s) => s.meta?.agentBackend)
  const starting = useSessionStore((s) => s.starting)
  // running / compacting 已下沉到 TranscriptFooter 自订阅：主组件不再因它们
  // 变化而重渲染（每个 turn 起止都会触发一次全列表重渲染）。
  // 例外（2026-08-14）：turnRunning 回到主组件——折叠节奏改为「整轮输出完再
  // 一次性折叠」需要它（见 buildDisplayRows 的 holdLiveOpen）。turn 起止各一次
  // 重渲染，可接受。
  const turnRunning = useSessionStore((s) => s.status.running)
  const setTranscriptScrolling = useSessionStore((s) => s.setTranscriptScrolling)
  const setHistoryPreloadZone = useSessionStore((s) => s.setHistoryPreloadZone)
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
  /** #48 视口内可见的导航条目 id 集合。Codex 高亮的是**一整段**（用
   *  IntersectionObserver 求首个到最后一个可见回合的连续区间），不是单条——
   *  一屏能看到三条消息时就该亮三格。 */
  const [activeUserNavIds, setActiveUserNavIds] = useState<ReadonlySet<string>>(EMPTY_NAV_IDS)
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
   * 整轮复制的轮信息（2026-08-24 用户反馈：一轮被工具卡拆成多条 AI 消息，
   * 每条下面都挂复制图标太吵——一轮只留一个入口）。轮边界口径与
   * buildDisplayRows 一致：顶层连续的 assistant 消息算一轮，用户发言 /
   * 压缩分隔 / 轮末改动卡等任何非 assistant 根节点都收掉上一轮；隐藏信封
   * （system-reminder 等）在视觉上不存在，不打断轮。
   * key = AI 消息 id；value.turnKey = 本轮首条消息 id（DOM 上 data-turn-id
   * 的依据）；value.turnMarkdown = 整轮聚合的 MD 源文，只登记在本轮最后一
   * 条消息上（有值 = 该挂复制图标），整轮无正文则一轮都没有。
   */
  const turnCopyByItemId = useMemo(() => {
    const map = new Map<string, { turnKey: string; turnMarkdown?: string }>()
    let turn: AssistantItem[] = []
    const flushTurn = (): void => {
      if (turn.length === 0) return
      const turnKey = turn[0].id
      // 整轮 MD 源文：各消息的正文块各自 \n\n 拼接（blocks 流式期间有空洞，
      // 先 !!b 过滤），消息之间同样 \n\n；空消息不占分段。
      const turnMarkdown = turn
        .map((item) =>
          item.blocks
            .filter((b): b is TextBlock => !!b && b.kind === 'text')
            .map((b) => b.text)
            .join('\n\n')
        )
        .filter((s) => s.trim())
        .join('\n\n')
      for (const item of turn) map.set(item.id, { turnKey })
      if (turnMarkdown) map.set(turn[turn.length - 1].id, { turnKey, turnMarkdown })
      turn = []
    }
    for (const node of roots) {
      if (isHiddenEnvelope(node)) continue
      if (node.item.kind === 'assistant') {
        turn.push(node.item as AssistantItem)
        continue
      }
      flushTurn()
    }
    flushTurn()
    return map
  }, [roots])
  /**
   * 折叠决策的 sticky 记忆（2026-08 滚动稳定）：历史/已结束轮的组第一次出现时，
   * 用户**在底部**才折成摘要行；在上翻阅读时出现的组保持展开——布局绝不在用户
   * 脚下变化。一旦定了就不再翻转（已经折的组不因为你上翻而重新展开，反之亦然），
   * 换会话时清空（见下面 useMemo 里的 prevSessionKeyRef 分支）。
   *
   * 例外一（2026-08-17 用户：「对话都结束了还不会把这些 bar 收起来」）：成组
   * 被 holdLiveOpen 推迟到轮末之后，"是否在底部"的判定落在轮末瞬间——跟随
   * 钉底时 atBottom 可能是 false（增长不补滚的中间态），整轮就此永久摊开。
   * 所以**轮刚结束时新成的组一律折**，sticky 只约束轮次中途冒出的组。
   *
   * 例外二（2026-08-26 用户：「已经输出了好几句了，思考工具这些还没折起来？」）：
   * **进行中的这轮（isLiveSegment）一律折**，不问 atBottom。原规则的动机是
   * 「上翻阅读时上方冒出新组、折叠拽动阅读位置」——该场景现由注水龙头兜住
   * （'mid' 阅读区/滚动中暂停注水，sessionStore scheduleHistoryHydrationStep），
   * 而 live 轮的折叠发生在转录底部：用户上翻阅读时它在视口**之下**，高度变化
   * 不影响阅读位置；用户在底部看流式时折叠正是 v1.1.21 起就要的「边输出边折」。
   * 此前轮起步时未钉住（悬停 bar #8b 解钉后 steer/队列自动起轮）整轮摊开到轮末。
   */
  const foldDecisionsRef = useRef(new Map<string, boolean>())
  const prevTurnRunningRef = useRef(false)
  /**
   * 历史渐进注水会往 items **头部**插入旧消息（每次 50 条）。虚拟列表默认按
   * 下标定位，头部多出 N 条 = 当前可视内容整体往下推 N 条的高度——表现就是
   * 「往上滚、一停住、内容自己往下跳一大截」。触发链路：滚动时注水暂停，
   * `setTranscriptScrolling(false)` 一到就立刻续上并 set 一批到最前面。
   *
   * Virtuoso 对这个场景的正解是 `firstItemIndex`：取一个大基数，每次头部插入
   * 就把它减去插入条数，Virtuoso 据此把视觉位置钉住不动。
   *
   * 补偿单位是**显示行**（firstItemIndex 以 displayRows 计），store 只能按条目
   * 计数——条目→行不是 1:1（toolGroup/activityGroup 多并一、噪音信封整条丢弃、
   * 折叠段被注水向前延伸后组行不变但块变多）。store 每实际前置一批就 bump
   * `historyPrependSeq` 作触发信号；行数在这里精确量：上一帧**头部 8 行的 key**
   * 在新数组里集体后移，后移量（新下标 − 旧下标）即头部插入的显示行数。只认
   * 头部锚点，prepend 同帧的尾部流式追加/轮末折叠不会混进计数（2026-08-26 前
   * 用 rows.length 净增量，同帧其它变化会一并算入、firstItemIndex 错位 = 内容
   * 整片平移 k 行）。key 的跨帧稳定性由 2026-08-25 的组 id 锚点修复保证（组 id
   * 锚在收段正文消息上，注水向前延伸不再换 id）。锚点全灭（头部行同帧被折没，
   * 理论边界）才退回行数净增量。
   *
   * 注意：即使行数补偿精确，Virtuoso 仍按**估计行高**换算像素，每批前置的估计
   * 误差都会体现为视口偏移——所以阅读区干脆不注水（见 publishHistoryPreloadZone
   * 的 'mid' 暂停，2026-08-26「所滚即所得」）。
   */
  const { displayRows, firstItemIndex } = useMemo(() => {
    const turnJustEnded = prevTurnRunningRef.current && !turnRunning
    prevTurnRunningRef.current = turnRunning
    const foldDecisionFor = (groupKey: string, inheritFrom?: string | null, forceFold = false): boolean => {
      const map = foldDecisionsRef.current
      // 轮刚结束一律折（覆盖轮中"上翻不折"的决定）——「轮末收齐」优先于滚动
      // 稳定；且段完即折后组键在轮中就可能已登记，不覆盖会永远摊开。
      // forceFold（2026-08-26）：进行中的这轮一律折，见上方 sticky 注释例外二。
      if (turnJustEnded || forceFold) {
        map.set(groupKey, true)
        return true
      }
      const existing = map.get(groupKey)
      if (existing !== undefined) return existing
      // 闭段换锚（2026-08-25）后新键没有登记：沿用该段开口尾段时期已登记的
      // 决策（见 buildDisplayRows 闭段决策继承注释），不重新按 atBottom 判定。
      if (inheritFrom) {
        const inherited = map.get(inheritFrom)
        if (inherited !== undefined) {
          map.set(groupKey, inherited)
          return inherited
        }
      }
      const decision = atBottomRef.current
      map.set(groupKey, decision)
      return decision
    }
    const rows = buildDisplayRows(roots, foldDecisionFor, turnRunning)
    // 换会话：整表重来，基数复位，别把上个会话的偏移带过来。
    if (prevSessionKeyRef.current !== sessionKey) {
      prevSessionKeyRef.current = sessionKey
      firstItemIndexRef.current = FIRST_ITEM_INDEX_BASE
      consumedPrependSeqRef.current = useSessionStore.getState().historyPrependSeq
      foldDecisionsRef.current.clear()
    }
    const prependSeq = useSessionStore.getState().historyPrependSeq
    if (prependSeq !== consumedPrependSeqRef.current) {
      // 头部锚点反推插入行数（精确到行，不受同帧尾部变化污染，见上方注释）。
      const anchors = prevHeadRowKeysRef.current
      let insertedAbove: number | null = null
      for (let k = 0; k < anchors.length; k++) {
        const idx = rows.findIndex((row) => rowKeyOf(row) === anchors[k])
        if (idx !== -1) {
          insertedAbove = idx - k
          break
        }
      }
      // 锚点全灭（理论边界）：退回行数净增量。
      if (insertedAbove === null) insertedAbove = rows.length - prevDisplayRowCountRef.current
      if (insertedAbove > 0) firstItemIndexRef.current -= insertedAbove
      consumedPrependSeqRef.current = prependSeq
    }
    prevDisplayRowCountRef.current = rows.length
    prevHeadRowKeysRef.current = rows.slice(0, PREPEND_ANCHOR_ROW_COUNT).map(rowKeyOf)
    return { displayRows: rows, firstItemIndex: firstItemIndexRef.current }
  }, [roots, sessionKey, turnRunning])
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
      // 悬停卡片的第二段：这一轮 AI 回复的开头。Codex 的卡片就是「用户这句话
      // + 回复前三行」，只看自己说过什么其实认不出是哪一轮。
      let preview: string | undefined
      for (let i = rowIndex + 1; i < displayRows.length; i++) {
        const next = displayRows[i]
        // itemText（轮级折叠下只留文本的混合消息）同样是回复文本的来源。
        if (next.kind !== 'item' && next.kind !== 'itemText') continue
        const nextItem = next.node.item
        if (nextItem.kind === 'user') break
        if (nextItem.kind !== 'assistant') continue
        // blocks 里可能有空洞（流式期间先占位、后填充），全文件其它地方都先
        // `!!b` 过一道再用。这里漏了这一步，Claude Code 会话一开就整片
        // Transcript 崩掉（v1.0.91 引入，后台跑真机流程时抓到）。
        const text = (nextItem.blocks ?? [])
          .filter((b): b is Extract<AssistantBlock, { kind: 'text' }> => !!b && b.kind === 'text')
          .map((b) => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (text) {
          preview = text.slice(0, USER_NAV_PREVIEW_CHARS)
          break
        }
      }
      entries.push({ id: item.id, rowIndex, summary, ...(preview ? { preview } : {}) })
    })
    // 不截断：长会话里旧消息同样要能定位。之前只留最近 30 条，聊到一百轮之后
    // 前面的全都点不到了。刻度列自己会滚（max-h + overflow-y-auto，Codex 同款），
    // 每节 10px，几百条也就是列内滚动的事。
    return entries
  }, [displayRows])
  // "最新块"保持展开：最新一条 live（非历史）assistant 消息里的最后一个思考/
  // 工具块。纯文本段落开头的消息 → 无最新块（上一个收起）；最新是历史 → 不收。
  // 2026-08-14：只在 turn 运行中生效——turn 一结束回 null，本轮活动块整体折起
  // （用户：「就整个折叠块都输出完再折叠」；此前 lastExpandableKey 在收尾后仍
  // 指着最后一块，于是"输出完又展开"）。
  const lastExpandableKey = useMemo(() => {
    if (!turnRunning) return null
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
  }, [items, turnRunning])
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
    // 钉住状态是注水龙头的 bottom 判定来源，翻转即上报。
    publishHistoryPreloadZone()
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
  const jumpToUserMessage = (entry: UserNavEntry, behavior: 'smooth' | 'auto'): void => {
    lockFollowOutput()
    markScrollIntent()
    setPinnedAtBottom(false)
    // react-virtuoso 在这两处用的**不是同一套下标**（4.18.7 实测）：
    //   · rangeChanged 上报的是含 firstItemIndex 基数的**绝对**下标；
    //   · scrollToIndex 收的却是 data 数组里的**相对**下标。
    // 之前两边都按绝对算，于是传进去的是 100 万级的数字，Virtuoso 一律 clamp
    // 到末项 —— 表现就是「点导航条永远跳到底部」，也就是点了跟没点一样。
    // 这个 bug 从导航条第一版就在，静态看代码看不出来，是后台真机点出来的。
    const absoluteIndex = firstItemIndexRef.current + entry.rowIndex
    const distance = Math.abs(absoluteIndex - lastRenderedRangeRef.current.startIndex)
    virtuosoRef.current?.scrollToIndex({
      index: entry.rowIndex,
      align: 'start',
      // 长距 smooth 会边滚边补渲染重测高，卡在半途并持续闪；拖动刷条时调用方
      // 直接要 auto（smooth 排队补间跟不上手）。
      behavior: behavior === 'auto' || distance > USER_NAV_SMOOTH_MAX_ROWS ? 'auto' : 'smooth'
    })
    flashUserMessage(entry.id)
  }

  /** 跳转后让目标气泡闪一下（Codex 同款：底色亮起 → 停住 → 淡出）。没有这一下，
   *  长回合里跳过去只看到一片文字，认不出落点在哪。 */
  const flashUserMessage = (itemId: string): void => {
    window.requestAnimationFrame(() => {
      const host = scrollElement?.querySelector<HTMLElement>(
        `[data-user-msg-id="${CSS.escape(itemId)}"]`
      )
      const bubble = host?.querySelector<HTMLElement>('.tran-user-bubble') ?? host
      // Codex 闪的是气泡底色，但 Tran 的气泡本身铺着渐变（background-image
      // 盖在 background-color 上面），改底色根本看不见——改成描一圈光晕。
      bubble?.animate?.(
        [
          { boxShadow: USER_NAV_FLASH_FROM },
          { boxShadow: USER_NAV_FLASH_FROM, offset: 0.35 },
          { boxShadow: USER_NAV_FLASH_TO }
        ],
        { duration: 1400, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
      )
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

  /** 注水龙头上报（2026-08-26「所滚即所得」）：钉底 = bottom（followOutput
   *  兜底，前置扰动不可见）；非钉底时按渲染范围首行距已加载顶部的行数分
   *  edge（要续注了）/ mid（阅读区，暂停注水——阅读区前置的估计行高调校
   *  就是停手后持续漂移的来源）。startIndex 含顶部 overscan，edge 阈值实际
   *  更宽，偏保守（宁早勿晚）。store 侧同值短路，滚动期逐帧调用无妨。 */
  const publishHistoryPreloadZone = (): void => {
    if (atBottomRef.current) {
      setHistoryPreloadZone('bottom')
      return
    }
    const relStart = lastRenderedRangeRef.current.startIndex - firstItemIndexRef.current
    setHistoryPreloadZone(relStart < HISTORY_PRELOAD_EDGE_ROWS ? 'edge' : 'mid')
  }

  const cancelNavHighlightFrame = (): void => {
    if (navHighlightFrameRef.current !== null) {
      window.cancelAnimationFrame(navHighlightFrameRef.current)
      navHighlightFrameRef.current = null
    }
  }

  /**
   * 高亮「视口里能看到的那一段」——从视口顶上方最近的一条用户消息，到视口
   * 底部之前的最后一条，取连续区间（对齐 Codex：它用 IntersectionObserver
   * 求首个/最后一个可见回合，再把中间整段标成 aria-current）。
   *
   * 旧实现只算单条。一屏里明明看得到三条消息，导航条却只亮一格，跟眼睛看到
   * 的对不上。
   */
  const updateActiveUserNav = (): void => {
    const entries = userNavEntriesRef.current
    if (entries.length === 0) {
      setActiveUserNavIds((current) => (current.size === 0 ? current : EMPTY_NAV_IDS))
      return
    }
    if (!scrollElement) return
    const indexOf = new Map(entries.map((entry, i) => [entry.id, i]))
    const rect = scrollElement.getBoundingClientRect()
    const viewTop = rect.top + USER_NAV_TOP_SLACK_PX
    const viewBottom = rect.bottom
    let first = -1
    let last = -1
    for (const node of scrollElement.querySelectorAll<HTMLElement>('[data-user-msg-id]')) {
      const id = node.dataset.userMsgId
      if (id === undefined) continue
      const i = indexOf.get(id)
      if (i === undefined) continue
      const box = node.getBoundingClientRect()
      // 顶在视口上方的：一路记成 first（回合本身跨越视口顶，仍算"在看"）。
      if (box.top <= viewTop) {
        first = i
        if (box.bottom > viewTop) last = Math.max(last, i)
        continue
      }
      if (box.top < viewBottom) {
        if (first === -1) first = i
        last = Math.max(last, i)
      }
    }
    // 贴底特判：底部时最新一条完整露在视口中，纯几何会少算一格。
    const distanceFromBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight
    if (distanceFromBottom <= FOLLOW_RESUME_AT_BOTTOM_THRESHOLD_PX) last = entries.length - 1
    if (first === -1) first = 0
    if (last < first) last = first
    const next = new Set<string>()
    for (let i = first; i <= last; i++) {
      const entry = entries[i]
      if (entry) next.add(entry.id)
    }
    setActiveUserNavIds((current) =>
      current.size === next.size && [...current].every((id) => next.has(id)) ? current : next
    )
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
    publishHistoryPreloadZone()
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
        // 2026-08 再修：不补滚。展开/自动收起造成的增长不该挪动用户的视图
        // （补滚就是"展开思考往上展开"的体感来源）；跟随由 followOutput 在
        // 下一次内容变化时自己接上。
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
    setActiveUserNavIds(EMPTY_NAV_IDS)
    setDeferHighlight(true)
    resumeHighlightAfter(INITIAL_HIGHLIGHT_DELAY_MS)

    return () => {
      clearHighlightTimer()
      clearScrollIntentTimer()
      setTranscriptScrolling(false)
      // 水龙头复位：换会话/卸载后别把一个 'mid' 留给下个会话（会冻结注水）。
      setHistoryPreloadZone('bottom')
    }
  }, [sessionKey, setTranscriptScrolling, setHistoryPreloadZone])

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
            live={row.live}
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
    if (row.kind === 'itemText') {
      // 轮级折叠下的混合消息：活动块已进集合组，这里只渲染文本（过滤结果
      // 走 WeakMap 缓存，item 引用不变就不破坏 memo）。
      const turnCopy = turnCopyByItemId.get(row.node.item.id)
      return (
        <AssistantMessage
          item={textOnlyItemOf(row.node.item as AssistantItem)}
          depth={0}
          deferHighlight={deferHighlight}
          turnKey={turnCopy?.turnKey}
          turnMarkdown={turnCopy?.turnMarkdown}
        />
      )
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
          onReview={(path) => openChangesPanel(path)}
        />
      )
    }
    return (
      <AssistantMessage
        item={row.node.item as AssistantItem}
        depth={0}
        deferHighlight={deferHighlight}
        expandedBlockKey={lastExpandableKey}
        holdOpen={turnRunning && !row.node.item.isHistory}
        turnKey={turnCopyByItemId.get(row.node.item.id)?.turnKey}
        turnMarkdown={turnCopyByItemId.get(row.node.item.id)?.turnMarkdown}
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
          // 行距统一（2026-08-17 用户：「间距不固定不稳定」）：不再给裸活动行
          // 单独开小灶（py-0.5 与 py-1.5 混排就是时松时紧的根源），节奏全由
          // 这里一处说了算；卡片自身的外边距已清零。
          // 取值史：8px 嫌紧 → py-1.5(12px)；2026-08-18 用户觉得 12px 仍偏大，
          // 但拍板"先不要改"——维持 12px 不动。
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
      <UserMessageNav entries={userNavEntries} activeIds={activeUserNavIds} onJump={jumpToUserMessage} />
      {/* 回到最新：底部居中（Codex 风，2026-08 用户点名）。输出中箭头挂
          紫黄流光（动态=正在干活），非输出静态箭头。按钮带 data-follow-no-lock：
          点它不吃 pointerdown 的跟随锁，否则流式期间永远差一截到不了底。 */}
      {!layoutTransitioning && showLatest && (
        <LatestButton onJump={pinToBottom} />
      )}
    </div>
  )
}
