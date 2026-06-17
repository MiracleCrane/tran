import { spawn, spawnSync } from 'node:child_process'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { log } from './logger'

const FORWARDED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_CODE_']
const FORWARDED_ENV_NAMES = new Set([
  'DEBUG',
  'DEBUG_CLAUDE_AGENT_SDK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
])

let defaultWslDistroCache: string | undefined
let wslHomeCache: string | undefined

function cleanWslOutput(value: string | Buffer | undefined): string {
  return String(value ?? '').replace(/\0/g, '').trim()
}

function runWslSync(args: string[], timeoutMs = 10000): { ok: boolean; stdout: string } {
  if (process.platform !== 'win32') return { ok: false, stdout: '' }
  try {
    const result = spawnSync('wsl.exe', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true
    })
    return {
      ok: !result.error && result.status === 0,
      stdout: cleanWslOutput(result.stdout)
    }
  } catch {
    return { ok: false, stdout: '' }
  }
}

export function getDefaultWslDistro(): string | undefined {
  if (defaultWslDistroCache) return defaultWslDistroCache

  const verbose = runWslSync(['-l', '-v'])
  if (verbose.ok || verbose.stdout) {
    for (const line of verbose.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\*\s+(.+?)\s{2,}/)
      if (match?.[1]) {
        defaultWslDistroCache = match[1].trim()
        return defaultWslDistroCache
      }
    }
  }

  const quiet = runWslSync(['-l', '-q'])
  if (!quiet.ok) return undefined
  defaultWslDistroCache = quiet.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return defaultWslDistroCache
}

export function getWslHome(): string | undefined {
  if (wslHomeCache) return wslHomeCache
  const home = runWslSync(['--exec', 'sh', '-lc', 'printf %s "$HOME"'])
  if (!home.ok || !home.stdout.startsWith('/')) return undefined
  wslHomeCache = home.stdout
  return wslHomeCache
}

function isForwardedEnvName(name: string): boolean {
  if (FORWARDED_ENV_NAMES.has(name)) return true
  return FORWARDED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function toWslPath(path: string | undefined): string | undefined {
  if (!path) return path
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^([A-Za-z]):(?:\/(.*))?$/)
  if (drive) {
    const [, letter, rest = ''] = drive
    return `/mnt/${letter.toLowerCase()}${rest ? `/${rest}` : ''}`
  }
  const uncWsl = normalized.match(/^\/\/wsl(?:\$|\.localhost)\/[^/]+\/?(.*)$/i)
  if (uncWsl) return `/${uncWsl[1] ?? ''}`.replace(/\/+$/, '') || '/'
  return normalized
}

export function isWslUncPath(path: string | undefined): boolean {
  if (!path) return false
  return /^[/\\]{2}wsl(?:\$|\.localhost)[/\\]/i.test(path)
}

export function toWslUncPath(
  path: string | undefined,
  distro = getDefaultWslDistro()
): string | undefined {
  if (!path) return path
  const normalized = path.replace(/\\/g, '/')
  const uncWsl = normalized.match(/^\/\/wsl(?:\$|\.localhost)\/([^/]+)(?:\/(.*))?$/i)
  if (uncWsl) {
    const [, selectedDistro, rest = ''] = uncWsl
    return `\\\\wsl.localhost\\${selectedDistro}${rest ? `\\${rest.replace(/\//g, '\\')}` : ''}`
  }
  if (!distro) return undefined
  const wslPath = toWslPath(path)
  if (!wslPath?.startsWith('/')) return undefined
  const rest = wslPath.replace(/^\/+/, '').replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}${rest ? `\\${rest}` : ''}`
}

export function fromWslPath(path: string | undefined): string | undefined {
  if (!path) return path
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/)
  if (drive) {
    const [, letter, rest = ''] = drive
    return `${letter.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
  }
  if (process.platform === 'win32' && normalized.startsWith('/')) {
    return toWslUncPath(normalized) ?? path
  }
  return path
}

function forwardedEnvArgs(env: SpawnOptions['env']): string[] {
  const args: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isForwardedEnvName(name)) continue
    if (name === 'CLAUDE_CONFIG_DIR' || name === 'CLAUDE_SECURESTORAGE_CONFIG_DIR') continue
    args.push(`${name}=${value}`)
  }
  return args
}

export function spawnClaudeViaWsl(options: SpawnOptions): SpawnedProcess {
  const cwd = toWslPath(options.cwd)
  const args = [
    ...(cwd ? ['--cd', cwd] : []),
    '--exec',
    '/usr/bin/env',
    ...forwardedEnvArgs(options.env),
    'claude',
    ...options.args
  ]

  log('bridge', `spawn Claude via WSL cwd=${cwd ?? '(default)'} args=${options.args.join(' ')}`)
  const child = spawn('wsl.exe', args, {
    env: process.env,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

  child.stderr.on('data', (data: Buffer) => {
    log('claude-wsl-stderr', data.toString().trimEnd())
  })

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed
    },
    get exitCode() {
      return child.exitCode
    },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child)
  }
}
