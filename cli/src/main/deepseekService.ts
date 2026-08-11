import { getApiKey, getDeepseekApiKey } from './settings'
import { log } from './logger'
import type { DeepseekBalanceInfo, DeepseekBalanceResult } from '../shared/ipc'

/**
 * DeepSeek 账户余额（官方公开接口，用量卡展示用）：
 * GET https://api.deepseek.com/user/balance，Bearer 为设置页保存的 API key。
 * 接口只给余额（总/赠金/充值），没有 token 用量明细——官方就暴露这么多。
 * 主进程用 Node fetch 直连（不走系统代理，与 usageService 行为一致）。
 * API key 绝不写日志、绝不进渲染层——返回给渲染层的只有算好的展示数据。
 */

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 15000
const CACHE_MS = 60_000

const NO_KEY_MESSAGE = '未配置 API key（设置 → 系统 的摘要 Key，或设置 → DeepSeek 余额）'
const NETWORK_ERROR_MESSAGE = '网络错误，无法连接 DeepSeek 接口'

interface BalancePayload {
  is_available?: boolean
  balance_infos?: {
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }[]
}

let cache: { at: number; result: DeepseekBalanceResult } | null = null
let inflight: Promise<DeepseekBalanceResult> | null = null

async function fetchBalance(): Promise<DeepseekBalanceResult> {
  // 优先用「设置 → DeepSeek 余额」的专用 key；没配就复用摘要旁路那把
  // （设置 → 系统 的 API Key）——用户本来就只存了一把 DeepSeek key，
  // 专用栏空着导致余额行永远不显示（2026-08 用户反馈）。
  const key = getDeepseekApiKey() ?? getApiKey()
  if (!key) return { ok: false, error: NO_KEY_MESSAGE }

  const controller = new AbortController()
  // 超时要盖住整个请求（响应头 + body）：原先 clearTimeout 在 fetch 的
  // finally 里，body 停滞时 response.json() 无限期挂起，inflight 永不清空，
  // 余额从此永远"加载中"直到重启。
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timer)
    log('deepseek', `balance fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: NETWORK_ERROR_MESSAGE }
  }

  if (response.status === 401 || response.status === 403) {
    clearTimeout(timer)
    return { ok: false, error: 'DeepSeek API key 无效，请在设置里检查' }
  }
  if (!response.ok) {
    clearTimeout(timer)
    return { ok: false, error: `DeepSeek 接口返回 ${response.status}` }
  }

  try {
    const payload = (await response.json()) as BalancePayload
    const info = payload.balance_infos?.[0]
    if (!info) return { ok: false, error: 'DeepSeek 返回数据无法解析' }
    const data: DeepseekBalanceInfo = {
      isAvailable: payload.is_available ?? true,
      currency: info.currency ?? 'CNY',
      totalBalance: info.total_balance ?? '—',
      grantedBalance: info.granted_balance ?? '—',
      toppedUpBalance: info.topped_up_balance ?? '—'
    }
    return { ok: true, data }
  } catch (error) {
    log('deepseek', `balance parse failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, error: 'DeepSeek 返回数据无法解析' }
  } finally {
    clearTimeout(timer)
  }
}

/** 60s 缓存：用量卡每次展开都打接口太浪费，余额本身变化就慢。
 *  key 变更后调用方应走 invalidateDeepseekBalanceCache() 立即重拉。 */
export function getDeepseekBalanceCached(): Promise<DeepseekBalanceResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.result)
  if (!inflight) {
    inflight = fetchBalance()
      .then((result) => {
        inflight = null
        if (result.ok) cache = { at: Date.now(), result }
        return result
      })
      .catch((error) => {
        inflight = null
        log('deepseek', `balance refresh failed: ${error instanceof Error ? error.message : String(error)}`)
        return { ok: false, error: NETWORK_ERROR_MESSAGE }
      })
  }
  return inflight
}

export function invalidateDeepseekBalanceCache(): void {
  cache = null
}
