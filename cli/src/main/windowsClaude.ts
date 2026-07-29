import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 WindowsKimiCommand 同形，便于 spawn 侧统一处理。 */
export interface WindowsClaudeCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: WindowsClaudeCommand | null = null
let resolving: Promise<WindowsClaudeCommand> | null = null

/** 异步 where.exe（同 windowsKimi：启动期不能用 spawnSync 卡住事件循环）。 */
function firstWhere(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('where.exe', [name], { windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? null
      )
    })
  })
}

/**
 * PATH 找不到时的回退位置。
 *
 * npm 全局安装落在 %APPDATA%\npm；官方安装器落在 %USERPROFILE%\.local\bin
 * 或 %LOCALAPPDATA%\Programs\claude。三处都试。
 */
function fromDefaultInstallDirs(): WindowsClaudeCommand | null {
  const home = homedir()
  const appData = process.env['APPDATA']
  const localAppData = process.env['LOCALAPPDATA']
  const dirs = [
    ...(appData ? [join(appData, 'npm')] : []),
    join(home, '.local', 'bin'),
    ...(localAppData ? [join(localAppData, 'Programs', 'claude')] : []),
    join(home, '.claude', 'local')
  ]
  for (const dir of dirs) {
    for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      if (name.endsWith('.cmd')) {
        return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', candidate], displayPath: candidate }
      }
      return { command: candidate, argsPrefix: [], displayPath: candidate }
    }
  }
  return null
}

/** 解析 claude 可执行文件。优先级：claude.exe > claude.cmd > claude >
 *  默认安装目录 > 裸 'claude'。结果缓存，并发调用共享同一 Promise。 */
export function resolveWindowsClaudeCommand(): Promise<WindowsClaudeCommand> {
  if (cached) return Promise.resolve(cached)
  if (!resolving) {
    resolving = (async (): Promise<WindowsClaudeCommand> => {
      const [exe, cmd, plain] = await Promise.all([
        firstWhere('claude.exe'),
        firstWhere('claude.cmd'),
        firstWhere('claude')
      ])
      if (exe) return { command: exe, argsPrefix: [], displayPath: exe }
      if (cmd) return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd }
      if (plain) return { command: plain, argsPrefix: [], displayPath: plain }
      const installed = fromDefaultInstallDirs()
      if (installed) return installed
      return { command: 'claude', argsPrefix: [], displayPath: 'claude' }
    })()
      .then((resolved) => {
        cached = resolved
        return resolved
      })
      .finally(() => {
        resolving = null
      })
  }
  return resolving
}
