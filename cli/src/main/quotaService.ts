import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger'
import type {
  QuotaAction,
  QuotaActionsResult,
  QuotaBoosterWallet,
  QuotaOverview,
  QuotaOverviewResult,
  QuotaRatelimitWindow
} from '../shared/ipc'

/**
 * 额度明细（对齐 Kimi 网页版"我的额度/使用明细"）。与 kimi-desktop 同款数据源：
 * Connect RPC（Protobuf 服务端兼容 JSON，直接 POST JSON，proto 默认 camelCase 字段名）
 *   POST https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/<Method>
 * 实测（2026-07）：
 *   - GetSubscriptionStats 单接口即覆盖总览（ratelimit_5h/7d/code_5h/code_7d +
 *     subscription_balance[amount_used_ratio/kimi_code_used_ratio] + booster_wallets）；
 *     免费/非 Code 账号可能只有部分字段，缺什么 UI 显示什么。
 *   - ListBalanceActions 支持 page_token 翻页；page_size 会被服务端钳到默认 ~20，
 *     filter.features 实测回 400（未用）。
 *   - X-Traffic-Id 头非必需（不带也 200），有 msh_user_id 就带上。
 *
 * 登录态（A 主 B 兜底）：
 *   A. kimi-desktop bridge-store/token-store.json（appData/kimi-desktop/...，
 *      结构 { origin, tokens: { access_token, refresh_token, msh_user_id } }）。
 *      access_token 过期（或 RPC 回 401/403）时 GET /api/auth/token/refresh
 *      （Bearer refresh_token）换新并写回原文件（refresh_token 会轮换）。
 *   B. A 读不到且 refresh 也失败 → 开 BrowserWindow 让用户登录 kimi.com，
 *      从 localStorage 提取 JWT（payload.typ=access/refresh 分类，sub=user id），
 *      存到 userData/kimi-quota-token.json 复用。
 * token 值绝不写日志、绝不进渲染层——日志只出现"已获取/已刷新"这类状态。
 */

const RPC_BASE = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService'
const REFRESH_URL = 'https://www.kimi.com/api/auth/token/refresh'
const KIMI_HOME = 'https://www.kimi.com'
const REQUEST_TIMEOUT_MS = 30_000
const EXPIRY_SKEW_MS = 60_000
const ACTIONS_PAGE_SIZE = 20

const AUTH_MESSAGE = '未获取到 Kimi 网页登录态，请登录后重试'
const NETWORK_ERROR_MESSAGE = '网络错误，无法连接 Kimi 云端接口'

interface QuotaTokens {
  access_token?: string
  refresh_token?: string
  msh_user_id?: string
  [key: string]: unknown
}

type TokenSource = 'desktop' | 'local'

function tokenPath(source: TokenSource): string {
  return source === 'desktop'
    ? join(app.getPath('appData'), 'kimi-desktop', 'bridge-store', 'token-store.json')
    : join(app.getPath('userData'), 'kimi-quota-token.json')
}

function readTokens(source: TokenSource): QuotaTokens | null {
  try {
    const raw = JSON.parse(readFileSync(tokenPath(source), 'utf8')) as Record<string, unknown>
    // desktop 文件包了一层 { origin, tokens }；local 文件直接就是 tokens。
    const tokens = source === 'desktop' ? raw.tokens : raw
    if (!tokens || typeof tokens !== 'object') return null
    const t = tokens as QuotaTokens
    return t.access_token || t.refresh_token ? t : null
  } catch {
    return null
  }
}

