import { spawn } from 'node:child_process'
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

export function fromWslPath(path: string | undefined): string | undefined {
  if (!path) return path
  const normalized = path.replace(/\\/g, '/')
  const drive = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/)
  if (!drive) return path
  const [, letter, rest = ''] = drive
  return `${letter.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
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
