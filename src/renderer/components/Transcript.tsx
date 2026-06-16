import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { AssistantBlock, AssistantItem, UserItem, TranscriptItem, ItemNode } from '../types'
import MessageText from './MessageText'
import ToolCallCard from './ToolCallCard'

const INITIAL_HIGHLIGHT_DELAY_MS = 420
const SCROLL_HIGHLIGHT_RESUME_MS = 180
const FOLLOW_OUTPUT_LOCK_MS = 1200

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
      <div className="max-w-[85%] rounded-[16px] rounded-tr-md border border-white/10 bg-white/[0.07] px-4 py-2.5 shadow-lg shadow-black/10">
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

const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }): JSX.Element {
  if (!text) return <></>
  return (
    <details open className="glass-panel-soft my-1.5 rounded-xl px-3 py-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-400">
        思考过程
      </summary>
      <div className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-500">
        {text}
      </div>
    </details>
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
          // `highlight={!item.streaming}`: skip syntax highlighting while the
          // message is still streaming (the expensive stage), apply it once on
          // the final render when streaming flips false.
          if (block.kind === 'text')
            return <MessageText key={i} highlight={!item.streaming && !deferHighlight}>{block.text}</MessageText>
          if (block.kind === 'thinking') return <ThinkingBlock key={i} text={block.text} />
          return <ToolCallCard key={i} block={block} />
        })}
      {item.streaming && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-600">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          输出中…
        </div>
      )}
    </div>
  )
})

export default function Transcript(): JSX.Element {
  const items = useSessionStore((s) => s.items)
  const sessionKey = useSessionStore((s) => s.meta?.sessionId ?? '')
  const running = useSessionStore((s) => s.status.running)
  const compacting = useSessionStore((s) => s.status.compacting)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const highlightTimeoutRef = useRef<number | null>(null)
  const deferHighlightRef = useRef(true)
  const followOutputLockedUntilRef = useRef(0)
  // "stick to bottom": Virtuoso reports this via atBottomStateChange. While at
  // the bottom, followOutput pins to the newest content; scroll up to read and
  // it stops following until the ↓ button returns you.
  const [atBottom, setAtBottom] = useState(true)
  const [deferHighlight, setDeferHighlight] = useState(true)

  const roots = useMemo(() => buildForest(items), [items])

  useEffect(() => {
    deferHighlightRef.current = deferHighlight
  }, [deferHighlight])

  const clearHighlightTimer = (): void => {
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current)
      highlightTimeoutRef.current = null
    }
  }

  const resumeHighlightAfter = (delay: number): void => {
    clearHighlightTimer()
    highlightTimeoutRef.current = window.setTimeout(() => {
      highlightTimeoutRef.current = null
      setDeferHighlight(false)
    }, delay)
  }

  const handleTranscriptScrolling = (scrolling: boolean): void => {
    if (scrolling) {
      if (deferHighlightRef.current) clearHighlightTimer()
      return
    }
    if (deferHighlightRef.current) resumeHighlightAfter(SCROLL_HIGHLIGHT_RESUME_MS)
  }

  const lockFollowOutput = (): void => {
    followOutputLockedUntilRef.current = window.performance.now() + FOLLOW_OUTPUT_LOCK_MS
  }

  const shouldFollowOutput = (isAtBottom: boolean): 'auto' | false => {
    if (!isAtBottom) return false
    if (window.performance.now() < followOutputLockedUntilRef.current) return false
    return 'auto'
  }

  useEffect(() => {
    setAtBottom(true)
    setDeferHighlight(true)
    resumeHighlightAfter(INITIAL_HIGHLIGHT_DELAY_MS)

    return () => {
      clearHighlightTimer()
    }
  }, [sessionKey])

  if (items.length === 0) {
    return (
      <div className="transcript-scroll h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-5xl flex-col items-center justify-center px-6 py-6 text-center">
          <div className="glass-panel mb-7 flex h-20 w-20 items-center justify-center rounded-[18px] text-zinc-100 shadow-[0_0_34px_rgba(94,168,255,0.18)]">
            <TerminalGlyph />
          </div>
          <h1 className="text-2xl font-semibold text-zinc-100">发送消息开始对话</h1>
          <p className="mt-2 text-sm text-zinc-500">我可以帮助你编写代码、分析问题、执行任务</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            {['列出文件', '总结项目', '查找代码', '修复问题'].map((label) => (
              <span key={label} className="glass-control rounded-xl px-4 py-2 text-sm text-zinc-300">
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const renderRow = (node: ItemNode): JSX.Element => {
    if (node.item.kind === 'user') return <UserMessage item={node.item as UserItem} />
    return <AssistantMessage item={node.item as AssistantItem} depth={0} deferHighlight={deferHighlight} />
  }

  return (
    <div
      className="relative h-full"
      onPointerDownCapture={lockFollowOutput}
      onWheelCapture={(event) => {
        lockFollowOutput()
        if (event.deltaY < 0) setAtBottom(false)
      }}
    >
      <Virtuoso
        ref={virtuosoRef}
        data={roots}
        initialTopMostItemIndex={{ index: Math.max(roots.length - 1, 0), align: 'end' }}
        computeItemKey={(_, node) => node.item.id}
        isScrolling={handleTranscriptScrolling}
        itemContent={(_, node) => (
          // Per-row wrapper preserves the centered, padded column the old single
          // container provided; py-2 approximates the former gap-4 between rows.
          <div className="mx-auto w-full max-w-5xl px-6 py-2">{renderRow(node)}</div>
        )}
        followOutput={shouldFollowOutput}
        atBottomThreshold={2}
        atBottomStateChange={setAtBottom}
        className="transcript-scroll h-full"
        components={{
          Footer: () => (
            <div className="mx-auto w-full max-w-5xl px-6 py-2">
              {compacting && <div className="text-center text-xs text-zinc-500">正在压缩上下文…</div>}
              {running && (
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  Claude 正在处理…
                </div>
              )}
            </div>
          )
        }}
      />
      {!atBottom && (
        <button
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
          className="glass-control absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs text-zinc-300 shadow-lg hover:bg-white/[0.075]"
        >
          ↓ 最新
        </button>
      )}
    </div>
  )
}
