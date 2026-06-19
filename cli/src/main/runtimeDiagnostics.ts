import { app } from 'electron'
import { arch, hostname, platform, release } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { currentAgentBackend, currentBackend, getPreferences } from './preferences'
import { getProviderProfile } from './providers'
import { getSettingsSnapshot, replaceSettingsSnapshot } from './settings'
import { toWslPath } from './wslClaude'
import { AGENT_BACKENDS } from '../shared/agentBackends'
import { readCodexDefaultModel } from './agent/CodexBackend'
import { readHermesDefaultModel, readHermesProvider } from './hermesConfig'
import { resolveWindowsCodexCommand } from './windowsCodex'
import { resolveWindowsHermesCommand } from './windowsHermes'
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
  wslDistro?: string
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

function runWsl(args: string[], timeoutMs = 15000): CommandResult {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      status: null,
      error: 'WSL is only available from Forge on Windows.'
    }
  }
  return run('wsl.exe', args, timeoutMs)
}

function runWslAsync(args: string[], timeoutMs = 15000): Promise<CommandResult> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      status: null,
      error: 'WSL is only available from Forge on Windows.'
    })
  }
  return runAsync('wsl.exe', args, timeoutMs)
}

function resultDetail(result: CommandResult): string {
  return result.stdout || result.stderr || result.error || `exit code ${result.status ?? 'unknown'}`
}

function getDefaultWslDistro(): string | undefined {
  const verbose = runWsl(['-l', '-v'])
  if (verbose.ok || verbose.stdout) {
    for (const line of verbose.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\*\s+(.+?)\s{2,}/)
      if (match?.[1]) return match[1].trim()
    }
  }

  const quiet = runWsl(['-l', '-q'])
  if (!quiet.ok && !quiet.stdout) return undefined
  return quiet.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

