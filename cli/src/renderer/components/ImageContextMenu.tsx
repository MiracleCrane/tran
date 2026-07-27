import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'

/** 对话内图片右键菜单（#22）：复制图片 / 另存为…。自绘 HTML 菜单（跟随深色
 *  UI，同 ChipPopover 的 portal + 点外关闭模式），剪贴板/保存走主进程 IPC。
 *  用法：在 <img> 的 onContextMenu 里调 showImageContextMenu，App 里挂一次
 *  <ImageContextMenuHost />。 */

interface ImageMenuState {
  x: number
  y: number
  src: string
  name?: string
}

const MENU_WIDTH = 160
const MENU_HEIGHT = 80

let openMenu: ((state: ImageMenuState) => void) | null = null

/** blob: URL 主进程读不到，先在渲染层转成 data:（同源 blob，fetch 无 CORS 问题）。 */
async function normalizeImageSrc(src: string): Promise<string> {
  if (!src.startsWith('blob:')) return src
  const blob = await (await fetch(src)).blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** <img> 的 onContextMenu 入口。src 支持 data:/blob:/file:/http(s): 与绝对路径。 */
export function showImageContextMenu(event: MouseEvent, src: string, name?: string): void {
  if (!src) return
  event.preventDefault()
  event.stopPropagation()
  openMenu?.({ x: event.clientX, y: event.clientY, src, name })
}

function suggestedFileName(menu: ImageMenuState): string {
  if (menu.name?.trim()) return menu.name
  // data:/blob: 没有文件名时给默认；file:/http(s): 取 URL 末段。
  if (menu.src.startsWith('data:') || menu.src.startsWith('blob:')) return 'image.png'
  try {
    const tail = new URL(menu.src).pathname.split('/').pop() ?? ''
    return tail || 'image.png'
  } catch {
    return menu.src.split(/[/\\]/).pop() || 'image.png'
  }
}

export default function ImageContextMenuHost(): JSX.Element | null {
  const [menu, setMenu] = useState<ImageMenuState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    openMenu = setMenu
    return () => {
      openMenu = null
    }
  }, [])

  // 点菜单外任意处 / Esc 关闭（无 backdrop，非模态，同 ChipPopover）。
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      if (cardRef.current?.contains(event.target as HTMLElement)) return
      setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menu])

  if (!menu) return null

  // 贴右/下边缘时向内收，避免菜单出屏。
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8))
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8))

  const copyImage = async (): Promise<void> => {
    const src = menu.src
    setMenu(null)
    try {
      await window.api.copyImage(await normalizeImageSrc(src))
    } catch {
      // 复制失败不打断会话（主进程已记日志/无通知需求）。
    }
  }

  const saveImageAs = async (): Promise<void> => {
    const current = menu
    setMenu(null)
    try {
      await window.api.saveImageAs(await normalizeImageSrc(current.src), suggestedFileName(current))
    } catch {
      // 同上。
    }
  }

  const itemClass =
    'w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100'

  return createPortal(
    <div
      ref={cardRef}
      className="glass-panel tran-enter fixed z-[100] rounded-xl p-1 shadow-2xl"
      style={{ left, top, width: MENU_WIDTH }}
    >
      <button type="button" onClick={() => void copyImage()} className={itemClass}>
        复制图片
      </button>
      <button type="button" onClick={() => void saveImageAs()} className={itemClass}>
        另存为…
      </button>
    </div>,
    document.body
  )
}
