import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface ResolvedCodexCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: ResolvedCodexCommand | null = null

function whereAll(name: string): string[] {
  try {
    const result = spawnSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
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

function isWindowsAppsPath(path: string): boolean {
  return /[\\/]WindowsApps[\\/]/i.test(path)
}

function canRunAppServer(candidate: ResolvedCodexCommand): boolean {
  if (isWindowsAppsPath(candidate.command) || isWindowsAppsPath(candidate.displayPath)) return false
  try {
    const result = spawnSync(candidate.command, [...candidate.argsPrefix, 'app-server', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    })
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    return !result.error && result.status === 0 && /app server/i.test(output)
  } catch {
    return false
  }
}

function newestExisting(paths: string[]): string[] {
  return paths
    .filter((path) => existsSync(path))
    .map((path) => {
      try {
        return { path, mtimeMs: statSync(path).mtimeMs }
      } catch {
        return { path, mtimeMs: 0 }
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.path)
}

function extensionCodexCandidates(): string[] {
  const roots = [
    join(homedir(), '.vscode', 'extensions'),
    join(homedir(), '.vscode-insiders', 'extensions'),
    join(homedir(), '.cursor', 'extensions'),
    join(homedir(), '.windsurf', 'extensions')
  ]
  const out: string[] = []
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    const extensionDirs = newestExisting(
      entries
        .filter((name) => /^openai\.chatgpt-/i.test(name))
        .map((name) => join(root, name))
    )
    for (const dir of extensionDirs) {
      out.push(join(dir, 'bin', 'windows-x86_64', 'codex.exe'))
    }
  }
  return newestExisting(out)
}

export function resolveWindowsCodexCommand(): ResolvedCodexCommand {
  if (cached) return cached

  const candidates: ResolvedCodexCommand[] = []

  for (const cmd of whereAll('codex.cmd')) {
    const npmExe = npmVendorExeFromCmd(cmd)
    if (npmExe) candidates.push({ command: npmExe, argsPrefix: [], displayPath: npmExe })
    candidates.push({ command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd })
  }

  for (const exe of whereAll('codex.exe')) {
    candidates.push({ command: exe, argsPrefix: [], displayPath: exe })
  }

  for (const exe of extensionCodexCandidates()) {
    candidates.push({ command: exe, argsPrefix: [], displayPath: exe })
  }

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.command}\0${candidate.argsPrefix.join('\0')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (canRunAppServer(candidate)) {
      cached = candidate
      return cached
    }
  }

  cached = { command: 'codex', argsPrefix: [], displayPath: 'codex' }
  return cached
}
