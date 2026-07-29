import { net } from 'electron'
import { log } from './logger'
import { resolveWindowsKimiCommand } from './windowsKimi'
import { spawn } from 'node:child_process'
import type { KimiUpgradeResult } from '../shared/ipc'

/**
 * Kimi Code CLI 的版本检查（与 updater.ts 的 Tran 自更新分开）。
 *
 * 只做「查 + 报」，不自动安装：升级要重装全局 npm 包并重启 ACP 连接，
 * 正在跑的 turn 会断——时机必须由用户定。
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

  const [currentVersion, latestVersion] = await Promise.all([
    probeLocalVersion(),
    fetchLatestVersion()
  ])

  const info: KimiVersionInfo = {
    ...(currentVersion ? { currentVersion } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    updateAvailable: isNewer(latestVersion, currentVersion),
    upgradeCommand: `npm install -g ${NPM_PACKAGE}@latest`,
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

/** 升级超时：全局 npm 安装要拉整包，给足时间。 */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 一键升级 Kimi Code CLI（`npm install -g @moonshot-ai/kimi-code@latest`）。
 *
 * 调用方（ipc.ts）负责在升级前断开所有 ACP 会话——Windows 上正在运行的
 * kimi.exe 会占用文件，npm 覆盖安装会因 EBUSY/EPERM 失败；而且升级后旧连接
 * 指向的是被替换掉的可执行文件。
 */
export function upgradeKimi(): Promise<KimiUpgradeResult> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const done = (result: KimiUpgradeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 升级后本机版本变了，作废缓存，下次检查取真值。
      cache = null
      resolve(result)
    }
    const timer = setTimeout(
      () => done({ ok: false, error: `升级超时（${UPGRADE_TIMEOUT_MS / 60000} 分钟）`, output: output.slice(-4000) }),
      UPGRADE_TIMEOUT_MS
    )

    // Windows 上 npm 是 npm.cmd，必须经 cmd.exe 起（直接 spawn npm 会 ENOENT）。
    const isWindows = process.platform === 'win32'
    const command = isWindows ? 'cmd.exe' : 'npm'
    const args = isWindows
      ? ['/d', '/s', '/c', 'npm', 'install', '-g', `${NPM_PACKAGE}@latest`]
      : ['install', '-g', `${NPM_PACKAGE}@latest`]

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
      // 只留尾部：npm 输出可能很长，全存没意义。
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
        error: `npm 退出码 ${code}。常见原因：权限不足（需管理员）、kimi 正在运行占用文件、网络/镜像不可达。`,
        output: output.slice(-4000)
      })
    })
  })
}
