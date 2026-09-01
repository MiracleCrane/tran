import { app } from 'electron'
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
const NODE_COMMAND = 'node.exe'
const RP_TAVERN_STDOUT_LOG = join(app.getPath('userData'), 'logs', 'rp-tavern.stdout.log')
const RP_TAVERN_STDERR_LOG = join(app.getPath('userData'), 'logs', 'rp-tavern.stderr.log')

function resolveRpTavernTerminalCmd(): string | null {
  const candidates = [
    join(process.resourcesPath, 'tools', 'rp-tavern', 'rp-tavern-terminal.cmd'),
    join(__dirname, '..', '..', '..', 'tools', 'rp-tavern', 'rp-tavern-terminal.cmd')
  ]
  return candidates.find(existsSync) ?? null
}

async function openTavernTui(url: string): Promise<void> {
  const script = resolveRpTavernTerminalCmd()
  if (!script) throw new Error('找不到 RP TUI 启动器；请重新安装最新版 Tran。')
  await new Promise<void>((resolve, reject) => {
    // detached 为交互式 TUI 创建独立可见控制台；call 兼容带空格的安装路径，
    // /c 则保证退出 TUI 后控制台随即关闭，不残留空 cmd。
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'call', script, '--url', url], {
      windowsHide: false,
      detached: true,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const adapter: RpTavernAdapter = {
  configPath: join(app.getPath('userData'), 'rp-tavern.json'),
  installCandidates: [
    DEFAULT_INSTALL_PATH,
    join(homedir(), 'SillyTavern'),
    join(homedir(), 'Documents', 'GitHub', 'SillyTavern')
  ],
  nodePath: NODE_COMMAND,
  exists: existsSync,
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, content) => writeFileSync(path, content, 'utf8'),
  ensureDirectory: (path) => mkdirSync(path, { recursive: true }),
  commandOutput: async (command, args) => {
    const result = await execFileAsync(command, args, { windowsHide: true })
    return result.stdout
  },
  prepareInstallation: async (installPath) => {
    log('rp-tavern', `preparing dependencies cwd=${installPath}`)
    try {
      await execFileAsync(
        COMMAND_PROMPT_PATH,
        [
          '/d',
          '/s',
          '/c',
          'npm install --no-audit --no-fund --loglevel=error --no-progress'
        ],
        { cwd: installPath, windowsHide: true }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('rp-tavern', `dependency preparation failed: ${message}`)
      throw new Error(`SillyTavern 依赖准备失败：${message}`)
    }
    log('rp-tavern', `dependencies ready cwd=${installPath}`)
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
  openClient: openTavernTui
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
