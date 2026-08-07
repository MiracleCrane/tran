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

/**
 * 悬停浮出的进入/离开延迟。
 *
 * 两个方向的抖动都要治，而且**成因相反**：
 * - 进入不加延迟 → 鼠标从侧栏边上扫过去就弹出来（"过于灵敏"）；
 * - 离开不加延迟 → 从窄图标条斜着往浮层里移动时，指针会有几帧落在两者之间的
 *   空隙上，pointerleave 立刻触发、面板当场消失（"不灵敏"，其实是关早了）。
 * 所以进入给短延迟防误触，离开给长延迟容忍路径抖动。
 */
const PEEK_OPEN_DELAY_MS = 140
const PEEK_CLOSE_DELAY_MS = 260
/** 退场动画时长，与 styles.css 的 sidebar-peek-out 一致。 */
const PEEK_LEAVE_ANIM_MS = 170

export default function SidebarShell(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const hidden = useUiStore((s) => s.sidebarHidden)
  const width = useUiStore((s) => s.sidebarWidth)
  const hoverExpand = useUiStore((s) => s.sidebarHoverExpand)
  const [peeking, setPeeking] = useState(false)
  /** 退场中：面板还挂着但正在播淡出动画，播完才卸载（2026-08：消失太突兀）。 */
  const [leaving, setLeaving] = useState(false)
  const peekTimerRef = useRef<number | null>(null)
  const leaveTimerRef = useRef<number | null>(null)

  const clearPeekTimer = (): void => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current)
      peekTimerRef.current = null
    }
  }
  const clearLeaveTimer = (): void => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }

  const schedulePeek = (next: boolean): void => {
    clearPeekTimer()
    clearLeaveTimer()
    if (next) {
      // 重新进入：立刻退出退场态（动画反向衔接），按进入延迟打开。
      peekTimerRef.current = window.setTimeout(() => {
        peekTimerRef.current = null
        setLeaving(false)
        setPeeking(true)
      }, PEEK_OPEN_DELAY_MS)
      return
    }
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null
      if (!peeking) return
      setLeaving(true)
      leaveTimerRef.current = window.setTimeout(() => {
        leaveTimerRef.current = null
        setPeeking(false)
        setLeaving(false)
      }, PEEK_LEAVE_ANIM_MS)
    }, PEEK_CLOSE_DELAY_MS)
  }

  // 展开之后残留的 peek 会盖在正文上，必须清掉（连同在途的定时器）。
  // 隐藏态（hidden）的 peek 由隐藏分支自己管理，这里不插手。
  useEffect(() => {
    if (hidden) return
    if (!collapsed || !hoverExpand) {
      clearPeekTimer()
      clearLeaveTimer()
      setPeeking(false)
      setLeaving(false)
    }
  }, [collapsed, hoverExpand, hidden])

  useEffect(
    () => () => {
      clearPeekTimer()
      clearLeaveTimer()
    },
    []
  )

  // 完全隐藏（Codex 风）：连图标条都不渲染，dock 收成零宽——主区顺势铺满，
  //  网格列动画（workspace-shell 的 grid-template-columns 过渡）给出滑走感。
  //  但左缘留一条 10px 的隐形触发带：悬停浮出完整侧栏（peek），移开自动收回
  //  （2026-08 用户：隐藏了鼠标悬停也要能出来）。
  if (hidden) {
    return (
      <div className="sidebar-dock relative w-0 shrink-0">
        <div
          className="absolute inset-y-0 left-0 z-[110] w-2.5"
          title="悬停展开侧栏"
          onPointerEnter={() => schedulePeek(true)}
          onPointerLeave={() => schedulePeek(false)}
        />
        {peeking && (
          <div
            className={`sidebar-peek ${leaving ? 'is-leaving' : ''}`}
            style={{ width: `${width}px` }}
            onPointerEnter={() => schedulePeek(true)}
            onPointerLeave={() => schedulePeek(false)}
          >
            <Sidebar forceExpanded />
          </div>
        )}
      </div>
    )
  }

  const peekOn = collapsed && hoverExpand

  return (
    <div
      className="sidebar-dock relative flex shrink-0"
      // 宽度经 CSS 变量下发：Sidebar 内部那个 w-64 是 Tailwind 工具类，
      // 在 styles.css 里用不带 @layer 的规则覆盖它（无层声明胜过任何 @layer）。
      style={{ ['--sidebar-w' as string]: `${width}px` }}
      {...(peekOn
        ? {
            onPointerEnter: () => schedulePeek(true),
            onPointerLeave: () => schedulePeek(false)
          }
        : {})}
    >
      {/* 悬停触发区：dock 本体（图标条全高）就是触发区。2026-08 曾加过一条
          伸进主区的扩展条，但合体布局里主区紧贴 dock（没有沟），扩展条会盖住
          主区左缘 16px 的点击——已撤。 */}
      {/* 图标条始终挂着：它决定在流的那一列有多宽，卸载会让 Sidebar 每次悬停
          都重建、内部状态全丢。2026-08 起浮层改实底（.sidebar-peek > * 实色
          背景），从左缘完整盖住图标条，不再需要 invisible 切换——衔接不再跳。 */}
      <Sidebar />
      {peekOn && peeking && (
        <div className={`sidebar-peek ${leaving ? 'is-leaving' : ''}`} style={{ width: `${width}px` }}>
          <Sidebar forceExpanded />
        </div>
      )}
      {/* 收起态是固定宽度的图标条，不给调节边。 */}
      {!collapsed && <ResizeHandle />}
    </div>
  )
}
