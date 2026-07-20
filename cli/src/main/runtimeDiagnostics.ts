import { app } from 'electron'
import { arch, hostname, platform, release } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { currentAgentBackend, getPreferences } from './preferences'
import { getSettingsSnapshot, replaceSettingsSnapshot } from './settings'
import { AGENT_BACKENDS } from '../shared/agentBackends'
import { DEFAULT_KIMI_MODEL_ID } from '../shared/models'
import { resolveWindowsKimiCommand } from './windowsKimi'
import { readRecentLog } from './logger'
import type {
  DiagnosticReportOptions,
  HealthCheckItem,
  RuntimeStatus,
  RuntimeStatusOptions,
  SettingsBackup,
  WslHealthReport
} from '../shared/ipc'

interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  status: number | null
  error?: string
}

interface RuntimeProbe {
  version?: string
  path?: string
  error?: string
  checkedAt: number
}

const RUNTIME_PROBE_TTL_MS = 60_000
const runtimeProbeCache = new Map<string, RuntimeProbe>()
const runtimeProbeInflight = new Map<string, Promise<RuntimeProbe>>()

function cleanOutput(value: string | Buffer | undefined): string {
  return String(value ?? '').replace(/\0/g, '').trim()
}

function run(command: string, args: string[], timeoutMs = 10000): CommandResult {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true
    })
    const stdout = cleanOutput(result.stdout)
    const stderr = cleanOutput(result.stderr)
    const error = result.error instanceof Error ? result.error.message : undefined
    return {
      ok: !error && result.status === 0,
      stdout,
      stderr,
      status: result.status,
      ...(error ? { error } : {})
    }
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      status: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function runAsync(command: string, args: string[], timeoutMs = 10000): Promise<CommandResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = (result: CommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        child.kill()
        finish({
          ok: false,
          stdout: cleanOutput(stdout),
          stderr: cleanOutput(stderr),
          status: null,
          error: `timed out after ${timeoutMs}ms`
        })
      }, timeoutMs)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        finish({
          ok: false,
          stdout: cleanOutput(stdout),
          stderr: cleanOutput(stderr),
          status: null,
          error: error.message
        })
      })
      child.on('close', (code) => {
        finish({
          ok: code === 0,
          stdout: cleanOutput(stdout),
          stderr: cleanOutput(stderr),
          status: code
        })
      })
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        status: null,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

function resultDetail(result: CommandResult): string {
  return result.stdout || result.stderr || result.error || `exit code ${result.status ?? 'unknown'}`
}

function parseVersionProbe(result: CommandResult): {
  version?: string
  path?: string
  error?: string
} {
  if (!result.ok) return { error: resultDetail(result) }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const path = lines.find((line) => /[\\/]/.test(line))
  const version = [...lines].reverse().find((line) => !/[\\/]/.test(line)) ?? lines[0]
  return {
    ...(version ? { version } : {}),
    ...(path ? { path } : {})
  }
}

async function probeWindowsKimiAsync(): Promise<RuntimeProbe> {
  const resolved = resolveWindowsKimiCommand()
  const version = await runAsync(resolved.command, [...resolved.argsPrefix, '--version'], 15000)
  const parsed = parseVersionProbe(version)
  return {
    ...parsed,
    path: resolved.displayPath,
    checkedAt: Date.now()
  }
}

async function runtimeProbe(
  agentBackend: ReturnType<typeof currentAgentBackend>,
  refresh: boolean
): Promise<RuntimeProbe | undefined> {
  const cacheKey = agentBackend
  const cached = runtimeProbeCache.get(cacheKey)
  if (!refresh) return cached
  if (cached && Date.now() - cached.checkedAt < RUNTIME_PROBE_TTL_MS) return cached

  const inflight = runtimeProbeInflight.get(cacheKey)
  if (inflight) return inflight

  const probe = probeWindowsKimiAsync()
    .then((next) => {
      runtimeProbeCache.set(cacheKey, next)
      return next
    })
    .finally(() => runtimeProbeInflight.delete(cacheKey))
  runtimeProbeInflight.set(cacheKey, probe)
  return probe
}

