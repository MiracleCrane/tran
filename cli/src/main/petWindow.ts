import { BrowserWindow, Menu, app, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { getPreferences } from './preferences'
import type { PetMood, PetState, Preferences } from '../shared/ipc'

/**
 * 桌面宠物（Codex Pets 的 Tran 版）：透明、无边框、置顶的悬浮小窗，
 * 里面是魔性摇摆猫的动画，气泡跟着 agent 状态走（干活/等你回话/搞定/出错）。
 *
 * 这是「Tran 以外」的展示位（设置里可单独关）；Tran 界面内的舞动形象是
 * 渲染层的 PetMascot 组件，与本窗口互不影响，两边共用同一份状态推送。
 *
 * 实现要点：
 * - 窗口配置照抄 controlOverlay 那套（transparent + skipTaskbar +
 *   backgroundThrottling:false），但不能 setIgnoreMouseEvents——宠物要
 *   支持拖拽换位和右键菜单。focusable:false 不抢焦点。
 * - 拖拽：pointermove → 渲染层 rAF 合帧 → movementX/Y 增量 IPC → 主进程
 *   setPosition。-webkit-app-region:drag 在透明窗口上不生效（Chromium
 *   限制），主进程 60Hz 轮询 setPosition 会冻死应用（2026-08-20 实测），
 *   事件驱动 + 合帧是实测可行的唯一组合。位置落盘靠 'move' 事件防抖 +
 *   drag-end 立即落盘（'moved' 是 macOS 限定事件，Windows 不发）。
 * - 页面加载完之前 webContents.send 会丢，lastState 缓存 + did-finish-load
 *   补发（同 controlOverlay 的 pendingState 思路）。
 * - 位置持久化在 settings.petPosition；启动时校验落在某块屏内，防拔副屏后
 *   宠物挂在虚拟桌面外回不来。
 */

/** 2026-08-20 用户：「再搞小一号」——从 150x230 缩到 115x176。 */
const PET_WIDTH = 115
const PET_HEIGHT = 176
/** 与屏幕右/下边缘的默认间距（无历史位置时落右下角）。 */
const EDGE_MARGIN = 48
const MOVE_SAVE_DEBOUNCE_MS = 500
const LABEL_MAX_LEN = 50

const MOODS: ReadonlySet<string> = new Set(['idle', 'working', 'waiting', 'done', 'error'])

let petWindow: BrowserWindow | null = null
let lastState: PetState = { mood: 'idle' }
let moveSaveTimer: NodeJS.Timeout | null = null
let ipcRegistered = false
/** index.ts 注入的主窗口显示回调（右键菜单「显示 Tran」用）。 */
let showMainWindow: (() => void) | null = null
/** index.ts 注入的偏好变更通知（右键菜单「隐藏宠物」后同步渲染层镜像）。 */
let notifyPrefsChanged: ((prefs: Preferences) => void) | null = null

function sanitizeState(state: unknown): PetState {
  const raw = state && typeof state === 'object' ? (state as Record<string, unknown>) : {}
  const mood = MOODS.has(raw.mood as string) ? (raw.mood as PetMood) : 'idle'
  const label =
    typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, LABEL_MAX_LEN)
      : undefined
  return label ? { mood, label } : { mood }
}

/** 悬浮窗是否应该存在：总开关 && 「Tran 以外展示」开关。 */
function shouldFloat(): boolean {
  const s = loadSettings()
  return s.desktopPetEnabled !== false && s.petOutsideEnabled !== false
}

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - PET_WIDTH - EDGE_MARGIN,
    y: area.y + area.height - PET_HEIGHT - EDGE_MARGIN
  }
}

/** 读历史位置；落在所有显示器可视范围之外（拔过副屏）就当没有。 */
function savedPosition(): { x: number; y: number } | null {
  const pos = loadSettings().petPosition
  if (!pos) return null
  const onSomeDisplay = screen.getAllDisplays().some((d) => {
    const b = d.workArea
    return (
      pos.x >= b.x - PET_WIDTH / 2 &&
      pos.x <= b.x + b.width - PET_WIDTH / 2 &&
      pos.y >= b.y &&
      pos.y <= b.y + b.height - PET_HEIGHT / 2
    )
  })
  return onSomeDisplay ? pos : null
}

