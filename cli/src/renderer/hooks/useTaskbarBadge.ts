import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/sessionStore'

/** 画任务栏角标：深色圆底 + 白色数字（Codex 风格）。64px 绘制，高分屏不糊。 */
function drawBadge(count: number): string {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const r = size / 2
  ctx.beginPath()
  ctx.arc(r, r, r - 2, 0, Math.PI * 2)
  ctx.fillStyle = '#1f1f23'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 ${count > 9 ? 30 : 38}px "Segoe UI", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 9 ? '9+' : String(count), r, r + 2)
  return canvas.toDataURL('image/png')
}

type StoreSnapshot = ReturnType<typeof useSessionStore.getState>

/** 等待用户处理的总数：前台提问队列 + 前台待授权 + 各后台会话镜像
 *  （bgWaitingCounts 的维护点见 sessionStore 的 setBgWaiting 注释）。 */
function selectWaitingCount(s: StoreSnapshot): number {
  let n = s.elicitationQueue.length + s.pendingPermissions.length
  for (const k in s.bgWaitingCounts) n += s.bgWaitingCounts[k]
  return n
}

/**
 * 每轮回答完且窗口不在前台时，给任务栏图标打一个 Codex 式数字角标
 * （2026-08-18 用户：「每轮对话你回答完了能够像 codex 一样有个小标」）。
 * 计数连续累计（前台连着完成 N 轮才切走也能看到 N）；聚焦即清零——渲染层
 * 清计数，图标本身由主进程的 focus 监听复位（见 main/index.ts）。
 *
 * 2026-09-01 起叠加「等待提醒」（用户：agent 提问/待授权且窗口没焦点时，
 * 任务栏同款数字角标 + flashFrame 闪烁，回答或聚焦后停）。两种角标互斥：
 * 有等待显示等待数，等待归零才回退轮末未读逻辑。闪烁停止有两条路——
 * 回答后等待数归零（本 hook）与窗口聚焦（主进程 focus 监听兜底）。
 */
export function useTaskbarBadge(): void {
  const running = useSessionStore((s) => s.status.running)
  const waitingCount = useSessionStore(selectWaitingCount)
  const prevRunningRef = useRef(running)
  const prevWaitingRef = useRef(waitingCount)
  const countRef = useRef(0)

  useEffect(() => {
    const reset = (): void => {
      countRef.current = 0
      // 聚焦即停闪（主进程 focus 监听也停，见 main/index.ts；这里再停一次，
      // 渲染层不等主进程事件也能立刻安静下来）。
      void window.api.flashFrame(false)
    }
    window.addEventListener('focus', reset)
    return () => window.removeEventListener('focus', reset)
  }, [])

  // 等待提醒：只在新等待到达（总数上升）且窗口无焦点时打标+闪；已经挂着
  // 的等待不因切走重复闪（用户已被告知过，聚焦前不再打扰）。
  useEffect(() => {
    const prev = prevWaitingRef.current
    prevWaitingRef.current = waitingCount
    if (waitingCount === 0) {
      if (prev > 0) {
        // 回答完（或队列被清）：停闪。期间若有完成的轮未读，补回轮末角标。
        void window.api.flashFrame(false)
        if (!document.hasFocus() && countRef.current > 0) {
          const dataUrl = drawBadge(countRef.current)
          if (dataUrl) {
            void window.api.setOverlayBadge(
              dataUrl,
              countRef.current > 1 ? `${countRef.current} 轮回复已完成` : '回复已完成'
            )
          }
        }
      }
      return
    }
    if (document.hasFocus()) return
    if (waitingCount > prev) {
      const dataUrl = drawBadge(waitingCount)
      if (dataUrl) {
        void window.api.setOverlayBadge(
          dataUrl,
          waitingCount > 1 ? `${waitingCount} 项待你处理` : '有提问或授权待你处理'
        )
      }
      void window.api.flashFrame(true)
    }
  }, [waitingCount])

  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = running
    if (!wasRunning || running) return
    // 轮刚结束。前台看着就不打标，顺手清掉旧计数（回到前台也算"已读"）。
    if (document.hasFocus()) {
      countRef.current = 0
      return
    }
    countRef.current += 1
    // 等待提醒优先：有未答问题/授权时不覆盖等待角标（计数照记，等待清空后补画）。
    if (prevWaitingRef.current > 0) return
    const dataUrl = drawBadge(countRef.current)
    if (dataUrl) {
      void window.api.setOverlayBadge(
        dataUrl,
        countRef.current > 1 ? `${countRef.current} 轮回复已完成` : '回复已完成'
      )
    }
  }, [running])
}
