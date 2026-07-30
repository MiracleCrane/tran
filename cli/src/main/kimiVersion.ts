import { net } from 'electron'
import { log } from './logger'
import { resolveWindowsKimiCommand } from './windowsKimi'
import { spawn } from 'node:child_process'
import type { KimiInstallMethod, KimiUpgradeResult } from '../shared/ipc'

/**
 * Kimi Code CLI 的版本检查与升级（与 updater.ts 的 Tran 自更新分开）。
 *
 * 升级不自动触发，只由用户在设置页点按钮：安装会替换正在运行的可执行文件、
 * 并让现存 ACP 连接指向旧文件，正在跑的 turn 必须先断——时机得由用户定。
 * 调用方（ipc.ts）负责先 bridge.shutdown()。
 */

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@moonshot-ai/kimi-code/latest'
const NPM_PACKAGE = '@moonshot-ai/kimi-code'
const CHECK_TIMEOUT_MS = 12000
const LOCAL_PROBE_TIMEOUT_MS = 15000
/** 结果缓存：注册表查询没必要每次面板打开都打一遍。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface KimiVersionInfo {
  /** 本机安装的版本；探测失败为 undefined。 */
  currentVersion?: string
  /** npm 上的最新版；查询失败为 undefined。 */
  latestVersion?: string
  updateAvailable: boolean
  /** 用户可自行执行的升级命令。 */
  upgradeCommand: string
  /** 安装方式（决定升级手段）。 */
  installMethod?: KimiInstallMethod
  /** 探测到的可执行文件路径（认不出安装方式时反馈用）。 */
  installPath?: string
  error?: string
  checkedAt: number
}

let cache: KimiVersionInfo | null = null

/** 取 major.minor.patch 三段数字。与 updater.normalizeVersion 同规则。 */
function normalize(version: string | undefined): number[] {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

function isNewer(latest: string | undefined, current: string | undefined): boolean {
  if (!latest || !current) return false
  const a = normalize(latest)
  const b = normalize(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** 从 `kimi --version` 的输出里抠版本号（输出可能带前后缀）。 */
function parseLocalVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1]
}

function probeLocalVersion(): Promise<string | undefined> {
  return resolveWindowsKimiCommand()
    .then(
      (resolved) =>
        new Promise<string | undefined>((resolve) => {
          let settled = false
          let out = ''
          const done = (value: string | undefined): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
          }
          const timer = setTimeout(() => done(undefined), LOCAL_PROBE_TIMEOUT_MS)
          try {
            const child = spawn(resolved.command, [...resolved.argsPrefix, '--version'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true
            })
            child.stdout.on('data', (c: Buffer) => {
              out += c.toString()
            })
            child.stderr.on('data', (c: Buffer) => {
              out += c.toString()
            })
            child.on('error', () => done(undefined))
            child.on('close', () => done(parseLocalVersion(out)))
          } catch {
            done(undefined)
          }
        })
    )
    .catch(() => undefined)
}