function scheduleSavePosition(win: BrowserWindow, debounceMs = MOVE_SAVE_DEBOUNCE_MS): void {
  if (moveSaveTimer) clearTimeout(moveSaveTimer)
  moveSaveTimer = setTimeout(() => {
    moveSaveTimer = null
    if (win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const s = loadSettings()
    s.petPosition = { x, y }
    saveSettings(s)
  }, debounceMs)
  moveSaveTimer.unref?.()
}

function sendState(win: BrowserWindow, state: PetState): void {
  if (win.isDestroyed()) return
  if (win.webContents.isLoading()) return // did-finish-load 会补发 lastState
  win.webContents.send('pet:state', state)
}

function buildContextMenu(win: BrowserWindow): Menu {
  return Menu.buildFromTemplate([
    {
      label: '显示 Tran',
      click: () => showMainWindow?.()
    },
    {
      label: '隐藏宠物',
      click: () => setPetEnabled(false)
    },
    {
      label: '退出 Tran',
      click: () => app.quit()
    }
  ])
}

function createPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) return
  const pos = savedPosition() ?? defaultPosition()
  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/pet.js'),
      contextIsolation: true,
      sandbox: true,
      // 宠物是纯动画窗口，被遮挡时 Chromium 降帧会让摇摆肉眼可见地卡。
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 'move' 在拖动过程中连续触发（'moved' 是 macOS 限定事件，Windows 上
  // 根本不会发——曾因此拖完位置不落盘），落盘走防抖。
  win.on('move', () => scheduleSavePosition(win))
  win.on('closed', () => {
    petWindow = null
  })
  win.webContents.on('did-finish-load', () => {
    sendState(win, lastState)
    win.showInactive()
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}/pet.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/pet.html'))
  }
  petWindow = win
}

function destroyPetWindow(): void {
  if (moveSaveTimer) {
    clearTimeout(moveSaveTimer)
    moveSaveTimer = null
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy()
  petWindow = null
}

/** 渲染层（主窗口）上报的宠物状态：缓存 + 转发。 */
export function updatePetState(state: unknown): void {
  lastState = sanitizeState(state)
  if (petWindow) sendState(petWindow, lastState)
}

/** 按当前两个开关的组合创建/销毁悬浮窗（总开关、外部展示开关变更后统一走这）。 */
export function applyPetWindowPrefs(): void {
  if (shouldFloat()) createPetWindow()
  else destroyPetWindow()
}

/** 总开关：持久化 + 应用（右键菜单「隐藏宠物」也走这）。 */
export function setPetEnabled(enabled: boolean): void {
  const s = loadSettings()
  s.desktopPetEnabled = enabled
  saveSettings(s)
  applyPetWindowPrefs()
  // 主进程侧的变更也要告诉渲染层（petStore 镜像、界面内形象显隐）。
  notifyPrefsChanged?.(getPreferences())
}

/**
 * 启动初始化：注册 IPC（一次性），并按设置决定是否开窗。
 * @param onShowMainWindow 右键菜单「显示 Tran」的回调（index.ts 注入，
 *   避免 petWindow → index 的反向依赖）。
 */
export function initPetWindow(
  onShowMainWindow: () => void,
  onPrefsChanged?: (prefs: Preferences) => void
): void {
  showMainWindow = onShowMainWindow
  notifyPrefsChanged = onPrefsChanged ?? null
  if (!ipcRegistered) {
    ipcRegistered = true
    ipcMain.on('pet:set-state', (_e, state: unknown) => updatePetState(state))
    // 拖拽：渲染层按 rAF 合帧上报 movementX/Y 增量，主进程逐条 setPosition。
    // 注意 -webkit-app-region:drag 在透明窗口上不生效（Chromium 限制），
    // 主进程 60Hz 轮询 setPosition 会把应用冻死——事件驱动是唯一出路。
    ipcMain.on('pet:drag-delta', (_e, delta: unknown) => {
      const win = petWindow
      if (!win || win.isDestroyed()) return
      const d = delta && typeof delta === 'object' ? (delta as Record<string, unknown>) : null
      if (typeof d?.dx !== 'number' || typeof d?.dy !== 'number') return
      const [x, y] = win.getPosition()
      win.setPosition(Math.round(x + d.dx), Math.round(y + d.dy))
    })
    ipcMain.on('pet:drag-end', () => {
      if (petWindow && !petWindow.isDestroyed()) scheduleSavePosition(petWindow, 0)
    })
    ipcMain.on('pet:context-menu', () => {
      const win = petWindow
      if (!win || win.isDestroyed()) return
      buildContextMenu(win).popup({ window: win })
    })
  }
  applyPetWindowPrefs()
}

/** 应用退出前调用（before-quit），确保宠物窗口不拦住退出。 */
export function shutdownPetWindow(): void {
  destroyPetWindow()
}
