import { BrowserWindow, screen } from 'electron'
import { log } from './logger'

/**
 * 「AI 正在控制」屏幕遮罩（#67，Codex 同款可视化）。
 *
 * AI 每调一次浏览器/桌面控制工具，屏幕边缘就浮出一圈渐变紫光晕 + 右上角一枚
 * 「AI 控制中」标识；工具调用停歇 800ms 后淡出。用途是人一眼能看出"现在是
 * AI 在开车"——computer-use 类功能最基本的知情提示。
 *
 * 实现要点：
 * - 每块目标显示器一个无边框透明置顶窗口，全程 setIgnoreMouseEvents（点击
 *   完全穿透）——遮罩绝不能挡住用户自己的操作，包括那枚标识。
 * - focusable:false + skipTaskbar：不抢焦点、不进任务栏、不打断输入法。
 * - 停止按钮不做在遮罩里：能接鼠标的遮罩就有挡住用户的风险，中断走 Tran
 *   主窗口既有的打断入口。
 */

const IDLE_HIDE_MS = 800
/** 淡出动画时长，与页面 CSS 的 transition 对齐。 */
const FADE_MS = 220

let overlays: BrowserWindow[] = []
let hideTimer: NodeJS.Timeout | null = null
let visible = false
/** 只在这块显示器上显示（分屏控制模式）；null = 所有显示器。 */
let targetDisplayId: number | null = null

function overlayHtml(): string {
  // 内联页面：遮罩不该为一个静态样式多带一个渲染文件进包。
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif}
  #glow{position:fixed;inset:0;opacity:0;transition:opacity ${FADE_MS}ms ease;
    /* 渐变紫描边光晕（用户指定配色）：内发光在四边最强，中间完全透明，
       不遮挡任何内容。外层再叠一条 1.5px 的渐变紫描边勾出屏幕边界。 */
    box-shadow:inset 0 0 90px 14px rgba(168,85,247,.42),
               inset 0 0 200px 40px rgba(139,92,246,.16);
    border:1.5px solid transparent;
    background:linear-gradient(#0000,#0000) padding-box,
      linear-gradient(135deg,#c084fc,#8b5cf6 45%,#6366f1 100%) border-box}
  #glow.on{opacity:1}
  #pill{position:fixed;top:14px;right:18px;display:flex;align-items:center;gap:7px;
    padding:6px 12px;border-radius:999px;font-size:12px;color:#f5f3ff;
    background:rgba(24,20,34,.82);border:1px solid rgba(192,132,252,.45);
    box-shadow:0 4px 18px rgba(0,0,0,.45);opacity:0;transition:opacity ${FADE_MS}ms ease}
  #pill.on{opacity:1}
  #dot{width:7px;height:7px;border-radius:50%;background:#c084fc;
    animation:pulse 1.25s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
  </style>
  <div id="glow"></div>
  <div id="pill"><span id="dot"></span><span id="label">AI 控制中</span></div>
  <script>
  const { ipcRenderer } = require('electron')
  ipcRenderer.on('overlay:state', (_e, on, label) => {
    document.getElementById('glow').classList.toggle('on', on)
    document.getElementById('pill').classList.toggle('on', on)
    if (label) document.getElementById('label').textContent = label
  })
  </script>`
}

/** 页面加载完之前 webContents.send 是丢的——首次 pulse 常常正好撞上加载中，
 *  于是"AI 只调了一个工具"那次光晕根本没亮过。存下最后一次状态，加载完补发。 */
const pendingState = new WeakMap<BrowserWindow, { on: boolean; label?: string }>()

function sendState(win: BrowserWindow, on: boolean, label?: string): void {
  if (win.isDestroyed()) return
  if (win.webContents.isLoading()) {
    pendingState.set(win, { on, ...(label ? { label } : {}) })
    return
  }
  win.webContents.send('overlay:state', on, label)
}

function createOverlayFor(display: Electron.Display): BrowserWindow | null {
  try {
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      // 遮罩是纯展示层，用 nodeIntegration 换掉一个 preload 文件；它只加载
      // 本地内联 HTML，不接触任何外部内容。
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    })
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.webContents.on('did-finish-load', () => {
      const state = pendingState.get(win)
      if (!state || win.isDestroyed()) return
      pendingState.delete(win)
      win.webContents.send('overlay:state', state.on, state.label)
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`)
    return win
  } catch (error) {
    log('overlay', `创建失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function ensureOverlays(): void {
  if (overlays.length > 0 && overlays.every((w) => !w.isDestroyed())) return
  destroyOverlays()
  const displays = screen.getAllDisplays()
  const targets =
    targetDisplayId === null ? displays : displays.filter((d) => d.id === targetDisplayId)
  overlays = targets
    .map(createOverlayFor)
    .filter((w): w is BrowserWindow => w !== null)
}

function destroyOverlays(): void {
  for (const win of overlays) {
    if (!win.isDestroyed()) win.destroy()
  }
  overlays = []
}

/** 分屏控制：把遮罩限制在划给 AI 的那块屏（null = 全部屏幕）。 */
export function setOverlayTargetDisplay(displayId: number | null): void {
  if (targetDisplayId === displayId) return
  targetDisplayId = displayId
  destroyOverlays()
}

/**
 * 显示器拓扑变了（插拔、改分辨率、改缩放）就把遮罩全推倒重建。
 * 不重建的话窗口还按老 bounds 摆着——新接的屏没有光晕，拔掉的屏留下一个
 * 挂在虚拟桌面外的幽灵窗口。
 */
let screenWatchInstalled = false
function watchDisplayChanges(): void {
  if (screenWatchInstalled) return
  screenWatchInstalled = true
  const rebuild = (): void => {
    destroyOverlays()
    // visible 保持原样：下一次 pulse 会按当前状态把新窗口点亮。
    if (visible) {
      ensureOverlays()
      for (const win of overlays) {
        win.showInactive()
        sendState(win, true)
      }
    }
  }
  screen.on('display-added', rebuild)
  screen.on('display-removed', rebuild)
  screen.on('display-metrics-changed', rebuild)
}

/**
 * 报告一次 AI 控制活动：显示遮罩并把淡出计时重置到 800ms 后。
 * 每个工具调用前后各调一次即可，无需精确配对。
 */
export function pulseControlOverlay(label = 'AI 控制中'): void {
  watchDisplayChanges()
  const hadWindows = overlays.length > 0
  ensureOverlays()
  if (overlays.length === 0) return
  // visible 与「窗口真的显示着」必须一起判断：切分屏目标会把窗口销毁，若只看
  // visible，重建出来的新窗口永远走不到 showInactive，光晕就此哑火。
  if (!visible || !hadWindows) {
    visible = true
    for (const win of overlays) {
      if (win.isDestroyed()) continue
      win.showInactive()
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  }
  for (const win of overlays) sendState(win, true, label)
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(hideControlOverlay, IDLE_HIDE_MS)
  hideTimer.unref?.()
}

function hideControlOverlay(): void {
  hideTimer = null
  visible = false
  for (const win of overlays) sendState(win, false)
  // 等淡出动画跑完再真正隐藏窗口，否则是"啪"地消失。
  const timer = setTimeout(() => {
    for (const win of overlays) {
      if (!win.isDestroyed() && !visible) win.hide()
    }
  }, FADE_MS + 40)
  timer.unref?.()
}

export function stopControlOverlay(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  visible = false
  destroyOverlays()
}
