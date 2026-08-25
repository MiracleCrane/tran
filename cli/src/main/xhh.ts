import { spawn } from 'node:child_process'

/**
 * xhh 终端摸鱼工具：从 Tran 里弹出一个独立 cmd 窗口。
 * 与 screen-assist 不同：窗口是用户自己的交互式终端，
 * 生命周期不挂在 Tran 上（Tran 退出不回收，避免误杀用户正在用的窗口）。
 *
 * 注意两个坑（都已实测踩过）：
 * 1. start 的第一个引号参数是窗口标题，空标题 "" 必须显式给；
 * 2. Tran 是 GUI 进程没有控制台，windowsHide 下 start cmd.exe 不会创建
 *    可见窗口——必须让 start 指向一个 .cmd 文件走外壳关联打开。
 */
const XHH_TERMINAL_CMD = 'C:\\LegacyD\\Tools\\xhh\\xhh-terminal.cmd'

export interface LaunchXhhResult {
  ok: boolean
  error?: string
}

export function launchXhh(): LaunchXhhResult {
  try {
    spawn('cmd.exe', ['/c', 'start', '""', XHH_TERMINAL_CMD], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    }).unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
