import { useEffect, useRef, useState } from 'react'
import Sidebar from './Sidebar'
import { useUiStore } from '../store/uiStore'

/**
 * 侧栏外壳：负责「完全隐藏」这一套，不碰 Sidebar 自身。
 *
 * Tran 有两套独立的侧栏形态，别混为一谈：
 * - **收起/展开**（Sidebar 内部的 sidebarCollapsed）：w-14 图标条 ↔ w-64 面板，
 *   都还占着布局位置，点箭头切换。
 * - **完全隐藏**（这里）：宽度归零、彻底不见，只在窗口左边缘留一条热区，
 *   鼠标移上去才以浮层滑出，移开收回。
 *
 * 触发方式刻意是**拖**而不是设置开关：拖住侧栏右边缘往左拉，越过阈值松手即隐藏。
 * 默认不开，不主动拖就永远是原来的样子——所以它不需要设置项，只是个持久化的
 * UI 状态（见 uiStore.sidebarAutoHidden）。
 *
 * 做成独立外壳而不是改 Sidebar 内部：Sidebar 有两个 return 分支（收起/展开），
 * 在里面套隐藏逻辑要把两条返回路径都改一遍，改动面大且容易和别人的编辑撞车。
 */

/** 往左拖多少像素算"要隐藏"。太小会误触（手抖就没了），太大又拖不动。 */
const HIDE_DRAG_THRESHOLD_PX = 56

function DragHandle({ onHide }: { onHide: () => void }): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const startXRef = useRef(0)
  const firedRef = useRef(false)

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      if (firedRef.current) return
      if (startXRef.current - e.clientX >= HIDE_DRAG_THRESHOLD_PX) {
        // 越过阈值立即生效，不等松手：手感上"拉到位就吸走"比"松手才反应"跟手。
        firedRef.current = true
        setDragging(false)
        onHide()
      }
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, onHide])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="向左拖可隐藏侧栏（Ctrl+B 恢复）"
      onPointerDown={(e) => {
        // 只认主键；右键/中键拖拽不该触发。
        if (e.button !== 0) return
        startXRef.current = e.clientX
        firedRef.current = false
        setDragging(true)
      }}
      className={`sidebar-drag-handle ${dragging ? 'is-dragging' : ''}`}
    />
  )
}

export default function SidebarShell(): JSX.Element {
  const autoHidden = useUiStore((s) => s.sidebarAutoHidden)
  const setAutoHidden = useUiStore((s) => s.setSidebarAutoHidden)
  const [peeking, setPeeking] = useState(false)

  // 从隐藏态恢复（Ctrl+B 等）时把浮层状态一并清掉，否则会残留一层浮着的侧栏。
  useEffect(() => {
    if (!autoHidden) setPeeking(false)
  }, [autoHidden])

  if (!autoHidden) {
    return (
      <div className="sidebar-dock relative flex shrink-0">
        <Sidebar />
        <DragHandle onHide={() => setAutoHidden(true)} />
      </div>
    )
  }

  // 隐藏态仍然保留一个**零宽的在流容器**：workspace-shell 是
  // `grid-template-columns: auto minmax(0,1fr) 0rem`，侧栏占第一列。若这里只
  // 渲染绝对定位元素，它们脱离网格流，main-surface 会顶到第一列去，布局全乱。
  return (
    <div className="sidebar-dock is-hidden relative shrink-0">
      {/* 左边缘热区：隐藏态下唯一的入口。 */}
      <div className="sidebar-hotzone" onPointerEnter={() => setPeeking(true)} aria-hidden />
      {peeking && (
        <div className="sidebar-peek" onPointerLeave={() => setPeeking(false)}>
          <Sidebar />
        </div>
      )}
    </div>
  )
}
