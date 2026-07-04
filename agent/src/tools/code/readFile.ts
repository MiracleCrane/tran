import { readFileSync, statSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import type { ToolHandler, ToolResult } from '../../types.js'

/** 单次读取上限（字符）。避免模型把巨型文件整个吞进上下文。 */
const MAX_CHARS = 200_000

/**
 * read_file —— 代码开发的眼睛。只读、免审批。
 * 支持 offset/limit（按行切片）和相对 cwd 的路径。
 */
export const readFileTool: ToolHandler = {
  name: 'read_file',
  description:
    '读取本地文件并以带行号的文本返回。优先用于了解代码现状——动任何代码前先确认。支持相对 cwd 的路径。',
  risk: 'safe',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要读取的文件路径，相对当前工作目录或绝对路径。'
      },
      offset: {
        type: 'integer',
        minimum: 1,
        description: '从第几行开始（从 1 计），用于读大文件片段。'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: '最多读取多少行。'
      }
    },
    required: ['file_path']
  },
  async execute(args, ctx): Promise<ToolResult> {
    const raw = String(args.file_path ?? '')
    if (!raw) return { content: '缺少 file_path 参数。', isError: true }
    const path = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw)
    try {
      const stat = statSync(path)
      if (stat.isDirectory()) {
        return { content: `这是一个目录，不是文件: ${path}`, isError: true }
      }
      const content = readFileSync(path, 'utf8')
      const lines = content.split(/\r?\n/)
      const offset = Math.max(1, Number(args.offset ?? 1))
      const limit = args.limit ? Number(args.limit) : undefined
      const start = offset - 1
      const sliced = limit ? lines.slice(start, start + limit) : lines.slice(start)
      // 截断超长内容，保留「文件被截断」的提示。
      let body = sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
      if (body.length > MAX_CHARS) {
        body = body.slice(0, MAX_CHARS) + `\n…（已截断，共 ${lines.length} 行）`
      }
      return { content: body || '(空文件)' }
    } catch (e) {
      return {
        content: `读取失败: ${e instanceof Error ? e.message : String(e)}`,
        isError: true
      }
    }
  }
}
