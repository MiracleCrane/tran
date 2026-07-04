import { spawn } from 'node:child_process'
import { resolve, isAbsolute } from 'node:path'
import type { ToolHandler, ToolResult } from '../../types.js'

/** 单命令最长等待（毫秒）。超时则杀进程并报错，避免挂死。 */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 60_000

/**
 * bash —— 代码开发的手。可跑测试、构建、git… 需审批（首次）。
 * 支持工作目录、超时；stdout/stderr 分开捕获。signal 可中断。
 */
export const bashTool: ToolHandler = {
  name: 'bash',
  description:
    '在当前工作目录执行 shell 命令（构建、测试、git 等）。需要用户审批。支持设置超时和工作目录。',
  risk: 'requires-approval',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令。' },
      cwd: {
        type: 'string',
        description: '工作目录（默认会话 cwd）。相对 cwd 解析。'
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        description: '超时毫秒，默认 120000。超时杀进程。'
      }
    },
    required: ['command']
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? '')
    if (!command) return { content: '缺少 command 参数。', isError: true }
    const cwd = args.cwd
      ? isAbsolute(String(args.cwd))
        ? String(args.cwd)
        : resolve(ctx.cwd, String(args.cwd))
      : ctx.cwd
    const timeout = Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)

    return new Promise((resolveP) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        // 群组：kill 时连带子进程一起带走。
        detached: process.platform !== 'win32'
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (process.platform !== 'win32') {
            process.kill(-child.pid!)
          } else {
            child.kill()
          }
        } catch {
          child.kill('SIGKILL')
        }
      }, timeout)

      child.stdout?.on('data', (d: Buffer | string) => {
        const s = typeof d === 'string' ? d : d.toString('utf8')
        if (stdout.length < MAX_OUTPUT) stdout += s
      })
      child.stderr?.on('data', (d: Buffer | string) => {
        const s = typeof d === 'string' ? d : d.toString('utf8')
        if (stderr.length < MAX_OUTPUT) stderr += s
      })

      // 外部中断（用户点了停止）→ 杀进程。
      const onAbort = (): void => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid!)
          else child.kill('SIGKILL')
        } catch {
          /* already dead */
        }
      }
      if (ctx.signal.aborted) onAbort()
      else ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const parts: string[] = []
        if (stdout) parts.push(stdout.trimEnd())
        if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`)
        const exitInfo = timedOut
          ? `（超时 ${timeout}ms，已终止）`
          : `（退出码 ${code}）`
        const body = parts.join('\n\n') || '(无输出)'
        resolveP({ content: `${body}\n\n${exitInfo}`, isError: timedOut || (code ?? 0) !== 0 })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolveP({ content: `执行失败: ${err.message}`, isError: true })
      })
    })
  }
}