async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    // net.fetch 走 Chromium 网络栈，自动遵循系统代理（同 updater.ts）。
    const response = await net.fetch(REGISTRY_LATEST_URL, { signal: controller.signal })
    if (!response.ok) {
      log('kimi-version', `registry 查询失败: ${response.status}`)
      return undefined
    }
    const data = (await response.json()) as { version?: unknown }
    return typeof data.version === 'string' ? data.version : undefined
  } catch (error) {
    log('kimi-version', `registry 查询异常: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export async function checkKimiVersion(force = false): Promise<KimiVersionInfo> {
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) return cache

  const [currentVersion, latestVersion, install] = await Promise.all([
    probeLocalVersion(),
    fetchLatestVersion(),
    detectInstallMethod()
  ])

  // 展示给用户复制的命令必须与安装方式一致：国内多用官方安装脚本
  // （落在 ~/.kimi-code/bin），给 npm 命令会装出第二份互相打架。
  const upgradeCommand =
    install.method === 'installer'
      ? `irm ${INSTALL_SCRIPT_URL} | iex`
      : `npm install -g ${NPM_PACKAGE}@latest`

  const info: KimiVersionInfo = {
    ...(currentVersion ? { currentVersion } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    updateAvailable: isNewer(latestVersion, currentVersion),
    upgradeCommand,
    installMethod: install.method,
    installPath: install.path,
    checkedAt: Date.now()
  }
  if (!currentVersion) info.error = '未能探测到本机 Kimi Code 版本（kimi 不在 PATH？）'
  else if (!latestVersion) info.error = '未能查询 npm 最新版本（网络或代理问题）'

  cache = info
  log(
    'kimi-version',
    `本机=${currentVersion ?? '未知'} 最新=${latestVersion ?? '未知'} 需更新=${info.updateAvailable}`
  )
  return info
}

/** 升级超时：无论哪种方式都要拉整包，给足时间。 */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000

/** 官方安装脚本（国内安装方式；npm 包只是另一条发行渠道）。 */
const INSTALL_SCRIPT_URL = 'https://code.kimi.com/kimi-code/install.ps1'

/**
 * 判断本机是怎么装的 —— 升级方式完全不同，认错了会装出第二份互相打架。
 *
 * - installer：`irm https://code.kimi.com/kimi-code/install.ps1 | iex`
 *   落点是 %USERPROFILE%\.kimi-code\bin\（README 里的回退路径就是它）
 * - npm：全局安装，落在 %APPDATA%\npm 或 node 的 prefix 下
 *
 * 注意 CLI 自身**没有** upgrade/update 子命令（0.30.0 实测命令列表只有
 * export/provider/acp/web/server/login/doctor/vis），所以两条路都得靠外部手段。
 */
export async function detectInstallMethod(): Promise<{ method: KimiInstallMethod; path: string }> {
  const resolved = await resolveWindowsKimiCommand()
  const path = resolved.displayPath
  const lower = path.replace(/\\/g, '/').toLowerCase()
  if (lower.includes('/.kimi-code/bin/')) return { method: 'installer', path }
  if (lower.includes('/npm/') || lower.includes('/node_modules/')) return { method: 'npm', path }
  return { method: 'unknown', path }
}

function runUpgradeCommand(command: string, args: string[]): Promise<KimiUpgradeResult> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const done = (result: KimiUpgradeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cache = null // 版本变了，作废缓存
      resolve(result)
    }
    const timer = setTimeout(
      () => done({ ok: false, error: `升级超时（${UPGRADE_TIMEOUT_MS / 60000} 分钟）`, output: output.slice(-4000) }),
      UPGRADE_TIMEOUT_MS
    )
    log('kimi-version', `开始升级：${command} ${args.join(' ')}`)
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.length > 64 * 1024) output = output.slice(-64 * 1024)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => done({ ok: false, error: error.message, output: output.slice(-4000) }))
    child.on('close', (code) => {
      if (code === 0) {
        log('kimi-version', '升级成功')
        done({ ok: true, output: output.slice(-4000) })
        return
      }
      done({
        ok: false,
        error: `退出码 ${code}。常见原因：权限不足、kimi 正在运行占用文件、网络/代理不可达。`,
        output: output.slice(-4000)
      })
    })
  })
}

/**
 * 一键升级 Kimi Code CLI —— 按安装方式分流。
 *
 * 调用方（ipc.ts）负责先断开所有 ACP 会话：Windows 上正在运行的 kimi 会占用
 * 可执行文件，覆盖安装必然 EBUSY/EPERM。
 */
export async function upgradeKimi(): Promise<KimiUpgradeResult> {
  const { method, path } = await detectInstallMethod()

  if (method === 'installer') {
    // 官方脚本是幂等的安装器，重跑即升级（CLI 没有 upgrade 子命令）。
    return runUpgradeCommand('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `irm ${INSTALL_SCRIPT_URL} | iex`
    ])
  }

  if (method === 'npm') {
    const isWindows = process.platform === 'win32'
    return isWindows
      ? runUpgradeCommand('cmd.exe', ['/d', '/s', '/c', 'npm', 'install', '-g', `${NPM_PACKAGE}@latest`])
      : runUpgradeCommand('npm', ['install', '-g', `${NPM_PACKAGE}@latest`])
  }

  // 认不出来就不动手：猜错会装出第二份，与现有安装互相覆盖。
  return {
    ok: false,
    error: `无法判断安装方式（kimi 位于 ${path}）。请手动升级，或把该路径反馈给我们以便适配。`
  }
}
