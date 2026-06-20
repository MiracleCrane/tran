import { createHash, randomBytes } from 'node:crypto'
import { log } from './logger'

/**
 * Baidu generic-translate API client (通用翻译API).
 *
 * Leaf module — no imports from translate.ts / translateConfig.ts, so both can
 * depend on it without forming an import cycle. Used by translate.ts (batch
 * skill/plugin description translation) and translateConfig.testTranslate
 * (credential check).
 *
 * Endpoint: https://fanyi-api.baidu.com/api/trans/vip/translate
 * Auth: appid + secretKey; request is signed with md5(appid + q + salt + key)
 * computed over the RAW (un-URL-encoded) query — a classic Baidu gotcha.
 */

const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate'

function md5Hex(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex')
}

interface BaiduSuccess {
  from?: string
  to?: string
  trans_result?: Array<{ src?: string; dst?: string }>
}
interface BaiduError {
  error_code?: string
  error_msg?: string
}

/**
 * Translate a batch of texts EN→ZH via Baidu. Returns one translation per input
 * (in order; empty string for any input that didn't get a result). Mirrors the
 * LLM path's dedupe-then-map-back contract so callers are interchangeable.
 *
 * Baidu uses `\n` as an in-query sentence separator, so each input's internal
 * newlines are collapsed to spaces first, then inputs are joined with `\n`.
 */
export async function translateViaBaidu(
  texts: string[],
  appId: string,
  secretKey: string
): Promise<string[]> {
  const deduped = Array.from(new Set(texts.filter((t) => t && t.trim())))
  if (deduped.length === 0) return []

  const normalized = deduped.map((t) => t.replace(/\r?\n/g, ' '))
  const q = normalized.join('\n')

  const salt = randomBytes(8).toString('hex')
  const sign = md5Hex(appId + q + salt + secretKey)
  const body = new URLSearchParams({
    q,
    from: 'en',
    to: 'zh',
    appid: appId,
    salt,
    sign
  }).toString()

  log('baidu', `translating ${deduped.length} text(s)`)
  const res = await fetch(BAIDU_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`百度翻译请求失败 (HTTP ${res.status}): ${detail.slice(0, 200)}`)
  }

  const data = (await res.json()) as BaiduSuccess & BaiduError
  if (data.error_code) {
    throw new Error(`百度翻译错误 ${data.error_code}: ${data.error_msg ?? '未知错误'}`)
  }

  const translated = (data.trans_result ?? []).map((r) => r.dst ?? '')

  // map back to the (possibly duplicated) input order
  const map = new Map<string, string>()
  deduped.forEach((t, i) => {
    if (translated[i]) map.set(t, translated[i])
  })
  return texts.map((t) => map.get(t) ?? '')
}
