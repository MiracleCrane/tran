import type { KimiTaskInfo } from '../../shared/ipc'
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

/** 统计运行中（pending/running）的指定类工具调用数。
 *  后台 agent（run_in_background）的块 status 已是 done（launch ack），其运行
 *  语义只在传入 swarmTasks 且 server task 确认 running 时才计入（#32）；
 *  不传/为 null（server 不可用）时保守不计——静态猜测会让计数永远卡住。 */
export function countRunningTools(
  items: TranscriptItem[],
  names: Set<string>,
  swarmTasks?: KimiTaskInfo[] | null
): number {
  let count = 0
  for (const block of collectToolBlocks(items, names)) {
    const bg = backgroundTaskInfo(block)
    if (bg.isBackground) {
      if (swarmTasks && withServerTaskStatus(bg, swarmTasks).running) count += 1
      continue
    }
    if (block.status === 'running' || block.status === 'pending') count += 1
  }
  return count
}

/** 会话累计总数（chips 计数语义；含已完成/失败/停止）。 */
export function countTotalTools(items: TranscriptItem[], names: Set<string>): number {
  return collectToolBlocks(items, names).length
}

/** 后台任务信息（实证形态：rawInput.run_in_background=true 在 tool_call_update
 *  中间态到达；launch 结果里 task_id + status: running）。 */
export interface BackgroundTaskInfo {
  isBackground: boolean
  taskId?: string
  /** 后台任务仍在跑（launch 结果 status: running；完成通知另行到达，
   *  有 server tasks 时以 withServerTaskStatus 校正为准）。 */
  running: boolean
  /** server task 的 started_at/completed_at（ms；面板运行时长用，
   *  缺省退回 block 时间戳）。仅 withServerTaskStatus 命中时填充。 */
  startedAt?: number
  endedAt?: number
}

export function backgroundTaskInfo(block: ToolBlock): BackgroundTaskInfo {
  let value: unknown = block.input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (input.run_in_background !== true) return { isBackground: false, running: false }
  const resultText = typeof block.result === 'string' ? block.result : ''
  const taskId = resultText.match(/task_id:\s*(\S+)/)?.[1]
  const running = /status:\s*running/.test(resultText)
  return { isBackground: true, ...(taskId ? { taskId } : {}), running }
}

/** #32 用 kimi server 轮询到的 tasks 校正后台任务状态：launch 结果文本里的
 *  status: running 是静态快照，任务完成/被杀后不更新——server task 才是真相。
 *  找不到对应 task 或 server 不可用（null/undefined）时保持原猜测（降级，
 *  #25 server 起不来时行为与旧版一致）。 */
export function withServerTaskStatus(
  info: BackgroundTaskInfo,
  swarmTasks: KimiTaskInfo[] | null | undefined
): BackgroundTaskInfo {
  if (!info.isBackground || !info.taskId || !swarmTasks) return info
  const task = swarmTasks.find((t) => t.id === info.taskId)
  if (!task) return info
  const startedAt = task.startedAt ? Date.parse(task.startedAt) : NaN
  const completedAt = task.completedAt ? Date.parse(task.completedAt) : NaN
  return {
    ...info,
    running: task.status === 'running' || task.status === 'pending',
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(completedAt) ? { endedAt: completedAt } : {})
  }
}
