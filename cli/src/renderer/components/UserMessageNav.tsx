import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * #48 用户消息导航条。2026-08-13 重写：**照搬 Codex 的
 * `thread-user-message-navigation-rail`**（从本机安装包的 app.asar 里读的实现），
 * 只把方向镜像到右侧。
 *
 * 从原实现学到、也是之前几版一直没做对的四件事：
 *
 * 1. **命中区和刻度是两回事**。Codex 的按钮是 `h-2.5 w-9`（10×36px）的透明带，
 *    刻度只是里面一根 26px×2px 的线。之前把按钮做得跟线一样大，等于要求用户
 *    精准戳中十个像素。
 * 2. **刻度靠 scaleX 变长，不改布局宽度**。布局宽度恒 26px，视觉长度由
 *    `scaleX(0.2308 → 1)` 给（6px → 26px）。改宽度会引起重排、动画发抖。
 * 3. **悬停是一条涟漪，不是一个点**。当前节满格，相邻 .7、次邻 .4、再次 .2，
 *    纯 CSS 兄弟选择器实现（见 styles.css 的 .tran-nav-marker）。
 * 4. **可以按住拖着刷**（scrub）。按下后 setPointerCapture，移动时用
 *    `elementFromPoint` 取当前 y 对应的那一节并即时跳过去；拖动期间过渡时长
 *    归零。松手时吞掉那一次 click，否则会再跳一次。
 *
 * 另外两处也跟着对齐：高亮的是**视口内的一整段**（可能多条同时亮，Codex 用
 * IntersectionObserver 求可见区间），以及跳转后目标气泡**闪一下**。
 *
 * 唯一有意偏离原作的地方：Codex 在左侧（`left-3`），Tran 放右侧——这是用户
 * 明确要求的。因此刻度的生长方向、悬停卡片的浮出方向都做了镜像。
 */

export interface UserNavEntry {
  id: string
  /** 该消息在 Virtuoso displayRows 里的行号（scrollToIndex 目标）。 */
  rowIndex: number
  /** 用户这句话的前 ~24 字。 */
  summary: string
  /** 这一轮 AI 回复的开头（悬停卡片的第二段，最多三行）。 */
  preview?: string
}

interface UserMessageNavProps {
  entries: UserNavEntry[]
  /** 视口内可见的条目 id 集合（可能多条，对齐 Codex 的可见区间高亮）。 */
  activeIds: ReadonlySet<string>
  onJump: (entry: UserNavEntry, behavior: 'smooth' | 'auto') => void
}

/** 拖动时用来找「当前 y 对应哪一节」。 */
function itemIdAt(list: HTMLElement, clientY: number): string | null {
  const rect = list.getBoundingClientRect()
  const y = Math.max(rect.top, Math.min(clientY, rect.bottom - 1))
  const el = document.elementFromPoint(rect.left + rect.width / 2, y)
  const button = el?.closest<HTMLElement>('[data-nav-item-id]')
  if (!button || !list.contains(button)) return null
  return button.dataset.navItemId ?? null
}

