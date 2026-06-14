import { memo, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { AssistantBlock, AssistantItem, UserItem, TranscriptItem } from '../types'
import MessageText from './MessageText'
import ToolCallCard from './ToolCallCard'

function UserMessage({ item }: { item: UserItem }): JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm border border-border-subtle bg-bg-elev px-4 py-2.5">
        <div className="whitespace-pre-wrap break-words text-sm text-zinc-200">{item.text}</div>
      </div>
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  if (!text) return <></>
  return (
    <details
      open
      className="my-1.5 rounded-lg border border-border-subtle/50 bg-bg-panel/50 px-3 py-2"
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

function AssistantMessage({ item }: { item: AssistantItem }): JSX.Element {
  return (
    <div className="max-w-[92%]">
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

const MemoUserMessage = memo(UserMessage)
const MemoAssistantMessage = memo(AssistantMessage)

function renderItem(item: TranscriptItem): JSX.Element {
  if (item.kind === 'user') return <MemoUserMessage key={item.id} item={item} />
  return <MemoAssistantMessage key={item.id} item={item} />
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

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
          {items.length === 0 && (
            <div className="mt-10 text-center text-sm text-zinc-600">
              发送消息开始对话。试试:{' '}
              <span className="font-mono">列出文件并总结这个项目</span>
            </div>
          )}
          {items.map(renderItem)}
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
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border-subtle bg-bg-panel px-3 py-1.5 text-xs text-zinc-300 shadow-lg hover:bg-bg-hover"
        >
          ↓ 最新
        </button>
      )}
    </div>
  )
}