async function getDefaultWslDistroAsync(): Promise<string | undefined> {
  const verbose = await runWslAsync(['-l', '-v'], 10000)
  if (verbose.ok || verbose.stdout) {
    for (const line of verbose.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\*\s+(.+?)\s{2,}/)
      if (match?.[1]) return match[1].trim()
    }
  }

  const quiet = await runWslAsync(['-l', '-q'], 10000)
  if (!quiet.ok && !quiet.stdout) return undefined
  return quiet.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function parseClaudeProbe(result: CommandResult): {
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

async function probeWindowsClaudeAsync(): Promise<RuntimeProbe> {
  const [where, version] = await Promise.all([
    runAsync('where.exe', ['claude'], 5000),
    runAsync('cmd.exe', ['/d', '/s', '/c', 'claude --version'], 10000)
  ])
  const parsed = parseClaudeProbe(version)
  return {
    ...parsed,
    ...(where.stdout ? { path: where.stdout.split(/\r?\n/).find(Boolean) } : {}),
    checkedAt: Date.now()
  }
}

async function probeWslClaudeAsync(): Promise<RuntimeProbe> {
  const [version, wslDistro] = await Promise.all([
    runWslAsync(['--exec', 'sh', '-lc', 'command -v claude && claude --version'], 12000),
    getDefaultWslDistroAsync()
  ])
  return {
    ...parseClaudeProbe(version),
    ...(wslDistro ? { wslDistro } : {}),
    checkedAt: Date.now()
  }
}

async function probeWindowsCodexAsync(): Promise<RuntimeProbe> {
  const resolved = resolveWindowsCodexCommand()
  const version = await runAsync(resolved.command, [...resolved.argsPrefix, '--version'], 10000)
  const parsed = parseClaudeProbe(version)
  return {
    ...parsed,
    path: resolved.displayPath,
    checkedAt: Date.now()
  }
}

async function probeWindowsHermesAsync(): Promise<RuntimeProbe> {
  const resolved = resolveWindowsHermesCommand()
  const version = await runAsync(resolved.command, [...resolved.argsPrefix, '--version'], 15000)
  const parsed = parseClaudeProbe(version)
  return {
    ...parsed,
    path: resolved.displayPath,
    checkedAt: Date.now()
  }
}

async function runtimeProbe(
  agentBackend: ReturnType<typeof currentAgentBackend>,
  backend: ReturnType<typeof currentBackend>,
  refresh: boolean
): Promise<RuntimeProbe | undefined> {
  const cacheKey = `${agentBackend}:${backend}`
  const cached = runtimeProbeCache.get(cacheKey)
  if (!refresh) return cached
  if (cached && Date.now() - cached.checkedAt < RUNTIME_PROBE_TTL_MS) return cached

  const inflight = runtimeProbeInflight.get(cacheKey)
  if (inflight) return inflight

  const probe = (
    agentBackend === 'codex'
      ? probeWindowsCodexAsync()
      : agentBackend === 'hermes'
        ? probeWindowsHermesAsync()
      : backend === 'wsl'
        ? probeWslClaudeAsync()
        : probeWindowsClaudeAsync()
  )
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
  const backend = agentBackend === 'codex' || agentBackend === 'hermes' ? 'windows' : currentBackend()
  const agent = AGENT_BACKENDS.find((item) => item.id === agentBackend) ?? AGENT_BACKENDS[0]
  const profile = getProviderProfile(backend)
  const provider =
    agentBackend === 'codex'
      ? null
      : agentBackend === 'hermes'
        ? readHermesProvider()
        : profile.providers.find((p) => p.id === profile.activeProviderId) ?? null
  const probe = await runtimeProbe(agentBackend, backend, options.refreshProbe === true)
  const model =
    agentBackend === 'codex'
      ? modelOverride || readCodexDefaultModel() || 'codex-default'
      : agentBackend === 'hermes'
        ? modelOverride || readHermesDefaultModel() || 'hermes-default'
        : modelOverride || provider?.model || 'claude-opus-4-8'
  return {
    agentBackend,
    agentName: agent.name,
    ...(probe?.version ? { agentVersion: probe.version } : {}),
    ...(probe?.path ? { agentPath: probe.path } : {}),
    backend,
    provider,
    model,
    ...(agentBackend === 'claude-code' && probe?.version ? { claudeCodeVersion: probe.version } : {}),
    ...(agentBackend === 'claude-code' && probe?.path ? { claudeCodePath: probe.path } : {}),
    ...(probe?.error ? { versionError: probe.error } : {}),
    ...(probe?.wslDistro ? { wslDistro: probe.wslDistro } : {}),
    checkedAt: probe?.checkedAt ?? Date.now()
  }
}

function check(
  checks: HealthCheckItem[],
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  fixable = false
): void {
  checks.push({
    id,
    label,
    state: ok ? 'pass' : 'fail',
    detail,
    ...(fixable && !ok ? { fixable: true } : {})
  })
}

function warning(
  checks: HealthCheckItem[],
  id: string,
  label: string,
  detail: string,
  fixable = false
): void {
  checks.push({
    id,
    label,
    state: 'warn',
    detail,
    ...(fixable ? { fixable: true } : {})
  })
}

export function runWslHealthCheck(cwd: string): WslHealthReport {
  const checks: HealthCheckItem[] = []
  const diagnostics: string[] = []
  const checkedAt = Date.now()
  const cwdWsl = toWslPath(cwd)

  const list = runWsl(['-l', '-v'], 10000)
  const defaultDistro = getDefaultWslDistro()
  diagnostics.push('$ wsl.exe -l -v')
  diagnostics.push(resultDetail(list))
  check(
    checks,
    'default-wsl',
    'Default WSL',
    !!defaultDistro,
    defaultDistro ? `Default distro: ${defaultDistro}` : resultDetail(list)
  )

  const claude = runWsl(['--exec', 'sh', '-lc', 'command -v claude && claude --version'], 12000)
  diagnostics.push('\n$ wsl.exe --exec sh -lc "command -v claude && claude --version"')
  diagnostics.push(resultDetail(claude))
  check(checks, 'claude-installed', 'Claude Code', claude.ok, resultDetail(claude))

  const configScript = [
    'if [ ! -d "$HOME/.claude" ]; then echo "missing ~/.claude"; exit 2; fi',
    'if [ ! -f "$HOME/.claude/settings.json" ]; then echo "missing ~/.claude/settings.json"; exit 3; fi',
    'if command -v python3 >/dev/null 2>&1; then',
    '  python3 -m json.tool "$HOME/.claude/settings.json" >/dev/null || exit 4',
    'else',
    '  echo "python3 missing; skipped json validation"; exit 5',
    'fi',
    'echo "~/.claude/settings.json ok"'
  ].join('\n')
  const config = runWsl(['--exec', 'sh', '-lc', configScript], 12000)
  diagnostics.push('\n$ wsl.exe --exec sh -lc "<check ~/.claude/settings.json>"')
  diagnostics.push(resultDetail(config))
  if (config.status === 5) {
    warning(checks, 'claude-config', '~/.claude config', resultDetail(config), true)
  } else {
    check(checks, 'claude-config', '~/.claude config', config.ok, resultDetail(config), true)
  }

  const mapped = cwdWsl
    ? runWsl(['--cd', cwdWsl, '--exec', 'pwd'], 10000)
    : {
        ok: false,
        stdout: '',
        stderr: '',
        status: null,
        error: 'Could not map Windows cwd to a WSL path.'
      }
  diagnostics.push(`\n$ wsl.exe --cd ${cwdWsl ?? '(unmapped)'} --exec pwd`)
  diagnostics.push(resultDetail(mapped))
  check(checks, 'cwd-mapping', 'Working directory mapping', mapped.ok, resultDetail(mapped))

  return {
    checkedAt,
    cwd,
    ...(cwdWsl ? { cwdWsl } : {}),
    ...(defaultDistro ? { defaultDistro } : {}),
    checks,
    diagnostics: diagnostics.join('\n')
  }
}

export function repairWslEnvironment(cwd: string): WslHealthReport {
  const repairScript = [
    'mkdir -p "$HOME/.claude"',
    'if [ ! -f "$HOME/.claude/settings.json" ]; then printf "{}\\n" > "$HOME/.claude/settings.json"; fi',
    'chmod 700 "$HOME/.claude" 2>/dev/null || true',
    'chmod 600 "$HOME/.claude/settings.json" 2>/dev/null || true'
  ].join('\n')
  runWsl(['--exec', 'sh', '-lc', repairScript], 12000)
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

function providerSummary(): unknown {
  return (['windows', 'wsl'] as const).map((backend) => {
    const profile = getProviderProfile(backend)
    return {
      backend,
      activeProviderId: profile.activeProviderId,
      providers: profile.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        authType: provider.authType,
        model: provider.model,
        token: provider.token ? '[redacted]' : ''
      })),
      composerModels: profile.composerModels ?? []
    }
  })
}

