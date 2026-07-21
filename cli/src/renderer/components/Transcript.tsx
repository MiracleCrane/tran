import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { AssistantBlock, AssistantItem, UserItem, TranscriptItem, ItemNode, ToolBlock } from '../types'
import MessageText from './MessageText'
import ToolCallCard from './ToolCallCard'
import ToolGroupCard from './ToolGroupCard'

const INITIAL_HIGHLIGHT_DELAY_MS = 420
const SCROLL_HIGHLIGHT_RESUME_MS = 180
const SCROLL_INTENT_IDLE_MS = 220
const FOLLOW_OUTPUT_LOCK_MS = 1200
const TOPBAR_RESERVE_NEAR_BOTTOM_THRESHOLD_PX = 120

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

/** 顶层渲染行：普通消息节点，或"连续相邻的纯工具调用消息"聚成的分组块
 *  （纯渲染层聚合，不改后端事件；单个工具调用仍按普通消息渲染）。 */
type DisplayRow =
  | { kind: 'item'; node: ItemNode }
  | { kind: 'toolGroup'; id: string; blocks: ToolBlock[] }

/** 该节点是否"整条消息只有工具调用块"（可聚合）。 */
function toolBlocksOf(node: ItemNode): ToolBlock[] | null {
  const item = node.item
  if (item.kind !== 'assistant' || item.error || item.blocks.length === 0) return null
  if (!item.blocks.every((b): b is ToolBlock => !!b && b.kind === 'tool')) return null
  return item.blocks as ToolBlock[]
}

function buildDisplayRows(roots: ItemNode[]): DisplayRow[] {
  const rows: DisplayRow[] = []
  let run: { node: ItemNode; blocks: ToolBlock[] }[] = []
  const flush = (): void => {
    if (run.length >= 2) {
      rows.push({
        kind: 'toolGroup',
        id: `tool-group-${run[0].blocks[0].toolUseId}`,
        blocks: run.flatMap((r) => r.blocks)
      })
    } else {
      for (const r of run) rows.push({ kind: 'item', node: r.node })
    }
    run = []
  }
  for (const node of roots) {
    const blocks = toolBlocksOf(node)
    if (blocks) run.push({ node, blocks })
    else {
      flush()
      rows.push({ kind: 'item', node })
    }
  }
  flush()
  return rows
}

/** Memoized on `item`. With stream-batched updates only the streaming item
 *  gets a new reference each frame, so finished user messages never re-render
 *  when the transcript re-renders during a sibling's stream. The `backdrop-blur`
 *  that used to be here was removed — it stacked a backdrop-filter surface per
 *  message (cost grew with message count) for a barely-visible effect over the
 *  already-frosted shell. */
