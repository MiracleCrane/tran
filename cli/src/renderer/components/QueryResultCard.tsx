import { memo, useState } from 'react'
import type { QueryItem } from '../types'

/** 查询类斜杠命令（/usage、/status、/mcp）的结果状态卡（#15）：查询输出是
 *  状态信息，收进可折叠的状态卡，不以普通 AI 对话气泡形式出现。 */

const QUERY_TITLE: Record<string, string> = {
  '/usage': '用量查询',
  '/status': '状态查询',
  '/mcp': 'MCP 查询'
}

const QueryResultCard = memo(function QueryResultCard({
  item
}: {
  item: QueryItem
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const title = QUERY_TITLE[item.command] ?? '查询结果'

  return (
    <div className="my-1 tran-ai-col rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-zinc-500 transition hover:text-zinc-300"
      >
        <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-accent">
          {item.command}
        </span>
        <span className="shrink-0">{title}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-[10px] text-zinc-600">
          {new Date(item.at).toLocaleTimeString()}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-white/[0.05] px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-400">
          {item.text || '（无输出）'}
        </pre>
      )}
    </div>
  )
})

export default QueryResultCard
