import { readFileSync, writeFileSync } from 'node:fs'
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
 * token 自动续期：access_token 过期（或 /usages 回 401）时，用 refresh_token 走
 * 标准 OAuth2 刷新（POST auth.kimi.com/api/oauth/token，form: client_id +
 * grant_type=refresh_token），新 token 写回 credentials 文件（refresh_token
 * 会轮换，必须写回）。刷新失败才提示重新登录。
 */

const USAGES_URL = 'https://api.kimi.com/coding/v1/usages'
const OAUTH_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token'
const OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const REQUEST_TIMEOUT_MS = 15000
const EXPIRY_SKEW_MS = 60_000

const AUTH_EXPIRED_MESSAGE = '登录态已过期，请在终端运行 kimi login 后重试'
const NETWORK_ERROR_MESSAGE = '网络错误，无法连接 Kimi 云端接口'

interface OAuthCredentials {
  access_token?: string
  refresh_token?: string
  expires_at?: string | number
  token_type?: string
  scope?: string
  expires_in?: number
}

function credentialsPath(): string {
  return join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
}

function readCredentials(): OAuthCredentials | null {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as OAuthCredentials
  } catch {
    return null
  }
}

function expiryMs(creds: OAuthCredentials): number {
  const parsed = Date.parse(String(creds.expires_at ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      log('usage', `token refresh rejected: ${response.status}`)
      return null
    }
    return (await response.json()) as OAuthCredentials
  } catch (error) {
    log('usage', `token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 取有效 access_token：未过期直接用；过期则 refresh 并写回（refresh_token 轮换）。
 *  forceRefresh 用于 /usages 401 后的重试。 */
async function getValidAccessToken(forceRefresh = false): Promise<string | null> {
  const creds = readCredentials()
  if (!creds?.access_token) return null
  const expired = expiryMs(creds) - EXPIRY_SKEW_MS < Date.now()
  if (!expired && !forceRefresh) return creds.access_token
  if (!creds.refresh_token) return null
  const refreshed = await refreshAccessToken(creds.refresh_token)
  if (!refreshed?.access_token) return null
  const next: OAuthCredentials = {
    ...creds,
    ...refreshed,
    expires_at: new Date(Date.now() + (refreshed.expires_in ?? 900) * 1000).toISOString()
  }
  try {
    writeFileSync(credentialsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    log('usage', `credentials write-back failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return next.access_token ?? null
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
  let token = await getValidAccessToken()
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

  // 401/403：强制刷新一次 token 重试（时钟偏差/服务端提前失效等情况）。
  if (response.status === 401 || response.status === 403) {
    token = await getValidAccessToken(true)
    if (!token) return { ok: false, error: AUTH_EXPIRED_MESSAGE }
    const retryController = new AbortController()
    const retryTimer = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT_MS)
    try {
      response = await fetch(USAGES_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        signal: retryController.signal
      })
    } catch (error) {
      log('usage', `plan usage retry failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, error: NETWORK_ERROR_MESSAGE }
    } finally {
      clearTimeout(retryTimer)
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: AUTH_EXPIRED_MESSAGE }
    }
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
