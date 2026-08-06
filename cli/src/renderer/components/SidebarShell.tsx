import { useEffect, useRef, useState } from 'react'
import Sidebar from './Sidebar'
import { useUiStore, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_DEFAULT } from '../store/uiStore'

/**
 * 侧栏外壳：给侧栏加一条可拖的宽度调节边。
 *
 * 做成独立外壳而不是改 Sidebar 内部：Sidebar 有收起/展开两条 return 分支，
 * 在里面塞拖拽逻辑要两条路径都改一遍，改动面大、也容易和别人的编辑撞车。
 *
 * 收起态（w-14 图标条）不参与调节——它是固定尺寸的图标列，能调宽反而奇怪。
 */

/**
 * 拖到比最小宽度还窄多少像素时，吸附成收起态。
 *
 * 这是 VS Code 那套标准行为：一路往左拖会先卡在 MIN，继续拖过头就收起。
 * 没有这个的话，拖到最小宽度就完全卡住，用户会以为拖坏了。
 */
const COLLAPSE_SNAP_PX = 48

function ResizeHandle(): JSX.Element {
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const [dragging, setDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const collapsedRef = useRef(false)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      if (collapsedRef.current) return
      const raw = startWidthRef.current + (e.clientX - startXRef.current)
      if (raw < SIDEBAR_WIDTH_MIN - COLLAPSE_SNAP_PX) {
        // 越过吸附线：收起并立即结束本次拖拽，别继续跟手。
        collapsedRef.current = true
        setDragging(false)
        toggleSidebar()
        return
      }
      setSidebarWidth(raw)
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // 拖拽期间禁掉整页文本选中：否则划过正文会把文字一起选蓝。
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, setSidebarWidth, toggleSidebar])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调节侧栏宽度"
      onPointerDown={(e) => {
        if (e.button !== 0) return // 只认主键
        startXRef.current = e.clientX
        startWidthRef.current = useUiStore.getState().sidebarWidth
        collapsedRef.current = false
        setDragging(true)
      }}
      // 双击恢复默认宽度——调乱了不用一点点往回拖。
      onDoubleClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
      className={`sidebar-resize-handle ${dragging ? 'is-dragging' : ''}`}
    />
  )
}

export default function SidebarShell(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const width = useUiStore((s) => s.sidebarWidth)
  const hoverExpand = useUiStore((s) => s.sidebarHoverExpand)
  const [peeking, setPeeking] = useState(false)

  // 展开之后残留的 peek 会盖在正文上，必须清掉。
  useEffect(() => {
    if (!collapsed || !hoverExpand) setPeeking(false)
  }, [collapsed, hoverExpand])

  const peekOn = collapsed && hoverExpand

  return (
    <div
      className="sidebar-dock relative flex shrink-0"
      // 宽度经 CSS 变量下发：Sidebar 内部那个 w-64 是 Tailwind 工具类，
      // 在 styles.css 里用不带 @layer 的规则覆盖它（无层声明胜过任何 @layer）。
      style={{ ['--sidebar-w' as string]: `${width}px` }}
      {...(peekOn
        ? {
            onPointerEnter: () => setPeeking(true),
            onPointerLeave: () => setPeeking(false)
          }
        : {})}
    >
      {/* 图标条始终挂着：它决定在流的那一列有多宽。浮出时它被浮层盖住，
          但不能卸载——卸载会让 Sidebar 每次悬停都重建，内部状态全丢。 */}
      <Sidebar />
      {peekOn && peeking && (
        <div className="sidebar-peek" style={{ width: `${width}px` }}>
          <Sidebar forceExpanded />
        </div>
      )}
      {/* 收起态是固定宽度的图标条，不给调节边。 */}
      {!collapsed && <ResizeHandle />}
    </div>
  )
}
