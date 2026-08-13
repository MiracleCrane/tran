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
    // data-follow-no-lock：点这里是"我要跳到那条"，不是"我在读当前这段"，
    // 不该顺手吃掉跟随锁。
    // right-3 而不是贴边：贴边会正好压在滚动条上，点下去命中的是滚动条不是刻度。
    <div
      data-user-msg-nav
      data-follow-no-lock
      className="absolute right-3 top-1/2 z-20 -translate-y-1/2"
      onMouseLeave={() => setHoveredId(null)}
    >
      {/* 这里**不能**有 overflow-hidden：摘要标签是往左浮出到刻度列外面的，
          一裁就整条看不见——表现就是"悬停没有摘要"（2026-08 用户反馈的 bug）。 */}
      <div className="flex flex-col items-end gap-[2px] py-2">
        {entries.map((entry) => {
          const active = entry.id === activeId
          const hovered = entry.id === hoveredId
          return (
            // 整行都是命中区（w-10 的透明带，右对齐）：只把 3px 的横线做成按钮
            // 的话，鼠标得精准戳中十来个像素，实际体验就是"点了没反应"。宽度
            // 停在 40px——再宽就会盖住正文右侧、把选中文本的点击也吃掉。
            <button
              key={entry.id}
              type="button"
              onClick={() => onJump(entry.rowIndex)}
              onMouseEnter={() => setHoveredId(entry.id)}
              aria-label={`跳转到：${entry.summary}`}
              className="relative flex h-[7px] w-10 items-center justify-end"
            >
              {/* 摘要标签：只在悬停那一节旁边浮出，跟着这一节的垂直位置走。 */}
              {hovered && (
                <span className="pointer-events-none absolute right-full mr-2 max-w-[15rem] truncate whitespace-nowrap rounded-md border border-border-subtle bg-bg-elev px-2 py-1 text-[11px] text-zinc-200 shadow-lg shadow-black/40">
                  {entry.summary}
                </span>
              )}
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
          )
        })}
      </div>
    </div>
  )
}
