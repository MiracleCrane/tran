import { memo, Profiler, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import { probeCommit, probeRender } from '../utils/streamProbe'
import type { AssistantBlock, AssistantItem, UserAttachment, UserItem, TranscriptItem, ItemNode, ToolBlock } from '../types'
import MessageText from './MessageText'
import { showImageContextMenu } from './ImageContextMenu'
import { formatMessageTime, messageTime } from '../utils/messageTimes'
import { initSentImageRecording, loadSentImages, matchHistoryImages } from '../utils/sentImages'
import ToolCallCard from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'
import CompactionDivider from './CompactionDivider'
import QueryResultCard from './QueryResultCard'
import UserMessageNav, { type UserNavEntry } from './UserMessageNav'

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
const USER_NAV_MAX_ENTRIES = 30
// #48/#50 高亮判定：用户消息行顶距视口顶多少 px 内算"视口顶部附近"。
const USER_NAV_TOP_SLACK_PX = 8
// #50 长距跳转（行数差超过该值）用 auto 一次到位——动态高度列表里 smooth
// 长跳会边滚边补渲染重测高，卡在半途并持续闪；短距保留 smooth 过渡感。
const USER_NAV_SMOOTH_MAX_ROWS = 40
/** #45 无历史附件时的共享空 Map（避免每次渲染新引用击穿 UserMessage memo）。 */
const EMPTY_HISTORY_ATTACHMENTS: ReadonlyMap<string, UserAttachment[]> = new Map()

interface TranscriptProps {
  layoutTransitioning?: boolean
  bottomReserve?: number
  bottomReserveVersion?: number
  onAtBottomChange?: (atBottom: boolean) => void
}

const TerminalGlyph = (): JSX.Element => (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
    <path
      d="M7 8l4 4-4 4M13 16h4"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

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
  | { kind: 'envelopeGroup'; id: string; entries: Array<{ id: string; text: string }> }

/** 该节点是否"整条消息只有工具调用块"（可聚合）。 */
function toolBlocksOf(node: ItemNode): ToolBlock[] | null {
  const item = node.item
  if (item.kind !== 'assistant' || item.error || item.blocks.length === 0) return null
  if (!item.blocks.every((b): b is ToolBlock => !!b && b.kind === 'tool')) return null
  return item.blocks as ToolBlock[]
}

/** 该节点是否系统信封（后台任务通知/cron/系统提醒等注入的 user 消息）。 */
function envelopeTextOf(node: ItemNode): string | null {
  const item = node.item
  if (item.kind !== 'user' || !item.text) return null
  return ENVELOPE_RE.test(item.text.trimStart()) ? item.text : null
}

function buildDisplayRows(roots: ItemNode[]): DisplayRow[] {
  const rows: DisplayRow[] = []
  let toolRun: { node: ItemNode; blocks: ToolBlock[] }[] = []
  let envelopeRun: ItemNode[] = []
  const flushTools = (): void => {
    if (toolRun.length >= 2) {
      rows.push({
        kind: 'toolGroup',
        id: `tool-group-${toolRun[0].blocks[0].toolUseId}`,
        blocks: toolRun.flatMap((r) => r.blocks)
      })
    } else {
      for (const r of toolRun) rows.push({ kind: 'item', node: r.node })
    }
    toolRun = []
  }
  const flushEnvelopes = (): void => {
    // 连续 ≥2 个信封才折叠；单个维持单张卡。组 id 取首条 id——live 期间新到
    // 的信封进尾部已有组时组 id 不变，展开状态和位置都不闪。
    if (envelopeRun.length >= 2) {
      rows.push({
        kind: 'envelopeGroup',
        id: `envelope-group-${envelopeRun[0].item.id}`,
        entries: envelopeRun.map((n) => ({ id: n.item.id, text: envelopeTextOf(n) ?? '' }))
      })
    } else {
      for (const n of envelopeRun) rows.push({ kind: 'item', node: n })
    }
    envelopeRun = []
  }
  for (const node of roots) {
    const blocks = toolBlocksOf(node)
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
/** kimi CLI 注入会话历史的系统信封（后台任务通知/cron/系统提醒等），
 *  重放时按原文会糊出一坨 XML——解析成克制的系统卡片。 */
const ENVELOPE_RE = /^<(notification|cron-fire|system-reminder|kimi-skill-loaded)[\s>]/

function SystemEnvelope({ text }: { text: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const title = /title="([^"]*)"/.exec(text)?.[1]
  const kind = /(completed|failed|lost)/.exec(text)?.[1]
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
    const kind = /(completed|failed|lost)/.exec(entry.text)?.[1]
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
  const openAttachmentPreview = useUiStore((s) => s.openAttachmentPreview)
  // kimi CLI 系统信封（后台任务通知等）：渲染成系统卡片而不是原始 XML 气泡
  if (item.text && ENVELOPE_RE.test(item.text.trimStart())) {
    return <SystemEnvelope text={item.text} />
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
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[16px] rounded-tr-md border border-white/10 bg-gradient-to-br from-accent/[0.14] via-white/[0.06] to-white/[0.03] px-4 py-2.5 shadow-lg shadow-black/10">
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
        {/* #43 轻量时间戳：常驻小号灰字；历史消息无事件时间，诚实缺省。 */}
        {at !== undefined && (
          <div className="mt-1 text-right text-[10px] leading-none text-zinc-600">
            {formatMessageTime(at)}
          </div>
        )}
      </div>
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

  // 流式期间内容自动滚到底部（跟随最新思考）。
  useEffect(() => {
    const body = bodyRef.current
    if (open && streaming && body) body.scrollTop = body.scrollHeight
  }, [text, open, streaming])

  if (!text) return <></>
  // 折叠态摘要：正文前 ~60 字符单行截断（流式期间随 text 实时更新）。
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 60)
  return (
    <div className="thinking-block glass-panel-soft my-1 rounded-xl px-3 py-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserToggled(!open)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 text-left text-xs font-medium text-zinc-500 hover:text-zinc-400"
      >
        <span className="shrink-0 text-[10px] text-zinc-600">{open ? '▾' : '▸'}</span>
        <span className="shrink-0">思考过程 · {text.length} 字</span>
        {!open && (
          <span className="min-w-0 truncate font-normal text-zinc-600">{preview}</span>
        )}
        {streaming && <span className="thinking-moon" aria-hidden />}
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="mt-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap pl-1.5 text-xs leading-relaxed text-zinc-500"
        >
          {text}
        </div>
      )}
    </div>
  )
})

