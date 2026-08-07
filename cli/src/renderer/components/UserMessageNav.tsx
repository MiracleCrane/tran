/** #48 用户消息定位导航条。2026-08 改版（Codex 风，用户录屏指定）：对话区
 *  **左缘**一列小横线——每条用户消息一节，当前节更亮更长；常态无框无底，
 *  hover 才浮出摘要列表。点击跳转，最新在下。无用户消息时整体隐藏。 */

export interface UserNavEntry {
  id: string
  /** 该消息在 Virtuoso displayRows 里的行号（scrollToIndex 目标）。 */
  rowIndex: number
  /** 前 ~24 字摘要。 */
  summary: string
}

interface UserMessageNavProps {
  entries: UserNavEntry[]
  /** 当前视口顶部附近对应的条目 id（高亮），由 Transcript 按视口几何推导。 */
  activeId: string | null
  onJump: (rowIndex: number) => void
}

export default function UserMessageNav({
  entries,
  activeId,
  onJump
}: UserMessageNavProps): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    // data-user-msg-nav：Transcript 的 wheel 捕获据此豁免导航条自身的滚动。
    <div data-user-msg-nav className="group absolute left-1 top-1/2 z-10 -translate-y-1/2">
      {/* 常态：一列小横线（Codex 同款）。无框无底，嵌在对话区左缘。 */}
      <div className="flex max-h-[60vh] flex-col items-start gap-[5px] overflow-hidden py-2 group-hover:opacity-0">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onJump(entry.rowIndex)}
            title={entry.summary}
            aria-label={`跳转到：${entry.summary}`}
            className={`h-[3px] shrink-0 rounded-full transition-all ${
              entry.id === activeId
                ? 'w-4 bg-accent'
                : 'w-2.5 bg-zinc-600/60 hover:bg-zinc-400'
            }`}
          />
        ))}
      </div>
      {/* hover 展开：摘要列表（浮在条带右侧），条目多时内部滚动。 */}
      <div className="pointer-events-none absolute left-3 top-1/2 hidden max-h-[60vh] w-56 -translate-y-1/2 overflow-y-auto rounded-xl border border-white/[0.08] bg-zinc-950/85 p-1.5 opacity-0 shadow-xl shadow-black/40 backdrop-blur transition-opacity group-hover:pointer-events-auto group-hover:block group-hover:opacity-100">
        {entries.map((entry, i) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onJump(entry.rowIndex)}
            title={entry.summary}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[11px] transition ${
              entry.id === activeId
                ? 'bg-accent/15 text-accent'
                : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
            }`}
          >
            <span className="shrink-0 text-[9px] text-zinc-600">{i + 1}</span>
            <span className="truncate">{entry.summary}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
