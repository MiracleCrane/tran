import type { TranscriptItem } from '../types'

/** 运行中工具调用统计（状态 chips 用，Composer 上方一行）。 */

/** Kimi 把命令行工具映射为 'terminal'（旧 Claude 后端为 'Bash'）。 */
export const BASH_TOOL_NAMES = new Set(['Bash', 'terminal'])
export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

/** 统计运行中（pending/running）的指定类工具调用数。 */
export function countRunningTools(items: TranscriptItem[], names: Set<string>): number {
  let count = 0
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (
        block &&
        block.kind === 'tool' &&
        names.has(block.name) &&
        (block.status === 'running' || block.status === 'pending')
      ) {
        count += 1
      }
    }
  }
  return count
}
