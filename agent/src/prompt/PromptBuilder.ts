import type { ToolDefinition } from '../types.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** 默认系统提示模板（anvil.md）。 */
const moduleDir = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROMPT_PATH = resolve(moduleDir, 'anvil.md')

let cachedDefault: string | null = null

/** 读默认提示模板（带缓存）。文件缺失则回退到内置精简版。 */
function loadDefault(): string {
  if (cachedDefault !== null) return cachedDefault
  try {
    cachedDefault = readFileSync(DEFAULT_PROMPT_PATH, 'utf8')
  } catch {
    cachedDefault = [
      '你是 Anvil，Forge 的自研编程 agent。强项是代码开发，兼顾日常实用任务。',
      '先读后写、最小改动、验证闭环、如实上报失败。'
    ].join('\n')
  }
  return cachedDefault
}

/**
 * 组装最终系统提示 = 用户/默认人格 + 工具索引。
 * 工具索引让模型清楚「现在有哪些工具可用」，提高调用准确率。
 */
export function buildSystemPrompt(
  tools: ToolDefinition[],
  override?: string
): string {
  const base = override?.trim() ? override : loadDefault()
  if (!tools.length) return base
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n')
  return `${base}\n\n## 可用工具\n${list}`
}
