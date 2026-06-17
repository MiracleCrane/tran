import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface ResolvedCodexCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: ResolvedCodexCommand | null = null

function firstWhere(name: string): string | null {
  try {
    const result = spawnSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  } catch {
    return null
  }
}

function npmVendorExeFromCmd(cmdPath: string): string | null {
  const candidate = join(
    dirname(cmdPath),
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe'
  )
  return existsSync(candidate) ? candidate : null
}

export function resolveWindowsCodexCommand(): ResolvedCodexCommand {
  if (cached) return cached

  const cmd = firstWhere('codex.cmd')
  const npmExe = cmd ? npmVendorExeFromCmd(cmd) : null
  if (npmExe) {
    cached = { command: npmExe, argsPrefix: [], displayPath: npmExe }
    return cached
  }

  const exe = firstWhere('codex.exe')
  if (exe) {
    cached = { command: exe, argsPrefix: [], displayPath: exe }
    return cached
  }

  if (cmd) {
    cached = { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd }
    return cached
  }

  cached = { command: 'codex', argsPrefix: [], displayPath: 'codex' }
  return cached
}
