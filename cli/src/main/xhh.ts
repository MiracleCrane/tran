import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * xhh 终端摸鱼工具：从 Tran 里弹出一个独立 cmd 窗口。
 * 与 screen-assist 不同：窗口是用户自己的交互式终端，
 * 生命周期不挂在 Tran 上（Tran 退出不回收，避免误杀用户正在用的窗口）。
 *
 * 路径解析：打包版读 resources/tools/xhh，开发版读仓库 tools/xhh。
 * 注意两个坑（都已实测踩过）：
 * 1. start 的第一个引号参数是窗口标题，空标题 "" 必须显式给；
 * 2. Tran 是 GUI 进程没有控制台，windowsHide 下 start cmd.exe 不会创建
 *    可见窗口——必须让 start 指向一个 .cmd 文件走外壳关联打开。
 */
function resolveXhhTerminalCmd(): string | null {
  const candidates = [
    join(process.resourcesPath, 'tools', 'xhh', 'xhh-terminal.cmd'),
    join(__dirname, '..', '..', '..', 'tools', 'xhh', 'xhh-terminal.cmd')
  ]
  return candidates.find(existsSync) ?? null
}

export interface LaunchXhhResult {
  ok: boolean
  error?: string
}

export function launchXhh(): LaunchXhhResult {
  const script = resolveXhhTerminalCmd()
  if (!script) {
    return { ok: false, error: '找不到 tools/xhh/xhh-terminal.cmd（未随包安装？）' }
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
