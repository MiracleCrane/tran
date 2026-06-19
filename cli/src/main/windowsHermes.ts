import { spawnSync } from 'node:child_process'

export interface WindowsHermesCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: WindowsHermesCommand | null = null

function firstWhere(name: string): string | null {
  const result = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error || result.status !== 0) return null
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null
}

export function resolveWindowsHermesCommand(): WindowsHermesCommand {
  if (cached) return cached

  const exe = firstWhere('hermes.exe')
  if (exe) {
    cached = { command: exe, argsPrefix: [], displayPath: exe }
    return cached
  }

  const cmd = firstWhere('hermes.cmd')
  if (cmd) {
    cached = { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd }
    return cached
  }

  const plain = firstWhere('hermes')
  if (plain) {
    cached = { command: plain, argsPrefix: [], displayPath: plain }
    return cached
  }

  cached = { command: 'hermes', argsPrefix: [], displayPath: 'hermes' }
  return cached
}
