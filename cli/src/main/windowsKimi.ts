import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WindowsKimiCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: WindowsKimiCommand | null = null

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

/** GUI 拉起的进程 PATH 可能不全；PATH 找不到时回退到 Kimi Code CLI 的默认
 *  安装目录（%USERPROFILE%\.kimi-code\bin\kimi.cmd / kimi.exe / kimi）。 */
function fromDefaultInstallDir(): WindowsKimiCommand | null {
  const binDir = join(homedir(), '.kimi-code', 'bin')
  for (const name of ['kimi.cmd', 'kimi.exe', 'kimi']) {
    const candidate = join(binDir, name)
    if (!existsSync(candidate)) continue
    if (name.endsWith('.cmd')) {
      return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', candidate], displayPath: candidate }
    }
    return { command: candidate, argsPrefix: [], displayPath: candidate }
  }
  return null
}

export function resolveWindowsKimiCommand(): WindowsKimiCommand {
  if (cached) return cached

  const exe = firstWhere('kimi.exe')
  if (exe) {
    cached = { command: exe, argsPrefix: [], displayPath: exe }
    return cached
  }

  const cmd = firstWhere('kimi.cmd')
  if (cmd) {
    cached = { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd }
    return cached
  }

  const plain = firstWhere('kimi')
  if (plain) {
    cached = { command: plain, argsPrefix: [], displayPath: plain }
    return cached
  }

  const installed = fromDefaultInstallDir()
  if (installed) {
    cached = installed
    return cached
  }

  cached = { command: 'kimi', argsPrefix: [], displayPath: 'kimi' }
  return cached
}
