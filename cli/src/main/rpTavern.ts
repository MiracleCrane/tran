import { app, BrowserWindow, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { log } from './logger'
import {
  RP_TAVERN_URL,
  RpTavernHost,
  type RpTavernAdapter,
  type RpTavernOpenResult,
  type RpTavernStatus
} from './rpTavernHost'

const execFileAsync = promisify(execFile)
const DEFAULT_INSTALL_PATH = 'C:\\LegacyD\\project\\SillyTavern'
const SYSTEM_ROOT = process.env['SystemRoot'] || 'C:\\Windows'
const COMMAND_PROMPT_PATH = process.env['ComSpec'] || join(SYSTEM_ROOT, 'System32', 'cmd.exe')
const RP_TAVERN_STDOUT_LOG = join(app.getPath('userData'), 'logs', 'rp-tavern.stdout.log')
const RP_TAVERN_STDERR_LOG = join(app.getPath('userData'), 'logs', 'rp-tavern.stderr.log')

let tavernWindow: BrowserWindow | null = null

function isLocalTavernUrl(value: string): boolean {
  try {
    return new URL(value).origin === new URL(RP_TAVERN_URL).origin
  } catch {
    return false
  }
}

async function openTavernWindow(url: string): Promise<void> {
  if (tavernWindow && !tavernWindow.isDestroyed()) {
    if (!tavernWindow.isVisible()) tavernWindow.show()
    if (tavernWindow.isMinimized()) tavernWindow.restore()
    tavernWindow.focus()
    return
  }

  const win = new BrowserWindow({
    width: 760,
    height: 940,
    minWidth: 600,
    minHeight: 600,
    title: 'RP Tavern',
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      partition: 'persist:rp-tavern',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  tavernWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (tavernWindow === win) tavernWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (/^https?:/i.test(targetUrl)) void shell.openExternal(targetUrl)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isLocalTavernUrl(targetUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(targetUrl)) void shell.openExternal(targetUrl)
  })
  await win.loadURL(url)
}

const adapter: RpTavernAdapter = {
  configPath: join(app.getPath('userData'), 'rp-tavern.json'),
  installCandidates: [
    DEFAULT_INSTALL_PATH,
    join(homedir(), 'SillyTavern'),
    join(homedir(), 'Documents', 'GitHub', 'SillyTavern')
  ],
  commandPromptPath: COMMAND_PROMPT_PATH,
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, content) => writeFileSync(path, content, 'utf8'),
  ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
  commandOutput: async (command, args) => {
    const result = await execFileAsync(command, args, { windowsHide: true })
    return result.stdout
  },
  spawnDetached: (command, args, cwd) =>
    new Promise<void>((resolve, reject) => {
      mkdirSync(dirname(RP_TAVERN_STDOUT_LOG), { recursive: true })
      const stdoutFd = openSync(RP_TAVERN_STDOUT_LOG, 'a')
      const stderrFd = openSync(RP_TAVERN_STDERR_LOG, 'a')
      const closeParentLogHandles = (): void => {
        closeSync(stdoutFd)
        closeSync(stderrFd)
      }
      let child
      try {
        child = spawn(command, args, {
          cwd,
          detached: true,
          stdio: ['ignore', stdoutFd, stderrFd],
          windowsHide: true
        })
      } catch (error) {
        closeParentLogHandles()
        reject(error)
        return
      }
      child.once('error', (error) => {
        closeParentLogHandles()
        log('rp-tavern', `spawn failed command=${command}: ${error.message}`)
        reject(new Error(`无法启动 RP 服务进程：${error.message}`))
      })
      child.once('spawn', () => {
        closeParentLogHandles()
        child.unref()
        log(
          'rp-tavern',
          `spawned command=${command} cwd=${cwd} stdout=${RP_TAVERN_STDOUT_LOG} stderr=${RP_TAVERN_STDERR_LOG}`
        )
        resolve()
      })
    }),
  checkUrl: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  },
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  openWindow: openTavernWindow
}

const host = new RpTavernHost(adapter)

export async function getRpTavernStatus(): Promise<RpTavernStatus> {
  return await host.getStatus()
}

export async function configureRpTavern(installPath: string): Promise<RpTavernStatus> {
  return await host.configure(installPath)
}

export async function openRpTavern(): Promise<RpTavernOpenResult> {
  return await host.open()
}
