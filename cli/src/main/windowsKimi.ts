import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface WindowsKimiCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

let cached: WindowsKimiCommand | null = null
let resolving: Promise<WindowsKimiCommand> | null = null

/** 异步 where.exe：启动期在窗口创建/会话建立的关键路径上，spawnSync 会整块
 *  卡住主进程事件循环（实测三次串行约 80-150ms），这里并发异步探测。 */
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

/** 解析 kimi 可执行文件（异步、并发 where 探测；结果缓存，并发调用共享同一
 *  Promise）。优先级：kimi.exe > kimi.cmd > kimi > 默认安装目录 > 裸 'kimi'。 */
export function resolveWindowsKimiCommand(): Promise<WindowsKimiCommand> {
  if (cached) return Promise.resolve(cached)
  if (!resolving) {
    resolving = (async (): Promise<WindowsKimiCommand> => {
      const [exe, cmd, plain] = await Promise.all([
        firstWhere('kimi.exe'),
        firstWhere('kimi.cmd'),
        firstWhere('kimi')
      ])
      if (exe) return { command: exe, argsPrefix: [], displayPath: exe }
      if (cmd) return { command: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', cmd], displayPath: cmd }
      if (plain) return { command: plain, argsPrefix: [], displayPath: plain }
      const installed = fromDefaultInstallDir()
      if (installed) return installed
      return { command: 'kimi', argsPrefix: [], displayPath: 'kimi' }
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
