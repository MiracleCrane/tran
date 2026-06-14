import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { seedDefaultIfNeeded } from './providers'

let mainWindow: BrowserWindow | null = null

const WINDOW_ACCENT_COLOR = '#DF765F'
const WINDOW_BACKGROUND_COLOR = '#00000000'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    transparent: true,
    accentColor: process.platform === 'win32' ? WINDOW_ACCENT_COLOR : undefined,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    title: 'Forge',
    show: false,
    autoHideMenuBar: true,
    frame: false,
    hasShadow: false,
    thickFrame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (process.platform === 'win32') {
    mainWindow.setAccentColor(WINDOW_ACCENT_COLOR)
    mainWindow.setBackgroundMaterial('none')
    mainWindow.setBackgroundColor(WINDOW_BACKGROUND_COLOR)
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
