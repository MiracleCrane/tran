import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { currentBackend } from './preferences'
import { getProviderProfile } from './providers'
import { getSettingsSnapshot, replaceSettingsSnapshot } from './settings'
import { toWslPath } from './wslClaude'
import type {
  HealthCheckItem,
  RuntimeStatus,
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

function probeWindowsClaude(): { version?: string; path?: string; error?: string } {
  const where = run('where.exe', ['claude'], 5000)
  const version = run('cmd.exe', ['/d', '/s', '/c', 'claude --version'], 10000)
  const parsed = parseClaudeProbe(version)
  return {
    ...parsed,
    ...(where.stdout ? { path: where.stdout.split(/\r?\n/).find(Boolean) } : {})
  }
}

function probeWslClaude(): { version?: string; path?: string; error?: string } {
  return parseClaudeProbe(
    runWsl(['--exec', 'sh', '-lc', 'command -v claude && claude --version'], 12000)
  )
}

export function getRuntimeStatus(_cwd?: string, modelOverride?: string): RuntimeStatus {
  const backend = currentBackend()
  const profile = getProviderProfile(backend)
  const provider = profile.providers.find((p) => p.id === profile.activeProviderId) ?? null
  const probe = backend === 'wsl' ? probeWslClaude() : probeWindowsClaude()
  return {
    backend,
    provider,
    model: modelOverride || provider?.model || 'claude-opus-4-8',
    ...(probe.version ? { claudeCodeVersion: probe.version } : {}),
    ...(probe.path ? { claudeCodePath: probe.path } : {}),
    ...(probe.error ? { versionError: probe.error } : {}),
    ...(backend === 'wsl' ? { wslDistro: getDefaultWslDistro() } : {}),
    checkedAt: Date.now()
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
  const path = resolve(process.cwd(), 'logs', 'main.log')
  if (!existsSync(path)) return 'No Forge main log found.'
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  return lines.slice(-220).join('\n').trim()
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
