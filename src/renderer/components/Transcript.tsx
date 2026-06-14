import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { AssistantBlock, AssistantItem, UserItem, TranscriptItem, ItemNode } from '../types'
import MessageText from './MessageText'
import ToolCallCard from './ToolCallCard'

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

function UserMessage({ item }: { item: UserItem }): JSX.Element {
  const atts = item.attachments ?? []
  return (
    <div className="flex justify-end">
      <div
        className={`max-w-[85%] rounded-[16px] rounded-tr-md border px-4 py-2.5 shadow-lg shadow-black/10 backdrop-blur ${
          item.queued
            ? 'border-dashed border-white/15 bg-white/[0.03] opacity-70'
            : 'border-white/10 bg-white/[0.065]'
        }`}
      >
        {item.queued && (
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
            排队中…
          </div>
        )}
        {item.text && (
          <div className="whitespace-pre-wrap break-words text-sm text-zinc-200">{item.text}</div>
        )}
        {atts.length > 0 && (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {atts.map((a, i) =>
              a.kind === 'image' && a.dataUrl ? (
                <img
                  key={i}
                  src={a.dataUrl}
                  alt={a.name}
                  className="max-h-44 max-w-[220px] rounded-lg border border-white/10 object-cover"
                />
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-zinc-300"
                  title={a.name}
                >
                  <span className="text-zinc-500">{a.kind === 'text' ? '📄' : '📎'}</span>
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                </span>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  if (!text) return <></>
  return (
    <details
      open
      className="glass-panel-soft my-1.5 rounded-xl px-3 py-2"
    >
      <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-400">
        思考过程
      </summary>
      <div className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-zinc-500">
        {text}
      </div>
    </details>
  )
}

/** Render a list of nodes. `seen` + depth cap stay as a safety net even though
 *  subagent content no longer nests here (it's monitored separately now). */
const MAX_DEPTH = 16
function MessageNodes({
  nodes,
  depth,
  seen
}: {
  nodes: ItemNode[]
  depth: number
  seen: Set<string>
}): JSX.Element {
  if (depth > MAX_DEPTH) return <></>
  return (
    <>
      {nodes
        .filter((n) => !seen.has(n.item.id))
        .map((n) =>
          n.item.kind === 'user' ? (
            <UserMessage key={n.item.id} item={n.item as UserItem} />
          ) : (
            <AssistantMessage key={n.item.id} node={n} depth={depth} />
          )
        )}
    </>
  )
}

function AssistantMessage({ node, depth }: { node: ItemNode; depth: number }): JSX.Element {
  const item = node.item as AssistantItem
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
          if (block.kind === 'text') return <MessageText key={i}>{block.text}</MessageText>
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
}

export default function Transcript(): JSX.Element {
  const items = useSessionStore((s) => s.items)
  const running = useSessionStore((s) => s.status.running)
  const compacting = useSessionStore((s) => s.status.compacting)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // "stick to bottom": only auto-scroll while the user is already near the
  // bottom. If they scroll up to read history mid-stream, we stop following
  // until they return (or click the ↓ button).
  const [stick, setStick] = useState(true)

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setStick(distFromBottom < 80)
  }

  useEffect(() => {
    if (stick) bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [items, running, stick])

  const scrollToBottom = (): void => {
    setStick(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  const roots = useMemo(() => buildForest(items), [items])

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6">
          {items.length === 0 && (
            <div className="flex min-h-[52vh] flex-col items-center justify-center text-center">
              <div className="glass-panel mb-7 flex h-20 w-20 items-center justify-center rounded-[18px] text-zinc-100 shadow-[0_0_34px_rgba(94,168,255,0.18)]">
                <TerminalGlyph />
              </div>
              <h1 className="text-2xl font-semibold text-zinc-100">发送消息开始对话</h1>
              <p className="mt-2 text-sm text-zinc-500">我可以帮助你编写代码、分析问题、执行任务</p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                {['列出文件', '总结项目', '查找代码', '修复问题'].map((label) => (
                  <span
                    key={label}
                    className="glass-control rounded-xl px-4 py-2 text-sm text-zinc-300"
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}
          <MessageNodes nodes={roots} depth={0} seen={new Set()} />
          {compacting && <div className="text-center text-xs text-zinc-500">正在压缩上下文…</div>}
          {running && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Claude 正在处理…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      {!stick && (
        <button
          onClick={scrollToBottom}
          className="glass-control absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs text-zinc-300 shadow-lg hover:bg-white/[0.075]"
        >
          ↓ 最新
        </button>
      )}
    </div>
  )
}
