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
/** 请求超时：此前无超时，连接挂起时翻译调用永不落地。 */
const BAIDU_TIMEOUT_MS = 30000

/**
 * 熔断：不会自愈的错误（欠费 54004、未授权 52003、签名错 54001、服务关闭
 * 58002）触发后，本次运行内不再发起百度请求——2026-08 实测欠费时思考翻译的
 * 重试把 main.log 刷成每秒上百条失败。限频 54003 是会自愈的，只熔断 60s。
 * 换了凭据（保存翻译设置）会重置。
 */
const FATAL_CODES = new Set(['54004', '52003', '54001', '58002'])
const RATE_LIMIT_COOLDOWN_MS = 60_000
let fatalTrippedReason: string | null = null
let rateLimitedUntil = 0

/** 百度通道当前是否被熔断；返回原因文案（null = 可用）。 */
export function baiduTripped(): string | null {
  if (fatalTrippedReason) return fatalTrippedReason
  if (Date.now() < rateLimitedUntil) return '百度翻译限频冷却中'
  return null
}

/** 保存了新的百度凭据时调用：给新钥匙一次机会。 */
export function resetBaiduBreaker(): void {
  fatalTrippedReason = null
  rateLimitedUntil = 0
}

function tripOnError(code: string, msg: string): void {
  if (FATAL_CODES.has(code)) {
    fatalTrippedReason = `百度翻译错误 ${code}: ${msg}（本次运行内不再重试）`
    log('baidu', `熔断：${fatalTrippedReason}`)
  } else if (code === '54003') {
    rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
  }
}

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
 * 原始请求：q 里以 `\n` 分句，返回与分句一一对应的译文数组。
 * 签名按 RAW（未 URL 编码）文本计算——百度经典坑。
 */
async function postTranslate(q: string, appId: string, secretKey: string): Promise<string[]> {
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BAIDU_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`百度翻译请求超时（${BAIDU_TIMEOUT_MS / 1000}s）`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`百度翻译请求失败 (HTTP ${res.status}): ${detail.slice(0, 200)}`)
  }

  let data: BaiduSuccess & BaiduError
  try {
    data = (await res.json()) as BaiduSuccess & BaiduError
  } catch {
    throw new Error('百度翻译响应不是合法 JSON')
  }
  if (data.error_code) {
    tripOnError(String(data.error_code), data.error_msg ?? '未知错误')
    throw new Error(`百度翻译错误 ${data.error_code}: ${data.error_msg ?? '未知错误'}`)
  }
  return (data.trans_result ?? []).map((r) => r.dst ?? '')
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

  const tripped = baiduTripped()
  if (tripped) throw new Error(tripped)
  const normalized = deduped.map((t) => t.replace(/\r?\n/g, ' '))
  const q = normalized.join('\n')
  log('baidu', `translating ${deduped.length} text(s)`)
  const translated = await postTranslate(q, appId, secretKey)

  // map back to the (possibly duplicated) input order
  const map = new Map<string, string>()
  deduped.forEach((t, i) => {
    if (translated[i]) map.set(t, translated[i])
  })
  return texts.map((t) => map.get(t) ?? '')
}

/** 百度单次请求的 q 上限约 6000 字节，留余量切块。 */
const LONG_TEXT_CHUNK_BYTES = 5000

/**
 * 长文翻译（思考块全文）：按行切开、按字节数切块、逐块翻译后拼回，
 * **保留原有换行结构**——translateViaBaidu 会把换行压成空格，那是给
 * 短句批量翻译用的，长文一压 markdown 结构就全糊了（2026-08 用户实测诉求）。
 *
 * 空行不参与翻译（百度会跳过它们，导致结果序号错位），译完按原位置插回。
 * 任一块结果行数对不上就抛错——错位拼回比不翻更糟，调用方会显示原文。
 */
export async function translateLongTextViaBaidu(
  text: string,
  appId: string,
  secretKey: string
): Promise<string> {
  const tripped = baiduTripped()
  if (tripped) throw new Error(tripped)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const result: string[] = new Array<string>(lines.length).fill('')

  // 切块：每块是若干「非空行」的（行号, 原文）对，块内总字节数不超上限。
  interface Chunk {
    indices: number[]
    q: string
    bytes: number
  }
  const chunks: Chunk[] = []
  let current: Chunk = { indices: [], q: '', bytes: 0 }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    // 单行就超上限的（罕见：一整行几千字节的 minified 代码）截断保平安。
    const safeLine = lineBytes > LONG_TEXT_CHUNK_BYTES ? line.slice(0, LONG_TEXT_CHUNK_BYTES / 2) : line
    if (current.bytes + lineBytes > LONG_TEXT_CHUNK_BYTES && current.indices.length > 0) {
      chunks.push(current)
      current = { indices: [], q: '', bytes: 0 }
    }
    current.indices.push(i)
    current.q += (current.q ? '\n' : '') + safeLine
    current.bytes += lineBytes
  }
  if (current.indices.length > 0) chunks.push(current)

  log('baidu', `long-text translating ${lines.length} line(s) in ${chunks.length} chunk(s)`)
  for (const chunk of chunks) {
    const translated = await postTranslate(chunk.q, appId, secretKey)
    if (translated.length !== chunk.indices.length) {
      throw new Error(
        `百度长文翻译行数错位（发 ${chunk.indices.length} 行回 ${translated.length} 行），放弃拼接`
      )
    }
    chunk.indices.forEach((lineIndex, i) => {
      result[lineIndex] = translated[i]
    })
  }
  return result.join('\n')
}
