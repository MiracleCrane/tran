import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kimiHome } from './kimiHome'
import { writeJsonAtomic } from './atomicWrite'
import { log } from './logger'
import { loadSettings } from './settings'
import type { PlanUsageInfo, PlanUsageResult, UsageLimitWindow } from '../shared/ipc'

/**
 * 套餐额度（Kimi 云端 API）。与 Kimi CLI 同款数据源：
 * GET https://api.kimi.com/coding/v1/usages，Bearer 为 CLI 的 OAuth access_token
 * （$KIMI_CODE_HOME/credentials/kimi-code.json，未设时回退 ~/.kimi-code）。主进程用 Node fetch 直连（不走
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
  // 写死 ~/.kimi-code 会读到轮换前的旧 refresh_token，刷新必然 400（见 kimiHome.ts）。
  return join(kimiHome(), 'credentials', 'kimi-code.json')
}

function readCredentials(): OAuthCredentials | null {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as OAuthCredentials
  } catch {
    return null
  }
}

/**
 * expires_at 允许是 ISO 字符串或 epoch 数字（不同 CLI 版本写法不同）。
 * 此前一律 Date.parse(String(...))，数字形式会得到 NaN → 记为 0 → 每次调用
 * 都判定为已过期，导致每个请求都强制刷新，把轮换的 refresh_token 转个不停。
 */
function expiryMs(creds: OAuthCredentials): number {
  const raw = creds.expires_at
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 秒级时间戳（10 位量级）按秒处理，其余按毫秒。
    return raw < 1e12 ? raw * 1000 : raw
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const numeric = Number(raw)
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
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

/**
 * 同一时刻只允许一次刷新。refresh_token 是轮换的（用一次就作废），并发刷新
 * 会让第二个请求拿着已被消费的 token 去换，服务端拒绝 → 该调用方误判为
 * 「需要重新登录」。usageService 与 aiTitles 共用这条凭证链，并发是常态。
 */
let inflightRefresh: Promise<string | null> | null = null

async function refreshAndPersist(creds: OAuthCredentials): Promise<string | null> {
  if (!creds.refresh_token) return null
  const refreshed = await refreshAccessToken(creds.refresh_token)
  if (!refreshed?.access_token) return null
  const next: OAuthCredentials = {
    ...creds,
    ...refreshed,
    expires_at: new Date(Date.now() + (refreshed.expires_in ?? 900) * 1000).toISOString()
  }
  try {
    writeJsonAtomic(credentialsPath(), next)
  } catch (error) {
    log('usage', `credentials write-back failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return next.access_token ?? null
}

/** 取有效 access_token：未过期直接用；过期则 refresh 并写回（refresh_token 轮换）。
 *  forceRefresh 用于 /usages 401 后的重试。aiTitles 模块复用同一凭证链。 */
export async function getValidAccessToken(forceRefresh = false): Promise<string | null> {
  const creds = readCredentials()
  if (!creds?.access_token) return null
  const expired = expiryMs(creds) - EXPIRY_SKEW_MS < Date.now()
  if (!expired && !forceRefresh) return creds.access_token
  if (!creds.refresh_token) return null

  // 已有刷新在飞行中就复用它，避免重复消费 refresh_token。
  if (inflightRefresh) return inflightRefresh
  const run = refreshAndPersist(creds).finally(() => {
    if (inflightRefresh === run) inflightRefresh = null
  })
  inflightRefresh = run
  return run
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
  // 显式开关（默认开）：这条链路直连 Kimi 云端私有接口并复用 CLI 的 OAuth
  // 凭证（含 refresh_token 轮换写回）。用户关掉后不发任何请求、不碰凭证文件。
  if (loadSettings().cloudUsageEnabled === false) {
    return { ok: false, error: '云端额度查询已在设置中关闭' }
  }
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
/**
 * 失败兜底的**保质期**。超过这个时长的缓存宁可不给，让调用方看到错误。
 *
 * 原来是无上限回落：只要成功过一次，之后不管失败多少次都继续返回那份旧数据。
 * 掉登录之后的表现是——额度环永远显示掉线前那一刻的数字，不报错、不变灰，
 * 用户完全看不出它已经停更了。**过期的额度比没有额度更有害**：它看起来是对的。
 */
const STALE_FALLBACK_MAX_MS = 5 * 60_000

let planUsageCache: { at: number; result: PlanUsageResult } | null = null
let planUsageInflight: Promise<PlanUsageResult> | null = null

/** 刷新失败时：缓存还在保质期内就先顶着，过期了就如实报错。 */
function fallbackOnFailure(failure: PlanUsageResult): PlanUsageResult {
  const cached = planUsageCache
  if (cached && Date.now() - cached.at < STALE_FALLBACK_MAX_MS) return cached.result
  planUsageCache = null
  return failure
}

function refreshPlanUsage(): Promise<PlanUsageResult> {
  if (!planUsageInflight) {
    planUsageInflight = fetchPlanUsage()
      .then((result) => {
        planUsageInflight = null
        if (result.ok) {
          planUsageCache = { at: Date.now(), result }
          return result
        }
        return fallbackOnFailure(result)
      })
      .catch((error) => {
        planUsageInflight = null
        log('usage', `plan usage refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        return fallbackOnFailure({ ok: false as const, error: NETWORK_ERROR_MESSAGE })
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
