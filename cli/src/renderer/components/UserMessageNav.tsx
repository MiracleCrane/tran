/** #48 用户消息定位导航条（Kimi Web 同款）：对话区右缘悬浮一列本会话的
 *  用户消息摘要，点击跳转到对应消息。常态收成细条（每条消息一节），hover
 *  展开成摘要列表；条目过多时列表自身可滚动。无用户消息时整体隐藏。 */

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
    <div data-user-msg-nav className="group absolute right-2 top-1/2 z-10 -translate-y-1/2">
      {/* 常态细条：每条消息一节，点击同样可跳转；最新在下。 */}
      <div className="flex max-h-[50vh] flex-col items-end gap-1 overflow-hidden rounded-full border border-white/[0.06] bg-zinc-950/50 px-1.5 py-2 backdrop-blur-sm group-hover:hidden">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onJump(entry.rowIndex)}
            title={entry.summary}
            aria-label={`跳转到：${entry.summary}`}
            className={`h-1 w-3 shrink-0 rounded-full transition ${
              entry.id === activeId ? 'bg-accent' : 'bg-zinc-600/70 hover:bg-zinc-400'
            }`}
          />
        ))}
      </div>
      {/* hover 展开：摘要列表，条目多时内部滚动。 */}
      <div className="hidden max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-white/[0.08] bg-zinc-950/80 p-1.5 shadow-xl shadow-black/40 backdrop-blur group-hover:block">
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
