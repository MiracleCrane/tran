import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

let cache: Record<string, GoalInfo> | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'goal-store.json')
}

function load(): Record<string, GoalInfo> {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as unknown
    cache = raw && typeof raw === 'object' ? (raw as Record<string, GoalInfo>) : {}
  } catch {
    cache = {}
  }
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
  if (!cache) return
  try {
    mkdirSync(dirname(storePath()), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(cache, null, 1), 'utf8')
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
