import { spawn } from 'node:child_process'

/**
 * xhh 终端摸鱼工具：从 Tran 里弹出一个独立 cmd 窗口。
 * 与 screen-assist 不同：窗口是用户自己的交互式终端，
 * 生命周期不挂在 Tran 上（Tran 退出不回收，避免误杀用户正在用的窗口）。
 */
const XHH_DIR = 'C:\\LegacyD\\Tools\\xhh'

export interface LaunchXhhResult {
  ok: boolean
  error?: string
}

export function launchXhh(): LaunchXhhResult {
  try {
    spawn('cmd.exe', ['/c', 'start', 'xhh', 'cmd.exe', '/k', `cd /d ${XHH_DIR}`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    }).unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
