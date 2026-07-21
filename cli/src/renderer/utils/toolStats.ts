import type { ToolBlock, TranscriptItem } from '../types'

/** 工具调用统计（Composer 上方 chips + 任务面板；chips 计数=会话累计）。 */

/** Kimi 把命令行工具映射为 'terminal'（旧 Claude 后端为 'Bash'）。 */
export const BASH_TOOL_NAMES = new Set(['Bash', 'terminal'])
export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

/** 按顺序收集全部工具调用块（含历史重放 items；任务面板列表用）。 */
export function collectToolBlocks(items: TranscriptItem[], names?: Set<string>): ToolBlock[] {
  const blocks: ToolBlock[] = []
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block && block.kind === 'tool' && (!names || names.has(block.name))) {
        blocks.push(block)
      }
    }
  }
  return blocks
}

/** 统计运行中（pending/running）的指定类工具调用数。 */
export function countRunningTools(items: TranscriptItem[], names: Set<string>): number {
  let count = 0
  for (const block of collectToolBlocks(items, names)) {
    if (block.status === 'running' || block.status === 'pending') count += 1
  }
  return count
}

/** 会话累计总数（chips 计数语义；含已完成/失败/停止）。 */
export function countTotalTools(items: TranscriptItem[], names: Set<string>): number {
  return collectToolBlocks(items, names).length
}
