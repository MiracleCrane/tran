import { dirname, join, normalize } from 'node:path'

export const RP_TAVERN_URL = 'http://127.0.0.1:8000/'
export const RP_TAVERN_ROUTER_HEALTH_URL = 'http://127.0.0.1:4001/health/readiness'

export interface RpTavernStatus {
  installPath: string | null
  installed: boolean
  running: boolean
  version: string | null
  nodeVersion: string | null
  nodeCompatible: boolean
  autoRouterReady: boolean
  issues: string[]
}

export interface RpTavernOpenResult {
  ok: boolean
  status: RpTavernStatus
  error?: string
}

/**
 * 系统调用集中在 Adapter 之后，主流程因此可测试，也便于未来替换为容器或远程酒馆。
 */
export interface RpTavernAdapter {
  configPath: string
  installCandidates: string[]
  bridgeLauncherPath: string | null
  bridgeInstallPath: string | null
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, content: string): void
  ensureDirectory(path: string): void
  commandOutput(command: string, args: string[]): Promise<string>
  spawnDetached(command: string, args: string[], cwd: string): void
  checkUrl(url: string): Promise<boolean>
  delay(ms: number): Promise<void>
  openWindow(url: string): Promise<void>
}

interface RpTavernConfig {
  installPath?: string
}

interface RpTavernHostOptions {
  readinessAttempts?: number
  readinessIntervalMs?: number
}

function normalizeInstallPath(value: string): string {
  return normalize(value.trim().replace(/^['"]|['"]$/g, ''))
}

function majorVersion(value: string | null): number | null {
  if (!value) return null
  const match = value.match(/v?(\d+)/)
  return match ? Number(match[1]) : null
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of paths) {
    if (!raw?.trim()) continue
    const path = normalizeInstallPath(raw)
    const key = path.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(path)
  }
  return result
}

export class RpTavernHost {
  private configuredPath: string | null = null
  private readonly readinessAttempts: number
  private readonly readinessIntervalMs: number

  constructor(
    private readonly adapter: RpTavernAdapter,
    options: RpTavernHostOptions = {}
  ) {
    this.readinessAttempts = options.readinessAttempts ?? 90
    this.readinessIntervalMs = options.readinessIntervalMs ?? 1000
  }

  async getStatus(): Promise<RpTavernStatus> {
    const installPath = this.resolveInstallPath()
    const installed = installPath !== null && this.isInstallation(installPath)
    let version: string | null = null
    let nodeVersion: string | null = null
    const issues: string[] = []

    if (installed && installPath) {
      try {
        const packageJson = JSON.parse(this.adapter.readText(join(installPath, 'package.json'))) as {
          version?: unknown
        }
        version = typeof packageJson.version === 'string' ? packageJson.version : null
      } catch {
        issues.push('无法读取 SillyTavern 版本信息。')
      }
    } else {
      issues.push('尚未找到有效的 SillyTavern 目录。')
    }

    try {
      nodeVersion = (await this.adapter.commandOutput('node', ['--version'])).trim() || null
    } catch {
      issues.push('没有在 PATH 中找到 Node.js。')
    }
    const nodeCompatible = (majorVersion(nodeVersion) ?? 0) >= 20
    if (nodeVersion && !nodeCompatible) issues.push('SillyTavern 需要 Node.js 20 或更高版本。')

    const [running, autoRouterReady] = await Promise.all([
      this.adapter.checkUrl(RP_TAVERN_URL),
      this.adapter.checkUrl(RP_TAVERN_ROUTER_HEALTH_URL)
    ])

    return {
      installPath,
      installed,
      running,
      version,
      nodeVersion,
      nodeCompatible,
      autoRouterReady,
      issues
    }
  }

  async configure(installPath: string): Promise<RpTavernStatus> {
    const normalizedPath = normalizeInstallPath(installPath)
    this.configuredPath = normalizedPath
    if (this.isInstallation(normalizedPath)) {
      this.adapter.ensureDirectory(dirname(this.adapter.configPath))
      this.adapter.writeText(
        this.adapter.configPath,
        `${JSON.stringify({ installPath: normalizedPath } satisfies RpTavernConfig, null, 2)}\n`
      )
    }
    return await this.getStatus()
  }

  async open(): Promise<RpTavernOpenResult> {
    let status = await this.getStatus()
    if (!status.installed || !status.installPath) {
      return { ok: false, status, error: '请先选择有效的 SillyTavern 安装目录。' }
    }
    if (!status.nodeCompatible) {
      return { ok: false, status, error: '请先安装 Node.js 20 或更高版本。' }
    }

    if (!status.running) {
      try {
        this.startServices(status.installPath)
      } catch (error) {
        return {
          ok: false,
          status,
          error: error instanceof Error ? error.message : String(error)
        }
      }

      for (let attempt = 0; attempt < this.readinessAttempts; attempt += 1) {
        await this.adapter.delay(this.readinessIntervalMs)
        if (await this.adapter.checkUrl(RP_TAVERN_URL)) break
      }
      status = await this.getStatus()
      if (!status.running) {
        return { ok: false, status, error: 'SillyTavern 启动超时，请查看其启动日志。' }
      }
    }

    await this.adapter.openWindow(RP_TAVERN_URL)
    return { ok: true, status }
  }

  private resolveInstallPath(): string | null {
    if (this.configuredPath) return normalizeInstallPath(this.configuredPath)
    const storedPath = this.readStoredPath()
    const candidates = uniquePaths([
      storedPath,
      ...this.adapter.installCandidates
    ])
    return candidates.find((path) => this.isInstallation(path)) ?? candidates[0] ?? null
  }

  private readStoredPath(): string | null {
    if (!this.adapter.exists(this.adapter.configPath)) return null
    try {
      const config = JSON.parse(this.adapter.readText(this.adapter.configPath)) as RpTavernConfig
      return typeof config.installPath === 'string' ? config.installPath : null
    } catch {
      return null
    }
  }

  private isInstallation(path: string): boolean {
    return (
      this.adapter.exists(join(path, 'server.js')) &&
      this.adapter.exists(join(path, 'Start.bat')) &&
      this.adapter.exists(join(path, 'package.json'))
    )
  }

  private startServices(installPath: string): void {
    const bridgeLauncher = this.adapter.bridgeLauncherPath
    const bridgeInstallPath = this.adapter.bridgeInstallPath
    if (
      bridgeLauncher &&
      bridgeInstallPath &&
      normalizeInstallPath(bridgeInstallPath).toLocaleLowerCase() ===
        normalizeInstallPath(installPath).toLocaleLowerCase() &&
      this.adapter.exists(bridgeLauncher)
    ) {
      this.adapter.spawnDetached(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgeLauncher, '-NoBrowser'],
        dirname(bridgeLauncher)
      )
      return
    }
    this.adapter.spawnDetached(
      'cmd.exe',
      ['/d', '/s', '/c', `"${join(installPath, 'Start.bat')}" --no-browserLaunchEnabled`],
      installPath
    )
  }
}
