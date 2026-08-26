import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * screen-assist 悬浮问答工具：作为 Tran 的子进程启动/回收。
 * 窗口是独立顶层窗口，只是生命周期挂在 Tran 上
 * （before-quit 用 taskkill /T 收掉整棵进程树，避免 uv→pythonw 孤儿）。
 * 路径解析：打包版读 resources/tools/screen-assist，开发版读仓库 tools/screen-assist。
 */
const UV_EXE = 'C:\\LegacyD\\Python\\Python312\\Scripts\\uv.exe'

function resolveScreenAssistDir(): string | null {
  const candidates = [
    join(process.resourcesPath, 'tools', 'screen-assist'),
    join(__dirname, '..', '..', '..', 'tools', 'screen-assist')
  ]
  return candidates.find((p) => existsSync(join(p, 'main.py'))) ?? null
}

let child: ChildProcess | null = null

export interface LaunchScreenAssistResult {
  ok: boolean
  already?: boolean
  error?: string
}

export function launchScreenAssist(): LaunchScreenAssistResult {
  if (child && !child.killed && child.exitCode === null) {
    return { ok: true, already: true }
  }
  const dir = resolveScreenAssistDir()
  if (!dir) {
    return { ok: false, error: '找不到 tools/screen-assist（未随包安装？）' }
  }
  try {
    child = spawn(UV_EXE, ['run', 'pythonw', 'main.py'], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('exit', () => {
      child = null
    })
    child.on('error', () => {
      child = null
    })
    return { ok: true }
  } catch (error) {
    child = null
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function killScreenAssist(): void {
  if (child?.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).unref()
  }
  child = null
}

app.once('before-quit', killScreenAssist)
