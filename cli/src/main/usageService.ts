import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './logger'
import type { PlanUsageInfo, PlanUsageResult, UsageLimitWindow } from '../shared/ipc'

/**
 * 套餐额度（Kimi 云端 API）。与 Kimi CLI 同款数据源：
 * GET https://api.kimi.com/coding/v1/usages，Bearer 为 CLI 的 OAuth access_token
 * （~/.kimi-code/credentials/kimi-code.json）。主进程用 Node fetch 直连（不走
 * 系统代理，与 CLI 行为一致）。access_token 绝不写日志、绝不进渲染层——
 * 返回给渲染层的只有算好的展示数据（PlanUsageInfo）。
 *
 * TODO(auth): token 过期后目前只提示重新登录；refresh_token 自动刷新未实现。
 */

const USAGES_URL = 'https://api.kimi.com/coding/v1/usages'
const REQUEST_TIMEOUT_MS = 15000

const AUTH_EXPIRED_MESSAGE = '登录态已过期，请在终端运行 kimi login 后重试'
const NETWORK_ERROR_MESSAGE = '网络错误，无法连接 Kimi 云端接口'

function credentialsPath(): string {
  return join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
}

function readAccessToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as unknown
    const token = (raw as { access_token?: unknown } | null)?.access_token
    return typeof token === 'string' && token ? token : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function asNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asResetAt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function windowLabel(duration: number | undefined, timeUnit: string | undefined, fallback: string): string {
  if (duration === undefined) return fallback
  if (timeUnit === 'TIME_UNIT_MINUTE') {
    return duration >= 60 && duration % 60 === 0 ? `${duration / 60} 小时` : `${duration} 分钟`
  }
  if (timeUnit === 'TIME_UNIT_HOUR') return `${duration} 小时`
  if (timeUnit === 'TIME_UNIT_DAY') return `${duration} 天`
  return fallback
}

function parseLimitWindow(value: unknown, label: string): UsageLimitWindow | undefined {
  const detail = asRecord(value)
  if (!detail) return undefined
  const window: UsageLimitWindow = {
    label,
    ...(asNum(detail.limit) !== undefined ? { limit: asNum(detail.limit) } : {}),
    ...(asNum(detail.used) !== undefined ? { used: asNum(detail.used) } : {}),
    ...(asNum(detail.remaining) !== undefined ? { remaining: asNum(detail.remaining) } : {}),
    ...(asResetAt(detail.resetTime) !== undefined ? { resetAt: asResetAt(detail.resetTime) } : {})
  }
  return window.limit === undefined && window.used === undefined ? undefined : window
}

function parsePlanUsage(payload: unknown): PlanUsageInfo {
  const root = asRecord(payload) ?? {}
  const info: PlanUsageInfo = {}

  const membership = asRecord(asRecord(root.user)?.membership)
  const level = asString(membership?.level)
  if (level) info.membershipLevel = level

  const weekly = parseLimitWindow(root.usage, '每周')
  if (weekly) info.weekly = weekly

  if (Array.isArray(root.limits)) {
    for (const entry of root.limits) {
      const record = asRecord(entry)
      if (!record) continue
      const window = asRecord(record.window)
      const label = windowLabel(asNum(window?.duration), asString(window?.timeUnit), '滚动窗口')
      const rolling = parseLimitWindow(record.detail, label)
      if (rolling) {
        info.rolling = rolling
        break
      }
    }
  }

  const parallelLimit = asNum(asRecord(root.parallel)?.limit)
  if (parallelLimit !== undefined) info.parallelLimit = parallelLimit

  const wallet = asRecord(root.boosterWallet)
  if (wallet) {
    const usedCents = asNum(asRecord(wallet.monthlyUsed)?.priceInCents)
    const limitCents = asNum(asRecord(wallet.monthlyChargeLimit)?.priceInCents)
    info.boosterWallet = {
      ...(usedCents !== undefined ? { monthlyUsedCny: usedCents / 100 } : {}),
      ...(limitCents !== undefined ? { monthlyLimitCny: limitCents / 100 } : {})
    }
  }

  return info
}

export async function fetchPlanUsage(): Promise<PlanUsageResult> {
  const token = readAccessToken()
  if (!token) return { ok: false, error: AUTH_EXPIRED_MESSAGE }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(USAGES_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
  } catch (error) {
    log('usage', `plan usage fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: NETWORK_ERROR_MESSAGE }
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: AUTH_EXPIRED_MESSAGE }
  }
  if (!response.ok) {
    return { ok: false, error: `云端接口返回 ${response.status}` }
  }

  try {
    const payload = (await response.json()) as unknown
    return { ok: true, data: parsePlanUsage(payload) }
  } catch (error) {
    log('usage', `plan usage parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: '云端返回数据无法解析' }
  }
}

/** --- 60s 缓存轮询：状态栏圆环/悬停预览共用，避免每次悬停都打云端接口。
 *  <30s 直接回缓存；30–60s 先回缓存、后台刷新；>60s 等刷新。 */
const CACHE_FRESH_MS = 30_000
const CACHE_MAX_MS = 60_000

let planUsageCache: { at: number; result: PlanUsageResult } | null = null
let planUsageInflight: Promise<PlanUsageResult> | null = null

function refreshPlanUsage(): Promise<PlanUsageResult> {
  if (!planUsageInflight) {
    planUsageInflight = fetchPlanUsage()
      .then((result) => {
        // 失败时保留旧缓存兜底（有缓存回缓存，没缓存回错误）。
        if (result.ok) planUsageCache = { at: Date.now(), result }
        planUsageInflight = null
        return planUsageCache?.result ?? result
      })
      .catch((error) => {
        planUsageInflight = null
        log('usage', `plan usage refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        return planUsageCache?.result ?? { ok: false as const, error: NETWORK_ERROR_MESSAGE }
      })
  }
  return planUsageInflight
}

export function getPlanUsageCached(): Promise<PlanUsageResult> {
  const cached = planUsageCache
  if (!cached) return refreshPlanUsage()
  const age = Date.now() - cached.at
  if (age < CACHE_FRESH_MS) return Promise.resolve(cached.result)
  if (age < CACHE_MAX_MS) {
    void refreshPlanUsage()
    return Promise.resolve(cached.result)
  }
  return refreshPlanUsage()
}
