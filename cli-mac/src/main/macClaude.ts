import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess
} from '@anthropic-ai/claude-agent-sdk'
import { log } from './logger'

/**
 * Resolve and spawn the `claude` (Claude Code) CLI on macOS.
 *
 * On macOS Claude Code is a plain POSIX executable — there are no `.cmd`/`.bat`
 * shims to unwrap and no `.exe` extensions to append. It is typically installed
 * to one of:
 *   - /opt/homebrew/bin/claude         (Apple Silicon Homebrew)
 *   - /usr/local/bin/claude            (Intel Homebrew / npm global)
 *   - ~/.claude/local/claude           (Claude Code's own installer)
 *   - ~/.npm-global/bin/claude         (npm global, custom prefix)
 *
 * We honor an explicit FORGE_CLAUDE_PATH override first, otherwise scan PATH
 * (as inherited by the app / launched via Finder), then fall back to the
 * well-known locations above so the app keeps working even when the GUI-launched
 * Electron process doesn't inherit the user's shell PATH.
 */

export type ResolvedClaudeCommand = { kind: 'direct'; command: string }

type EnvMap = Record<string, string | undefined>

const KNOWN_LOCATIONS = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  join(homedir(), '.claude/local/claude'),
  join(homedir(), '.claude/local/node_modules/.bin/claude'),
  join(homedir(), '.npm-global/bin/claude'),
  join(homedir(), '.volta/bin/claude'),
  join(homedir(), '.nvm/current/bin/claude')
]

function envValue(env: EnvMap, key: string): string | undefined {
  return env[key] ?? process.env[key]
}

function pathEnv(env: EnvMap): string {
  return env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? ''
}

function pathCandidates(command: string, env: EnvMap): string[] {
  const paths = pathEnv(env)
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  return paths.map((dir) => join(dir, command))
}

export function resolveMacClaudeCommand(env: EnvMap = process.env): ResolvedClaudeCommand {
  const override = envValue(env, 'FORGE_CLAUDE_PATH')
  if (override) return { kind: 'direct', command: override }

  for (const candidate of pathCandidates('claude', env)) {
    if (existsSync(candidate)) return { kind: 'direct', command: candidate }
  }

  for (const candidate of KNOWN_LOCATIONS) {
    if (existsSync(candidate)) return { kind: 'direct', command: candidate }
  }

  throw new Error(
    'Claude Code was not found. Install Claude Code (e.g. `npm i -g @anthropic-ai/claude-code` ' +
      'or run the official installer), or set FORGE_CLAUDE_PATH to the claude binary.'
  )
}

export function spawnClaudeViaMacPath(options: ClaudeSpawnOptions): SpawnedProcess {
  const resolved = resolveMacClaudeCommand(options.env)
  const common: NodeSpawnOptions = {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe']
  }

  log(
    'bridge',
    `spawn Claude via macOS PATH command=${resolved.command} cwd=${options.cwd ?? '(default)'} args=${options.args.join(' ')}`
  )

  const child: ChildProcess = spawn(resolved.command, options.args, common)

  child.stderr?.on('data', (data: Buffer) => {
    log('claude-mac-stderr', data.toString().trimEnd())
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