const UserMessage = memo(function UserMessage({ item }: { item: UserItem }): JSX.Element {
  const atts = item.attachments ?? []
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const openAttachmentPreview = useUiStore((s) => s.openAttachmentPreview)
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
        {item.swarm && (
          <div className="mb-1 flex justify-end">
            <span
              className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent"
              title="该条发送时注入了 Swarm 并行指令前缀"
            >
              Swarm
            </span>
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
                  className="rounded-lg outline-none ring-accent/50 transition hover:brightness-110 focus-visible:ring-2"
                  title={`预览 ${a.name}`}
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
    </div>
  )
})

const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): JSX.Element {
  // 默认收起（一行摘要"思考过程 · N 字"）；流式生成期间自动展开，完成后收回；
  // 用户手动点击后以其选择为准。展开态定高 200px 内部滚动，不把布局顶来顶去。
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = userToggled ?? streaming
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
    <div className="thinking-block glass-panel-soft my-1.5 rounded-xl px-3 py-2">
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
        {streaming && <span className="stream-cursor-glow" />}
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
  deferHighlight = false
}: {
  item: AssistantItem
  depth: number
  deferHighlight?: boolean
}): JSX.Element {
  const isStreaming = !!item.streaming

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
            return (
              <div key={i} className={isStreaming ? 'stream-mask-edge' : undefined}>
                <MessageText highlight={highlight}>{block.text}</MessageText>
                {isStreaming && <span className="tran-stream-cursor" aria-hidden />}
              </div>
            )
          }
          if (block.kind === 'thinking') return <ThinkingBlock key={i} text={block.text} streaming={isStreaming} />
          return <ToolCallCard key={i} block={block} />
        })}
      {isStreaming && (
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
          <span className="stream-cursor-glow" />
          输出中…
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
  const reserveEligibleRef = useRef(true)
  /** 已渲染过的消息 id（Virtuoso 滚动复用行时不重播入场动画；新消息才入场）。 */
  const seenItemIdsRef = useRef<Set<string>>(new Set())
  // "stick to bottom": Virtuoso reports this via atBottomStateChange. While at
  // the bottom, followOutput pins to the newest content; scroll up to read and
  // it stops following until the ↓ button returns you.
  const [atBottom, setAtBottom] = useState(true)
  const [deferHighlight, setDeferHighlight] = useState(true)
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)

  const roots = useMemo(() => buildForest(items), [items])
  const displayRows = useMemo(() => buildDisplayRows(roots), [roots])
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

  const setReserveEligible = (eligible: boolean, force = false): void => {
    if (!force && reserveEligibleRef.current === eligible) return
    reserveEligibleRef.current = eligible
    onAtBottomChange?.(eligible)
  }

  const setPinnedAtBottom = (nextAtBottom: boolean): void => {
    atBottomRef.current = nextAtBottom
    setAtBottom(nextAtBottom)
  }

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
    }
  }, [])

  useEffect(() => {
    if (!scrollElement) return

    const updateReserveEligibility = (): void => {
      refreshReserveEligibleFromScroller(scrollElement)
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
    if (!isAtBottom) return false
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
    setReserveEligible(true, true)
    setPinnedAtBottom(true)
    setDeferHighlight(true)
    resumeHighlightAfter(INITIAL_HIGHLIGHT_DELAY_MS)

    return () => {
      clearHighlightTimer()
      clearScrollIntentTimer()
      setTranscriptScrolling(false)
    }
  }, [sessionKey, setTranscriptScrolling])

  if (items.length === 0) {
    return (
      <div className="transcript-scroll h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col items-center justify-center px-6 py-6 text-center">
          {starting ? (
            <>
              <div className="glass-panel mb-7 flex h-20 w-20 items-center justify-center rounded-[18px] text-zinc-100 shadow-[0_0_34px_rgba(94,168,255,0.18)]">
                <div className="h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
              </div>
              <h1 className="text-2xl font-semibold text-zinc-100">正在进入会话...</h1>
              <p className="mt-2 text-sm text-zinc-500">历史和运行环境会在后台接上。</p>
            </>
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
    if (row.kind === 'toolGroup') return <ToolGroupCard blocks={row.blocks} />
    if (row.node.item.kind === 'user') return <UserMessage item={row.node.item as UserItem} />
    return <AssistantMessage item={row.node.item as AssistantItem} depth={0} deferHighlight={deferHighlight} />
  }

  return (
    <div
      className="relative h-full"
      onPointerDownCapture={() => {
        lockFollowOutput()
        markScrollIntent()
      }}
      onWheelCapture={(event) => {
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
        itemContent={(index, row) => {
          // Per-row wrapper preserves the centered, padded column the old single
          // container provided; py-2 approximates the former gap-4 between rows.
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
          return (
            <div
              className={`mx-auto w-full max-w-5xl px-6 py-2 ${isNew ? 'tran-msg-enter' : ''}`}
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
        atBottomThreshold={2}
        atBottomStateChange={handleAtBottomStateChange}
        className="transcript-scroll h-full"
        components={{
          Footer: () => (
            <div className="mx-auto w-full max-w-5xl px-6 py-2">
              {compacting && <div className="text-center text-xs text-zinc-500">正在压缩上下文…</div>}
              {running && (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="stream-cursor-glow" />
                  Tran 正在处理…
                </div>
              )}
              {bottomReserve > 0 && <div aria-hidden="true" style={{ height: bottomReserve }} />}
            </div>
          )
        }}
      />
      {!layoutTransitioning && !atBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <button
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
            className="glass-control rounded-full px-3 py-1.5 text-xs text-zinc-300 shadow-lg hover:bg-white/[0.075]"
          >
            ↓ 最新
          </button>
        </div>
      )}
    </div>
  )
}