export default function UserMessageNav({
  entries,
  activeIds,
  onJump
}: UserMessageNavProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [hovered, setHovered] = useState<{ entry: UserNavEntry; top: number } | null>(null)
  const [scrubId, setScrubId] = useState<string | null>(null)
  /** 拖动过程中已经跳过了：随后那一次 click 必须吞掉，否则重复跳转。 */
  const scrubbedRef = useRef(false)
  /** 拖动中的指针 id 与**捕获元素**。捕获必须挂在按下的那个 button 上——
   *  挂在外层滚动列上的话，指针捕获会把随后的 click 一并重定向到列本身，
   *  按钮的 onClick 永远不触发（v1.0.91「点了不跳转」就是这个原因）。 */
  const pointerRef = useRef<{ id: number; target: HTMLElement } | null>(null)

  /** 悬停卡片要浮在刻度列**外面**，而列本身是 overflow-y-auto（横向也会被裁），
   *  所以卡片渲染在列的外层容器里，靠这里量出来的 y 定位。 */
  const showPreviewFor = useCallback((entry: UserNavEntry, button: HTMLElement): void => {
    const host = listRef.current?.parentElement
    if (!host) return
    const b = button.getBoundingClientRect()
    const h = host.getBoundingClientRect()
    setHovered({ entry, top: b.top - h.top + b.height / 2 })
  }, [])

  /**
   * 长会话里刻度列自己会滚（max-h + overflow-y-auto）。每次可见区间变化就把
   * 当前那一节滚进列的视野——否则聊到几十轮之后，导航条停在顶部一动不动，
   * 你正在看的那几格早滚到列外面去了。
   *
   * 拖动中不要抢滚动位置（会跟手指打架）。逻辑与 Codex 的 `et()` 一致：只在
   * 越界时补最小位移，不做居中。
   */
  const lastActiveId = activeIds.size > 0 ? [...activeIds][activeIds.size - 1] : null
  useLayoutEffect(() => {
    if (scrubId !== null || lastActiveId === null) return
    const list = listRef.current
    if (!list) return
    const node = list.querySelector<HTMLElement>(`[data-nav-item-id="${CSS.escape(lastActiveId)}"]`)
    if (!node) return
    if (node.offsetTop < list.scrollTop) {
      list.scrollTop = node.offsetTop
    } else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight + 1
    }
  }, [lastActiveId, scrubId, entries.length])

  const endScrub = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = pointerRef.current
    if (active === null || active.id !== event.pointerId) return
    pointerRef.current = null
    setScrubId(null)
    if (active.target.hasPointerCapture?.(event.pointerId)) {
      active.target.releasePointerCapture(event.pointerId)
    }
    // 下一个 tick 再解锁：中间夹着的那次 click 要被吞掉。
    window.setTimeout(() => {
      scrubbedRef.current = false
    }, 0)
  }

  return (
    // data-user-msg-nav：Transcript 的 wheel 捕获据此豁免导航条自身的滚动。
    // data-follow-no-lock：点导航是「我要跳到那条」，不该被当成「我在读当前
    // 这段」而吃掉跟随锁。
    <nav
      data-user-msg-nav
      data-follow-no-lock
      aria-label="用户消息"
      // 离右缘的距离不能小：转录区是 scrollbar-gutter: stable both-edges + 10px
      // 滚动条。贴太近有两个后果——一是点击命中的是滚动条而不是刻度（v1.0.92
      // 之前就栽在这），二是视觉上和滚动条挤成一坨（2026-08 用户反馈：right-3
      // 时净空只剩 2px）。right-5 = 20px，给滚动条留 10px 净空。
      className="absolute right-5 top-1/2 z-20 -translate-y-1/2"
      onMouseLeave={() => setHovered(null)}
    >
      {hovered && (
        <div
          className="pointer-events-none absolute right-full mr-2 w-80 max-w-[calc(100vw-1rem)] -translate-y-1/2 overflow-hidden rounded-xl border border-border-subtle bg-bg-elev/95 p-2 text-sm leading-5 text-zinc-100 shadow-xl shadow-black/50 backdrop-blur-sm"
          style={{ top: hovered.top }}
        >
          <div className="min-w-0 truncate font-medium">{hovered.entry.summary}</div>
          {hovered.entry.preview && (
            <div className="mt-1 line-clamp-3 text-[13px] leading-5 text-zinc-400">
              {hovered.entry.preview}
            </div>
          )}
        </div>
      )}

      <div
        ref={listRef}
        className="tran-nav-rail-list flex max-h-[min(70vh,40rem)] flex-col overflow-y-auto overscroll-contain"
        data-scrubbing={scrubId !== null ? true : undefined}
        onPointerDownCapture={(event) => {
          if (event.button !== 0) return
          const list = listRef.current
          if (!list) return
          const target = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(
            '[data-nav-item-id]'
          )
          if (!target || !list.contains(target)) return
          const id = target.dataset.navItemId
          if (id === undefined) return
          const entry = entries.find((e) => e.id === id)
          if (!entry) return
          // 捕获挂在**按钮**上，不是外层的列：挂在列上会把随后的 click 重定向
          // 给列，按钮的 onClick 就再也不触发了。
          pointerRef.current = { id: event.pointerId, target }
          scrubbedRef.current = false
          setScrubId(id)
          target.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const list = listRef.current
          if (!list) return
          if (pointerRef.current?.id !== event.pointerId) return
          // 按键已松开（拖出列外松手等）：收尾。
          if (event.buttons % 2 === 0) {
            endScrub(event)
            return
          }
          const id = itemIdAt(list, event.clientY)
          if (id === null || id === scrubId) return
          const entry = entries.find((e) => e.id === id)
          if (!entry) return
          setScrubId(id)
          scrubbedRef.current = true
          const button = list.querySelector<HTMLElement>(`[data-nav-item-id="${CSS.escape(id)}"]`)
          if (button) showPreviewFor(entry, button)
          // 拖动中用 auto：smooth 会排队补间，跟不上手。
          onJump(entry, 'auto')
        }}
        onPointerUpCapture={endScrub}
        onPointerCancelCapture={endScrub}
        onLostPointerCapture={endScrub}
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-nav-item-id={entry.id}
            data-scrub-target={scrubId === entry.id ? true : undefined}
            aria-current={activeIds.has(entry.id) ? 'true' : undefined}
            aria-label={`跳转到：${entry.summary}`}
            // 10×36px 的透明命中带；刻度只是里面那根线（Codex 同尺寸）。
            className="flex h-2.5 w-9 shrink-0 cursor-pointer items-center justify-end outline-none"
            onClick={(event) => {
              if (scrubbedRef.current) {
                scrubbedRef.current = false
                return
              }
              showPreviewFor(entry, event.currentTarget)
              onJump(entry, 'smooth')
            }}
            onFocus={(event) => showPreviewFor(entry, event.currentTarget)}
            onPointerEnter={(event) => showPreviewFor(entry, event.currentTarget)}
          >
            <span className="flex h-0.5 w-[30px] items-center justify-end">
              <span className="tran-nav-marker" />
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
