import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import {
  configureWindowsGpuBackend,
  isVulkanBackendActive,
  markGpuBackendWindowReady
} from './gpuBackend'
import { registerIpc } from './ipc'
import { log } from './logger'
import { seedDefaultIfNeeded } from './providers'

let mainWindow: BrowserWindow | null = null

const WINDOW_BACKGROUND_COLOR = '#05060A'
const WINDOW_FRAME_COLOR = WINDOW_BACKGROUND_COLOR
const RENDERER_DIAGNOSTICS =
  !app.isPackaged || process.env['FORGE_RENDER_DIAGNOSTICS'] === '1'

if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env['FORGE_REMOTE_DEBUG_PORT'] ?? '9223')
}

/** Read the experimental Vulkan-compositor toggle from the persisted settings
 *  BEFORE the GPU process launches. Chromium on Windows composites via ANGLE
 *  (default D3D11); this opt-in reroutes its OWN compositing through the Vulkan
 *  backend. JS can't call Vulkan directly — this is the correct lever. Read at
 *  module load (pre-ready) so the switch is set before GPU init; missing/corrupt
 *  file → default off (D3D11, the stable choice). */
configureWindowsGpuBackend()

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

  if (process.platform === 'win32') {
    mainWindow.setAccentColor(WINDOW_FRAME_COLOR)
    mainWindow.setBackgroundColor(WINDOW_BACKGROUND_COLOR)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    const readyTimer = setTimeout(markGpuBackendWindowReady, vulkanBackend ? 4000 : 0)
    readyTimer.unref?.()
  })

  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
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

app.whenReady().then(() => {
  seedDefaultIfNeeded()
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('gpu-info-update', () => {
  if (app.isPackaged) return
  console.info('[gpu]', {
    hardwareAcceleration: app.isHardwareAccelerationEnabled(),
    features: app.getGPUFeatureStatus()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
