import { app, BrowserWindow, Notification, shell } from 'electron'
import { join } from 'node:path'
import {
  configureWindowsGpuBackend,
  isVulkanBackendActive,
  markGpuBackendWindowReady
} from './gpuBackend'
import { registerIpc } from './ipc'
import { log, scheduleLogMaintenance } from './logger'
import { seedDefaultIfNeeded } from './providers'
import { loadSettings, saveSettings } from './settings'
import { createTray, type ForgeTray } from './tray'
import { checkForUpdates } from './updater'
import type { UpdateCheckResult } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let forgeTray: ForgeTray | null = null
/** Bypass flag: when true the window-close handler lets the app exit instead of
 *  hiding to tray. Set by tray "Quit" and before-quit so a true quit isn't
 *  intercepted. */
let isQuitting = false
/** One-shot bypass for a single close: set by the resolve-close (quit) IPC so
 *  its `win.close()` isn't re-intercepted. Reset right after so a subsequent
 *  close (e.g. after the window is shown again from tray) honors the prompt. */
let skipNextCloseIntercept = false

const WINDOW_BACKGROUND_COLOR = '#05060A'
const WINDOW_FRAME_COLOR = WINDOW_BACKGROUND_COLOR
const RENDERER_DIAGNOSTICS =
  !app.isPackaged || process.env['FORGE_RENDER_DIAGNOSTICS'] === '1'
const AUTO_UPDATE_CHECK_DELAY_MS = 3500
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['FORGE_REMOTE_DEBUG_PORT'] ?? '9223')
}

function isSameDocumentNavigation(currentUrl: string, nextUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextUrl)
    return (
      current.origin === next.origin &&
      current.pathname === next.pathname &&
      current.search === next.search
    )
  } catch {
    return false
  }
}

function shouldOpenExternalNavigation(currentUrl: string, nextUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const next = new URL(nextUrl)
    if (!['http:', 'https:', 'mailto:'].includes(next.protocol)) return false
    if (next.protocol !== 'mailto:' && next.origin === current.origin) return false
    return true
  } catch {
    return false
  }
}

function notifyRendererUpdateAvailable(info: UpdateCheckResult): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send('forge:update-available', info)

  if (!app.isPackaged || !Notification.isSupported()) return
  const notification = new Notification({
    title: 'Forge 有可用更新',
    body: `发现 ${info.latestVersion ?? '新版本'}，点击查看发布页。`,
    silent: false
  })
  notification.on('click', () => {
    if (info.releaseUrl) void shell.openExternal(info.releaseUrl)
    const current = mainWindow
    if (!current || current.isDestroyed()) return
    if (!current.isVisible()) current.show()
    if (current.isMinimized()) current.restore()
    current.focus()
  })
  notification.show()
}

function scheduleAutoUpdateCheck(): void {
  const timer = setTimeout(() => {
    void checkForUpdates().then((info) => {
      if (info.error) {
        log('updater', `check failed: ${info.error}`)
        return
      }
      log('updater', `current=${info.currentVersion} latest=${info.latestVersion ?? '(unknown)'}`)
      if (info.updateAvailable) notifyRendererUpdateAvailable(info)
    })
  }, AUTO_UPDATE_CHECK_DELAY_MS)
  timer.unref?.()
}

/** Read the experimental Vulkan-compositor toggle from the persisted settings
 *  BEFORE the GPU process launches. Chromium on Windows composites via ANGLE
 *  (default D3D11); this opt-in reroutes its OWN compositing through the Vulkan
 *  backend. JS can't call Vulkan directly — this is the correct lever. Read at
 *  module load (pre-ready) so the switch is set before GPU init; missing/corrupt
 *  file → default off (D3D11, the stable choice). */
configureWindowsGpuBackend()
scheduleLogMaintenance()

function showAndFocusMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
  if (process.platform === 'win32') win.moveTop()
}

