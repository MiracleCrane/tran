import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'

/** 行内元素（路径 pill / 外链）的通用右键菜单（2026-08-26 用户反馈：pill 整颗
 *  是按钮、链接整段可点，导致「没办法复制这个链接里面的文字」——右键给复制/打开
 *  入口）。
 *  沿用 ImageContextMenu 的 portal + 点外/Esc 关闭模式，另加滚动关闭；菜单项
 *  由调用方给（label + action），组件本身不含业务逻辑，避免再复制一套壳。
 *  用法：onContextMenu 里调 showInlineContextMenu(event, items)，App 里挂一次
 *  <InlineContextMenuHost />。 */

export interface InlineMenuItem {
  label: string
  action: () => void
  /** 可选色点（项目外观选色用）：渲染在 label 前的小圆点。 */
  swatch?: string
}

interface InlineMenuState {
  x: number
  y: number
  items: InlineMenuItem[]
}

const MENU_WIDTH = 176
// 夹取定位用的高度估算：item 约 30px + 上下 p-1。
const ITEM_HEIGHT = 30
const MENU_PADDING = 8

let openMenu: ((state: InlineMenuState) => void) | null = null

/** 行内元素的 onContextMenu 入口。 */
export function showInlineContextMenu(event: MouseEvent, items: InlineMenuItem[]): void {
  if (items.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  openMenu?.({ x: event.clientX, y: event.clientY, items })
}

export default function InlineContextMenuHost(): JSX.Element | null {
  const [menu, setMenu] = useState<InlineMenuState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    openMenu = setMenu
    return () => {
      openMenu = null
    }
  }, [])

  // 点菜单外任意处 / Esc / 滚动关闭（无 backdrop，非模态，同 ImageContextMenu）。
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      if (cardRef.current?.contains(event.target as HTMLElement)) return
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    const onScroll = (): void => setMenu(null)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  if (!menu) return null

  // 贴右/下边缘时向内收，避免菜单出屏。
  const menuHeight = menu.items.length * ITEM_HEIGHT + MENU_PADDING
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - menuHeight - 8))

  const itemClass =
    'w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100'

  return createPortal(
    <div
      ref={cardRef}
      className="glass-panel tran-enter fixed z-[100] rounded-xl p-1 shadow-2xl"
      style={{ left, top, width: MENU_WIDTH }}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={() => {
            setMenu(null)
            item.action()
          }}
          className={itemClass}
        >
          {item.swatch && (
            <span
              className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
              style={{ background: item.swatch }}
            />
          )}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