function writeTokens(source: TokenSource, tokens: QuotaTokens): void {
  try {
    if (source === 'desktop') {
      // 读改写，保留 origin 等其它字段；文件被桌面版更新过时以盘上最新为准。
      const raw = JSON.parse(readFileSync(tokenPath(source), 'utf8')) as Record<string, unknown>
      raw.tokens = tokens
      writeFileSync(tokenPath(source), JSON.stringify(raw, null, 2), 'utf8')
    } else {
      writeFileSync(tokenPath(source), JSON.stringify(tokens, null, 2), 'utf8')
    }
  } catch (error) {
    log('quota', `token write-back failed (${source}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function jwtExpiryMs(token: string | undefined): number {
  if (!token) return 0
  const exp = jwtPayload(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0
}

async function refreshTokens(refreshToken: string): Promise<QuotaTokens | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(REFRESH_URL, {
      headers: { authorization: `Bearer ${refreshToken}` },
      signal: controller.signal
    })
    if (!response.ok) {
      log('quota', `token refresh rejected: ${response.status}`)
      return null
    }
    return (await response.json()) as QuotaTokens
  } catch (error) {
    log('quota', `token refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

interface TokenContext {
  token: string
  trafficId?: string
}

/** 取有效 access_token：依次试 desktop → local；过期用 refresh_token 换新写回。
 *  forceRefresh 用于 RPC 401/403 后的重试。 */
async function getValidToken(forceRefresh = false): Promise<TokenContext | null> {
  for (const source of ['desktop', 'local'] as const) {
    const tokens = readTokens(source)
    if (!tokens?.access_token) continue
    const expired = jwtExpiryMs(tokens.access_token) - EXPIRY_SKEW_MS < Date.now()
    if (!expired && !forceRefresh) {
      return { token: tokens.access_token, ...(tokens.msh_user_id ? { trafficId: tokens.msh_user_id } : {}) }
    }
    if (!tokens.refresh_token) continue
    const refreshed = await refreshTokens(tokens.refresh_token)
    if (!refreshed?.access_token) continue
    const freshToken: string = refreshed.access_token
    const next: QuotaTokens = {
      ...tokens,
      ...refreshed,
      msh_user_id: tokens.msh_user_id
    }
    writeTokens(source, next)
    log('quota', `token refreshed (${source})`)
    return { token: freshToken, ...(next.msh_user_id ? { trafficId: next.msh_user_id } : {}) }
  }
  return null
}

interface RpcResponse {
  status: number
  json: unknown
}

async function rpc(method: string, body: Record<string, unknown>, ctx: TokenContext): Promise<RpcResponse | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json',
        ...(ctx.trafficId ? { 'x-traffic-id': ctx.trafficId } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    log('quota', `${method} fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

type RpcError = { error: string; needsLogin?: boolean }

/** 带鉴权重试的 RPC：401/403 强制刷新一次 token 重试；仍失败则要求重新登录。 */
async function callRpc(
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: true; json: unknown } | { ok: false } & RpcError> {
  let ctx = await getValidToken()
  if (!ctx) return { ok: false, error: AUTH_MESSAGE, needsLogin: true }
  let res = await rpc(method, body, ctx)
  if (res && (res.status === 401 || res.status === 403)) {
    ctx = await getValidToken(true)
    if (!ctx) return { ok: false, error: AUTH_MESSAGE, needsLogin: true }
    res = await rpc(method, body, ctx)
    if (res && (res.status === 401 || res.status === 403)) {
      return { ok: false, error: AUTH_MESSAGE, needsLogin: true }
    }
  }
  if (!res) return { ok: false, error: NETWORK_ERROR_MESSAGE }
  if (res.status !== 200 || res.json === null) {
    log('quota', `${method} rejected: ${res.status}`)
    return { ok: false, error: `云端接口返回 ${res.status}` }
  }
  return { ok: true, json: res.json }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
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

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asTimeMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asMoneyCny(value: unknown): number | undefined {
  const cents = asNum(asRecord(value)?.priceInCents)
  return cents !== undefined ? cents / 100 : undefined
}

function parseRatelimit(value: unknown): QuotaRatelimitWindow | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const window: QuotaRatelimitWindow = {
    ...(asNum(record.ratio) !== undefined ? { ratio: asNum(record.ratio) } : {}),
    ...(asBool(record.enabled) !== undefined ? { enabled: asBool(record.enabled) } : {}),
    ...(asTimeMs(record.resetTime) !== undefined ? { resetAt: asTimeMs(record.resetTime) } : {})
  }
  return window.ratio === undefined && window.resetAt === undefined ? undefined : window
}

function parseBoosterWallet(value: unknown): QuotaBoosterWallet | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const limitEnabled = asBool(record.monthlyChargeLimitEnabled) === true
  return {
    enabled: asString(record.status) === 'STATUS_ENABLED',
    ...(asMoneyCny(record.moneyLeft) !== undefined ? { balanceCny: asMoneyCny(record.moneyLeft) } : {}),
    ...(asMoneyCny(record.moneyTotal) !== undefined ? { totalCny: asMoneyCny(record.moneyTotal) } : {}),
    ...(asMoneyCny(record.monthlyUsed) !== undefined ? { monthlyUsedCny: asMoneyCny(record.monthlyUsed) } : {}),
    ...(limitEnabled && asMoneyCny(record.monthlyChargeLimit) !== undefined
      ? { monthlyLimitCny: asMoneyCny(record.monthlyChargeLimit) }
      : {})
  }
}

function parseOverview(payload: unknown): QuotaOverview {
  const root = asRecord(payload) ?? {}
  const overview: QuotaOverview = {}

  const balance = asRecord(root.subscriptionBalance)
  if (balance) {
    if (asNum(balance.amountUsedRatio) !== undefined) overview.totalUsedRatio = asNum(balance.amountUsedRatio)
    if (asNum(balance.kimiCodeUsedRatio) !== undefined) overview.codeUsedRatio = asNum(balance.kimiCodeUsedRatio)
    if (asTimeMs(balance.expireTime) !== undefined) overview.expireAt = asTimeMs(balance.expireTime)
  }

  const rl5h = parseRatelimit(root.ratelimit5h)
  if (rl5h) overview.ratelimit5h = rl5h
  const rl7d = parseRatelimit(root.ratelimit7d)
  if (rl7d) overview.ratelimit7d = rl7d
  const rlCode5h = parseRatelimit(root.ratelimitCode5h)
  if (rlCode5h) overview.ratelimitCode5h = rlCode5h
  const rlCode7d = parseRatelimit(root.ratelimitCode7d)
  if (rlCode7d) overview.ratelimitCode7d = rlCode7d

  if (Array.isArray(root.boosterWallets)) {
    for (const entry of root.boosterWallets) {
      const wallet = parseBoosterWallet(entry)
      if (wallet) {
        overview.boosterWallet = wallet
        break
      }
    }
  }

  if (asBool(root.overdrawn) !== undefined) overview.overdrawn = asBool(root.overdrawn)
  return overview
}

export async function fetchQuotaOverview(): Promise<QuotaOverviewResult> {
  const res = await callRpc('GetSubscriptionStats', {})
  if (!res.ok) return { ok: false, error: res.error, ...(res.needsLogin ? { needsLogin: true } : {}) }
  return { ok: true, data: parseOverview(res.json) }
}

function parseActions(payload: unknown): { actions: QuotaAction[]; nextPageToken?: string } {
  const root = asRecord(payload) ?? {}
  const actions: QuotaAction[] = []
  if (Array.isArray(root.actions)) {
    for (const entry of root.actions) {
      const record = asRecord(entry)
      const id = asString(record?.id)
      if (!record || !id) continue
      const items: QuotaAction['items'] = []
      if (Array.isArray(record.items)) {
        for (const rawItem of record.items) {
          const item = asRecord(rawItem)
          if (!item) continue
          items.push({
            ...(asNum(item.amount) !== undefined ? { amount: asNum(item.amount) } : {}),
            ...(asNum(item.amountRatio) !== undefined ? { amountRatio: asNum(item.amountRatio) } : {}),
            ...(asString(item.unit) ? { unit: asString(item.unit) } : {}),
            ...(asMoneyCny(item.amountMoney) !== undefined ? { amountMoneyCny: asMoneyCny(item.amountMoney) } : {})
          })
        }
      }
      actions.push({
        id,
        ...(asString(record.feature) ? { feature: asString(record.feature) } : {}),
        ...(asString(record.title) ? { title: asString(record.title) } : {}),
        ...(asString(record.status) ? { status: asString(record.status) } : {}),
        ...(asTimeMs(record.timestamp) !== undefined ? { timestamp: asTimeMs(record.timestamp) } : {}),
        items
      })
    }
  }
  const nextPageToken = asString(root.nextPageToken)
  return { actions, ...(nextPageToken ? { nextPageToken } : {}) }
}

export async function fetchQuotaActions(pageToken?: string): Promise<QuotaActionsResult> {
  const body: Record<string, unknown> = { pageSize: ACTIONS_PAGE_SIZE }
  if (pageToken) body.pageToken = pageToken
  const res = await callRpc('ListBalanceActions', body)
  if (!res.ok) return { ok: false, error: res.error, ...(res.needsLogin ? { needsLogin: true } : {}) }
  const parsed = parseActions(res.json)
  return { ok: true, actions: parsed.actions, ...(parsed.nextPageToken ? { nextPageToken: parsed.nextPageToken } : {}) }
}

/** 兜底登录（B 通路）：开 Kimi 网页登录窗，轮询 localStorage 提取 JWT。
 *  token 只留在主进程并写入 userData/kimi-quota-token.json；绝不进日志。 */
export function runQuotaLogin(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      autoHideMenuBar: true,
      title: '登录 Kimi',
      webPreferences: { partition: 'persist:kimi-quota', contextIsolation: true }
    })

    const done = (result: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearInterval(timer)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }

    const tryExtract = async (): Promise<void> => {
      if (settled || win.isDestroyed()) return
      if (!win.webContents.getURL().startsWith(KIMI_HOME)) return
      let entries: Record<string, string>
      try {
        entries = (await win.webContents.executeJavaScript(
          `(() => {
            const out = {}
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i)
              const v = localStorage.getItem(k)
              if (typeof v === 'string' && /^eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(v)) out[k] = v
            }
            return out
          })()`,
          true
        )) as Record<string, string>
      } catch {
        return
      }
      let access: string | undefined
      let refresh: string | undefined
      for (const value of Object.values(entries ?? {})) {
        const typ = jwtPayload(value)?.typ
        if (typ === 'access' && !access) access = value
        if (typ === 'refresh' && !refresh) refresh = value
      }
      if (!access) return
      const sub = jwtPayload(access)?.sub
      const tokens: QuotaTokens = {
        access_token: access,
        ...(refresh ? { refresh_token: refresh } : {}),
        ...(typeof sub === 'string' && sub ? { msh_user_id: sub } : {})
      }
      writeTokens('local', tokens)
      log('quota', 'login token acquired (web fallback)')
      done({ ok: true })
    }

    win.on('closed', () => done({ ok: false, error: '已取消登录' }))
    win.webContents.on('did-navigate', () => void tryExtract())
    win.webContents.on('did-navigate-in-page', () => void tryExtract())
    win.webContents.on('did-finish-load', () => void tryExtract())
    timer = setInterval(() => void tryExtract(), 2000)
    void win.loadURL(KIMI_HOME).catch(() => done({ ok: false, error: NETWORK_ERROR_MESSAGE }))
  })
}
