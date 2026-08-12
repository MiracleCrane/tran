import { useState } from 'react'

/** #48 用户消息定位导航条。2026-08-12 改版（Codex 同款交互，用户录屏指定）：
 *  对话区**右缘**一列小横线——每条用户消息一节。常态无框无底；鼠标移到某一
 *  节上时**只有那一节**变白变长，并在旁边浮出该条消息的摘要标签。
 *
 *  与上一版的区别：上一版一悬停整条刻度就淡出、改弹一个 224px 宽的摘要列表，
 *  等于"想点第 3 条，一靠近目标就消失了"——Codex 不是这么做的，刻度始终在，
 *  悬停只强化当前那一节。点击跳转，最新在下。无用户消息时整体隐藏。 */

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
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  if (entries.length === 0) return null
  return (
    // data-user-msg-nav：Transcript 的 wheel 捕获据此豁免导航条自身的滚动。
    <div
      data-user-msg-nav
      className="group absolute right-1.5 top-1/2 z-10 -translate-y-1/2"
      onMouseLeave={() => setHoveredId(null)}
    >
      <div className="flex max-h-[60vh] flex-col items-end gap-[5px] overflow-hidden py-2">
        {entries.map((entry) => {
          const active = entry.id === activeId
          const hovered = entry.id === hoveredId
          return (
            <div key={entry.id} className="relative flex items-center justify-end">
              {/* 摘要标签：只在悬停那一节旁边浮出，跟着这一节的垂直位置走。 */}
              {hovered && (
                <span className="pointer-events-none absolute right-full mr-2 max-w-[15rem] truncate rounded-md border border-border-subtle bg-bg-elev px-2 py-1 text-[11px] text-zinc-200 shadow-lg shadow-black/40">
                  {entry.summary}
                </span>
              )}
              <button
                type="button"
                onClick={() => onJump(entry.rowIndex)}
                onMouseEnter={() => setHoveredId(entry.id)}
                aria-label={`跳转到：${entry.summary}`}
                // 命中区比视觉横线高一档（py 撑开），否则 3px 的线太难指中。
                className="flex h-[9px] items-center py-[3px]"
              >
                <span
                  className={`block h-[3px] rounded-full transition-all ${
                    hovered
                      ? 'w-6 bg-zinc-100'
                      : active
                        ? 'w-4 bg-accent'
                        : 'w-2.5 bg-zinc-600/60'
                  }`}
                />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