export async function getRuntimeStatus(
  _cwd?: string,
  modelOverride?: string,
  options: RuntimeStatusOptions = {}
): Promise<RuntimeStatus> {
  const agentBackend = currentAgentBackend()
  const agent = AGENT_BACKENDS.find((item) => item.id === agentBackend) ?? AGENT_BACKENDS[0]
  const probe = await runtimeProbe(agentBackend, options.refreshProbe === true)
  return {
    agentBackend,
    agentName: agent.name,
    ...(probe?.version ? { agentVersion: probe.version } : {}),
    ...(probe?.path ? { agentPath: probe.path } : {}),
    backend: 'windows',
    provider: null,
    model: modelOverride || DEFAULT_KIMI_MODEL_ID,
    ...(probe?.error ? { versionError: probe.error } : {}),
    checkedAt: probe?.checkedAt ?? Date.now()
  }
}

/** WSL 支持已随旧后端移除。保留 IPC 形状（WslHealthPanel 入口已隐藏），
 *  直接返回一份“不可用”报告。 */
export function runWslHealthCheck(cwd: string): WslHealthReport {
  const checks: HealthCheckItem[] = [
    {
      id: 'wsl-removed',
      label: 'WSL support',
      state: 'fail',
      detail: 'Tran 已移除 WSL 运行环境（当前只有 Windows 版 Kimi 后端）。'
    }
  ]
  return {
    checkedAt: Date.now(),
    cwd,
    checks,
    diagnostics: 'WSL support was removed from Tran.'
  }
}

export function repairWslEnvironment(cwd: string): WslHealthReport {
  return runWslHealthCheck(cwd)
}

export function getDiagnosticLog(): string {
  return readRecentLog(220)
}

function isSecretKey(key: string): boolean {
  return /(^|[_-])(token|secret|password)([_-]|$)/i.test(key) ||
    /api[_-]?key/i.test(key) ||
    /(keyEnc|keyPlain|secretEnc|secretPlain)$/i.test(key)
}

function redactSecrets(value: unknown, key = ''): unknown {
  if (isSecretKey(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactSecrets(childValue, childKey)
  }
  return out
}

function jsonBlock(value: unknown): string {
  return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`
}

function textBlock(value: string): string {
  return `\n\`\`\`text\n${value || '(empty)'}\n\`\`\`\n`
}

export async function buildDiagnosticReport(
  options: DiagnosticReportOptions = {}
): Promise<string> {
  const prefs = getPreferences()
  const runtime = await getRuntimeStatus(options.cwd, undefined, { refreshProbe: true })
  const settings = redactSecrets(getSettingsSnapshot())
  const diagnosticLog = getDiagnosticLog()

  return [
    '# Tran Diagnostic Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## App',
    jsonBlock({
      version: app.getVersion(),
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      cwd: process.cwd()
    }),
    '## System',
    jsonBlock({
      platform: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }),
    '## Current Project',
    jsonBlock({
      cwd: options.cwd ?? null
    }),
    '## Preferences',
    jsonBlock(redactSecrets(prefs)),
    '## Appearance',
    jsonBlock(redactSecrets(options.appearance ?? null)),
    '## Runtime Status',
    jsonBlock(redactSecrets(runtime)),
    '## Settings Snapshot',
    jsonBlock(settings),
    '',
    '## Recent Main Log',
    textBlock(diagnosticLog),
    ''
  ].join('\n')
}

export function exportSettings(appearance?: Record<string, unknown>): SettingsBackup {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: getSettingsSnapshot(),
    ...(appearance ? { appearance } : {})
  }
}

export function importSettings(backup: SettingsBackup): void {
  if (!backup || backup.version !== 1 || !backup.settings || typeof backup.settings !== 'object') {
    throw new Error('Invalid Tran settings backup.')
  }
  replaceSettingsSnapshot(backup.settings)
}