function createWindow(): void {
  const vulkanBackend = isVulkanBackendActive()
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    transparent: false,
    accentColor: process.platform === 'win32' ? WINDOW_FRAME_COLOR : undefined,
    title: 'Forge',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    hasShadow: true,
    thickFrame: process.platform === 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // Keep timers/rAF running at full rate when the window is occluded, so the
      // stream-batching rAF flush never stalls mid-answer if the user alt-tabs.
      backgroundThrottling: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('unresponsive', () => log('window', 'main window became unresponsive'))
  mainWindow.on('responsive', () => log('window', 'main window became responsive'))

  // Intercept the window close: either hide to tray or prompt on first close.
  // A true quit (tray "退出" / before-quit) sets isQuitting; the resolve-close
  // (quit) IPC sets skipNextCloseIntercept for a single bypass.
  mainWindow.on('close', (event) => {
    if (isQuitting || skipNextCloseIntercept) {
      skipNextCloseIntercept = false
      return
    }
    const s = loadSettings()
    if (s.closePromptDismissed) {
      // User already chose: hide to tray if enabled, else fall through to quit.
      if (s.minimizeToTray) {
        event.preventDefault()
        mainWindow?.hide()
        forgeTray?.setTooltip('Forge — 后台运行中')
      }
      return
    }
    // First close: prevent and ask the renderer how the user wants to proceed.
    event.preventDefault()
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('forge:show-close-prompt')
  })

  if (process.platform === 'win32') {
    mainWindow.setAccentColor(WINDOW_FRAME_COLOR)
    mainWindow.setBackgroundColor(WINDOW_BACKGROUND_COLOR)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    const readyTimer = setTimeout(markGpuBackendWindowReady, vulkanBackend ? 4000 : 0)
    readyTimer.unref?.()
    scheduleAutoUpdateCheck()
  })

  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (!currentUrl || url === currentUrl || isSameDocumentNavigation(currentUrl, url)) return

    event.preventDefault()
    if (shouldOpenExternalNavigation(currentUrl, url)) {
      void shell.openExternal(url)
    } else {
      log('renderer', `blocked in-app navigation: ${url}`)
    }
  })

  if (RENDERER_DIAGNOSTICS) {
    mainWindow.webContents.on('did-start-loading', () => {
      log('renderer', 'did-start-loading')
    })
    mainWindow.webContents.on('dom-ready', () => {
      log('renderer', 'dom-ready')
    })
    mainWindow.webContents.on('did-finish-load', () => {
      log('renderer', 'did-finish-load')
      void mainWindow?.webContents
        .executeJavaScript(
          `({
            href: location.href,
            readyState: document.readyState,
            rootChildren: document.getElementById('root')?.childElementCount ?? -1,
            bodyText: document.body?.innerText?.slice(0, 240) ?? ''
          })`,
          true
        )
        .then((state) => log('renderer', { afterLoad: state }))
        .catch((err) => log('renderer', `after-load probe failed: ${err instanceof Error ? err.message : String(err)}`))
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log('renderer', { didFailLoad: { errorCode, errorDescription, validatedURL, isMainFrame } })
    })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log('renderer', { renderProcessGone: details })
    })
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      log('renderer', `preload-error ${preloadPath}: ${error.message}`)
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      log('renderer-console', { level, message, line, sourceId })
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const url = new URL(devUrl)
    if (vulkanBackend) url.searchParams.set('gpuBackend', 'vulkan')
    void mainWindow.loadURL(url.toString())
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: vulkanBackend ? { gpuBackend: 'vulkan' } : {}
    })
  }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showAndFocusMainWindow()
  })

  app.whenReady().then(() => {
    seedDefaultIfNeeded()
    // Tray is created after the window; pass a getter so registerIpc's closures
    // pick up the live tray (used for tooltip updates on session end).
    registerIpc(
      () => mainWindow,
      () => isQuitting,
      (v) => {
        isQuitting = v
      },
      () => forgeTray,
      () => {
        // One-shot bypass for the next close (the resolve-close "quit" path).
        skipNextCloseIntercept = true
      }
    )
    createWindow()
    forgeTray = createTray(
      () => mainWindow,
      () => {
        isQuitting = true
        app.quit()
      }
    )

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

// When the window is actually destroyed, tear down the tray so no icon lingers.
app.on('window-all-closed', () => {
  forgeTray?.destroy()
  forgeTray = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('gpu-info-update', () => {
  if (app.isPackaged) return
  console.info('[gpu]', {
    hardwareAcceleration: app.isHardwareAccelerationEnabled(),
    features: app.getGPUFeatureStatus()
  })
})
