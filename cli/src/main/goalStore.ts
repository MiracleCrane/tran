import { app } from 'electron'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { join } from 'node:path'
import { log } from './logger'

import type { GoalControlAction, GoalInfo, GoalStartOptions, GoalStatus } from '../shared/ipc'

export type { GoalControlAction, GoalInfo, GoalStartOptions, GoalStatus }

/** 目标模式（goal 循环）的会话级状态存储：per Tran-sessionId 一个 goal，
 *  持久化到 userData/goal-store.json（应用重启不丢；重启时 active → paused，
 *  因为循环随进程结束而中断，需手动继续）。
 *
 *  ACP 没有 goal 工具也没有 /goal 命令（实测 Unknown ACP command），所以
 *  goal 循环完全在 Tran 客户端实现（KimiBackend 驱动），这里只负责状态。 */

const DEFAULT_MAX_TURNS = 20

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked', 'complete'])

/** 逐项形状校验：文件被手改/损坏时（如 {"x":null}）不能进 cache，
 *  否则后续遍历 goal.status 直接抛 TypeError，且绕过 loadFailed 保护。 */
function isGoalInfo(value: unknown): value is GoalInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const goal = value as Record<string, unknown>
  return (
    typeof goal.objective === 'string' &&
    GOAL_STATUSES.has(goal.status as GoalStatus) &&
    typeof goal.turnCount === 'number' &&
    typeof goal.maxTurns === 'number' &&
    typeof goal.createdAt === 'number'
  )
}

let cache: Record<string, GoalInfo> | null = null
/** 读盘失败（区别于"文件不存在"）后本次运行不再写入：目标是用户设的长期任务，
 *  空对象写回去会把所有目标（含进度 turnCount）永久删掉。 */
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'goal-store.json')
}

function load(): Record<string, GoalInfo> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('goal', `goal-store.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('goal', 'goal-store.json 内容不是对象，本次运行不再写入')
    cache = {}
    loadFailed = true
    return cache
  }
  // 逐项过滤非法条目（只收合法的，不整体判死：合法目标应尽量保留）。
  cache = {}
  let dropped = 0
  for (const [sessionId, value] of Object.entries((raw as Record<string, unknown> | null) ?? {})) {
    if (isGoalInfo(value)) cache[sessionId] = value
    else dropped += 1
  }
  if (dropped) log('goal', `goal-store.json 含 ${dropped} 条非法条目，已忽略`)
  // 进程重启时循环已中断：active 一律降为 paused（需用户手动继续）。
  let migrated = false
  for (const goal of Object.values(cache)) {
    if (goal.status === 'active') {
      goal.status = 'paused'
      goal.blockedReason = '应用重启，循环已暂停'
      migrated = true
    }
  }
  if (migrated) save()
  return cache
}

function save(): void {
  if (!cache || loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(cache, null, 1))
  } catch (error) {
    log('goal', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function getGoal(sessionId: string): GoalInfo | null {
  return load()[sessionId] ?? null
}

export function startGoal(sessionId: string, opts: GoalStartOptions): GoalInfo {
  const goal: GoalInfo = {
    objective: opts.objective,
    ...(opts.completionCriterion ? { completionCriterion: opts.completionCriterion } : {}),
    status: 'active',
    // 创建目标的那条用户消息就是第 1 轮。
    turnCount: 1,
    maxTurns: opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : DEFAULT_MAX_TURNS,
    createdAt: Date.now()
  }
  load()[sessionId] = goal
  save()
  return goal
}

export function updateGoal(sessionId: string, patch: Partial<GoalInfo>): GoalInfo | null {
  const goal = load()[sessionId]
  if (!goal) return null
  Object.assign(goal, patch)
  save()
  return goal
}

export function clearGoal(sessionId: string): void {
  const map = load()
  if (!(sessionId in map)) return
  delete map[sessionId]
  save()
}

export function controlGoal(sessionId: string, action: GoalControlAction): GoalInfo | null {
  if (action === 'stop') {
    clearGoal(sessionId)
    return null
  }
  const goal = load()[sessionId]
  if (!goal) return null
  if (action === 'pause' && goal.status === 'active') {
    goal.status = 'paused'
    goal.blockedReason = '手动暂停'
  } else if (action === 'resume' && (goal.status === 'paused' || goal.status === 'blocked')) {
    goal.status = 'active'
    delete goal.blockedReason
  }
  save()
  return goal
}
