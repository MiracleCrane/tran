import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import { log } from './logger'

export type ResolvedClaudeCommand =
  | { kind: 'direct'; command: string }
  | { kind: 'cmd-shim'; command: string }

type EnvMap = Record<string, string | undefined>

function envValue(env: EnvMap, key: string): string | undefined {
  return env[key] ?? process.env[key]
}

function pathEnv(env: EnvMap): string {
  return env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? ''
}

function hasPathSeparator(value: string): boolean {
  return /[\\/]/.test(value)
}

function resolveCmdShimTarget(path: string): string | null {
  if (!/\.(cmd|bat)$/i.test(path)) return null
  try {
    const body = readFileSync(path, 'utf8')
    const match = body.match(/"([^"]*claude\.exe)"\s+%[*0-9]/i)
    if (!match?.[1]) return null

    const rawTarget = match[1]
    const base = dirname(path)
    const target = rawTarget.replace(/^%~?dp0%[\\/]?/i, '')
    const resolved = isAbsolute(target) ? target : join(base, target)
    return existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

function classifyCommand(path: string): ResolvedClaudeCommand {
  const shimTarget = resolveCmdShimTarget(path)
  if (shimTarget) return { kind: 'direct', command: shimTarget }
  return /\.(cmd|bat)$/i.test(path)
    ? { kind: 'cmd-shim', command: path }
    : { kind: 'direct', command: path }
}

function candidatePaths(command: string, env: EnvMap): string[] {
  if (hasPathSeparator(command)) return [command]

  const paths = pathEnv(env)
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)

  const extensions = ['.exe', '.cmd', '.bat', '']
  return paths.flatMap((dir) => extensions.map((ext) => join(dir, command + ext)))
}

export function resolveWindowsClaudeCommand(env: EnvMap = process.env): ResolvedClaudeCommand {
  const override = envValue(env, 'FORGE_CLAUDE_PATH')
  if (override) return classifyCommand(override)

  for (const candidate of candidatePaths('claude', env)) {
    if (existsSync(candidate)) return classifyCommand(candidate)
  }

  throw new Error(
    'Claude Code was not found in PATH. Install Claude Code or set FORGE_CLAUDE_PATH to claude.exe/claude.cmd.'
  )
}

export function spawnClaudeViaWindowsPath(options: ClaudeSpawnOptions): SpawnedProcess {
  const resolved = resolveWindowsClaudeCommand(options.env)
  const common: NodeSpawnOptions = {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }

  log(
    'bridge',
    `spawn Claude via Windows PATH command=${resolved.command} cwd=${options.cwd ?? '(default)'} args=${options.args.join(' ')}`
  )

  const child: ChildProcess =
    resolved.kind === 'cmd-shim'
      ? spawn(resolved.command, options.args, { ...common, shell: true })
      : spawn(resolved.command, options.args, common)

  child.stderr?.on('data', (data: Buffer) => {
    log('claude-windows-stderr', data.toString().trimEnd())
  })

  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
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