/** Takes `item` (not the wrapping forest node) precisely so React.memo's shallow
 *  compare can short-circuit: the forest node is rebuilt every frame, but the
 *  underlying item keeps its reference when unchanged. */
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
    <div className={depth === 0 ? 'max-w-[92%]' : ''}>
      {item.error && (
        <div className="mb-2 rounded-lg border border-red-900/50 bg-red-950/20 px-3 py-1.5 text-xs text-red-300">
          {item.error}
        </div>
      )}
      {item.blocks
        .filter((b): b is AssistantBlock => !!b)
        .map((block, i) => {
          if (block.kind === 'text') {
            const highlight = !isStreaming && !deferHighlight
            const md = <MessageText highlight={highlight}>{block.text}</MessageText>
            return (
              <div key={i}>
                {/* #8 埋点：流式期间用 Profiler 记录该块每帧 React 渲染耗时
                    （mdMs），结束后回到普通渲染，零包裹开销。 */}
                {isStreaming ? (
                  <Profiler id={`stream-text-${item.id}:${i}`} onRender={probeRender}>
                    {md}
                  </Profiler>
                ) : (
                  md
                )}
                {isStreaming && <span className="tran-stream-cursor" aria-hidden />}
              </div>
            )
          }
          if (block.kind === 'thinking') {
            const think = (
              <ThinkingBlock
                text={block.text}
                streaming={isStreaming}
                forceExpanded={expandedBlockKey === `${item.id}:thinking`}
              />
            )
            return (
              <div key={i}>
                {/* #8 埋点：思考块同样在流式期间记录渲染耗时（thinkMs），
                    与正文块的 mdMs 对照。 */}
                {isStreaming ? (
                  <Profiler id={`stream-think-${item.id}:${i}`} onRender={probeRender}>
                    {think}
                  </Profiler>
                ) : (
                  think
                )}
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
        })}
      {isStreaming && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
          <span className="thinking-moon" aria-hidden />
          输出中…
        </div>
      )}
      {/* #43 轻量时间戳（流式结束后常驻；历史消息无事件时间，诚实缺省）。 */}
      {!isStreaming && at !== undefined && (
        <div className="mt-1 text-[10px] leading-none text-zinc-600">{formatMessageTime(at)}</div>
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
  /** #45 附件持久化分桶键：sdkSessionId 重启 resume 后稳定（bridge id 每次都变）。 */
  const attachmentKey = useSessionStore((s) => s.meta?.sdkSessionId ?? s.meta?.sessionId ?? '')
  const agentBackend = useSessionStore((s) => s.meta?.agentBackend)
  const running = useSessionStore((s) => s.status.running)
  const starting = useSessionStore((s) => s.starting)
  const compacting = useSessionStore((s) => s.status.compacting)
  const setTranscriptScrolling = useSessionStore((s) => s.setTranscriptScrolling)
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
  // "stick to bottom": Virtuoso reports this via atBottomStateChange. While at
  // the bottom, followOutput pins to the newest content; scroll up to read and
  // it stops following until the ↓ button returns you.
  const [atBottom, setAtBottom] = useState(true)
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
  const displayRows = useMemo(() => buildDisplayRows(roots), [roots])
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
    const distance = Math.abs(rowIndex - lastRenderedRangeRef.current.startIndex)
    virtuosoRef.current?.scrollToIndex({
      index: rowIndex,
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

  const handleAtBottomStateChange = (nextAtBottom: boolean): void => {
    if (nextAtBottom) setReserveEligible(true)
    if (layoutTransitioningRef.current) {
      if (!nextAtBottom) setPinnedAtBottom(false)
      return
    }
    setPinnedAtBottom(nextAtBottom)
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
    if (ENVELOPE_RE.test(last.text.trimStart())) return
    if (lastSendScrollItemIdRef.current === last.id) return
    lastSendScrollItemIdRef.current = last.id
    pinToBottom('auto')
  }, [items])

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
          <div className="glass-panel mb-7 flex h-20 w-20 items-center justify-center rounded-[18px] text-zinc-100 shadow-[0_0_34px_rgba(94,168,255,0.18)]">
            <TerminalGlyph />
          </div>
          <h1 className="text-brand-gradient text-2xl font-semibold">发送消息开始对话</h1>
          <p className="mt-2 text-sm text-zinc-500">我可以帮助你编写代码、分析问题、执行任务</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            {['列出文件', '总结项目', '查找代码', '修复问题'].map((label) => (
              <span key={label} className="glass-control rounded-xl px-4 py-2 text-sm text-zinc-300">
                {label}
              </span>
            ))}
          </div>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderRow = (row: DisplayRow): JSX.Element => {
    if (row.kind === 'toolGroup') {
      // 与 AssistantMessage 的 depth-0 容器同宽（max-w-[92%]），保证工具
      // 分组 bar 与思考/文本/单个工具 bar 等宽（#9）。
      return (
        <div className="max-w-[92%]">
          <ToolGroupCard
            blocks={row.blocks}
            forceOpen={row.blocks.some((b) => b.toolUseId === lastExpandableKey)}
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
        initialTopMostItemIndex={{ index: Math.max(displayRows.length - 1, 0), align: 'end' }}
        computeItemKey={(_, row) => (row.kind === 'item' ? row.node.item.id : row.id)}
        increaseViewportBy={scrollTuning.increaseViewportBy}
        overscan={scrollTuning.overscan}
        scrollerRef={(element) => {
          const nextElement = element instanceof HTMLElement ? element : null
          setScrollElement((current) => (current === nextElement ? current : nextElement))
        }}
        isScrolling={handleTranscriptScrolling}
        rangeChanged={handleRangeChanged}
        itemContent={(index, row) => {
          // Per-row wrapper preserves the centered, padded column the old single
          // container provided; py-1.5 keeps the block rhythm tight (#9, Kimi Web feel).
          // 入场动画只给"新到"的消息（seenItemIdsRef 去重，滚动复用不重播）；
          // 批量历史同帧挂载时 stagger 封顶 300ms。
          const rowKey = row.kind === 'item' ? row.node.item.id : row.id
          const isNew = !seenItemIdsRef.current.has(rowKey)
          if (isNew) seenItemIdsRef.current.add(rowKey)
          // 历史/实况分界：上一行是重放历史、当前行不是 → 加分隔小字。
          const prevRow = index > 0 ? displayRows[index - 1] : null
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
              style={isNew ? { animationDelay: `${Math.min(index * 24, 280)}ms` } : undefined}
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
        components={{
          Footer: () => (
            <div className="mx-auto w-full max-w-5xl px-6 py-2">
              {compacting && <div className="text-center text-xs text-zinc-500">正在压缩上下文…</div>}
              {running && (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="thinking-moon" aria-hidden />
                  Tran 正在处理…
                </div>
              )}
              {bottomReserve > 0 && <div aria-hidden="true" style={{ height: bottomReserve }} />}
            </div>
          )
        }}
      />
      <UserMessageNav entries={userNavEntries} activeId={activeUserNavId} onJump={jumpToUserMessage} />
      {!layoutTransitioning && !atBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <button
            onClick={() => pinToBottom('smooth')}
            className="glass-control rounded-full px-3 py-1.5 text-xs text-zinc-300 shadow-lg hover:bg-white/[0.075]"
          >
            ↓ 最新
          </button>
        </div>
      )}
    </div>
  )
}