export async function buildDiagnosticReport(
  options: DiagnosticReportOptions = {}
): Promise<string> {
  const prefs = getPreferences()
  const runtime = await getRuntimeStatus(options.cwd, undefined, { refreshProbe: true })
  const shouldRunWsl =
    process.platform === 'win32' &&
    !!options.cwd &&
    (prefs.wslSupportEnabled === true || runtime.backend === 'wsl')
  const wslHealth = shouldRunWsl && options.cwd ? runWslHealthCheck(options.cwd) : null
  const settings = redactSecrets(getSettingsSnapshot())
  const diagnosticLog = getDiagnosticLog()

  return [
    '# Forge Diagnostic Report',
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
      cwd: options.cwd ?? null,
      cwdWsl: options.cwd ? toWslPath(options.cwd) : null
    }),
    '## Preferences',
    jsonBlock(redactSecrets(prefs)),
    '## Appearance',
    jsonBlock(redactSecrets(options.appearance ?? null)),
    '## Runtime Status',
    jsonBlock(redactSecrets(runtime)),
    '## Provider Profiles',
    jsonBlock(providerSummary()),
    '## Settings Snapshot',
    jsonBlock(settings),
    '## WSL Health',
    wslHealth ? jsonBlock(wslHealth) : 'Not run.',
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
    throw new Error('Invalid Forge settings backup.')
  }
  replaceSettingsSnapshot(backup.settings)
}
