import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * xtw 终端摸鱼工具：从 Tran 里弹出一个独立 cmd 窗口刷 X(Twitter)。
 * 与 xhh 同一形态：窗口是用户自己的交互式终端，生命周期不挂在 Tran 上。
 *
 * 路径解析：打包版读 resources/tools/xtw，开发版读仓库 tools/xtw。
 */
function resolveXtwTerminalCmd(): string | null {
  const candidates = [
    join(process.resourcesPath, 'tools', 'xtw', 'xtw-terminal.cmd'),
    join(__dirname, '..', '..', '..', 'tools', 'xtw', 'xtw-terminal.cmd')
  ]
  return candidates.find(existsSync) ?? null
}

export interface LaunchXtwResult {
  ok: boolean
  error?: string
}

export function launchXtw(): LaunchXtwResult {
  const script = resolveXtwTerminalCmd()
  if (!script) {
    return { ok: false, error: '找不到 tools/xtw/xtw-terminal.cmd（未随包安装？）' }
  }
  try {
    spawn('cmd.exe', ['/c', 'start', '""', script], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    }).unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
