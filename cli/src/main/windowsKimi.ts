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

/** 控制台工具输出解码（H2）：where.exe 等按系统 ANSI/OEM 代码页输出字节流，
 *  中文 Windows 上是 GBK/CP936——按 UTF-8 硬解会把中文用户名路径解成替换字符
 *  （U+FFFD），后续 spawn 直接 ENOENT 且错误结果被缓存。策略：先严格 UTF-8
 *  （出现替换字符即视为失败），失败回退 GBK（Electron 自带完整 ICU，
 *  TextDecoder 支持 gbk），仍不行按宽松 UTF-8 兜底。 */
export function decodeConsoleOutput(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    /* 含非 UTF-8 字节：尝试 GBK */
  }
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** PowerShell 兜底探测（H2）：Get-Command 取路径并强制 stdout 按 UTF-8 输出，
 *  彻底绕开代码页问题。只在 where.exe 结果解码可疑/路径不存在时使用
 *  （powershell 冷启动 ~200ms，比 where 慢一个量级，不做首选）。 */
function firstWherePowerShell(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Command ${name} -ErrorAction SilentlyContinue).Source`
        ],
        { windowsHide: true }
      )
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const first =
        Buffer.concat(chunks)
          .toString('utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? null
      resolve(first && existsSync(first) ? first : null)
    })
  })
}

/** 异步 where.exe：启动期在窗口创建/会话建立的关键路径上，spawnSync 会整块
 *  卡住主进程事件循环（实测三次串行约 80-150ms），这里并发异步探测。
 *  输出不 setEncoding，按 Buffer 收集统一解码（见 decodeConsoleOutput）；
 *  解出的路径必须在磁盘上真实存在，否则换 PowerShell 探测兜底。 */
function firstWhere(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('where.exe', [name], { windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const first =
        decodeConsoleOutput(Buffer.concat(chunks))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? null
      if (first && existsSync(first)) {
        resolve(first)
        return
      }
      // 解码没救回来（GBK 也不对）或路径确实不存在：PowerShell 探测兜底，
      // 避免把乱码路径缓存下来导致 spawn 永久 ENOENT。
      void firstWherePowerShell(name).then(resolve)
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
        // 全部探测失败的裸 'kimi' 兜底**不缓存**：用户随后装好 kimi（或升级
        // 挪了位置）后，缓存会让本进程每次 spawn 继续 ENOENT，直到重启应用。
        if (resolved.displayPath !== 'kimi') cached = resolved
        return resolved
      })
      .finally(() => {
        resolving = null
      })
  }
  return resolving
}
