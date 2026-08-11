import { getActiveProvider } from './providers'
import { getBaiduCreds, getTranslateEngine } from './translateConfig'
import { baiduTripped, translateViaBaidu } from './baidu'
import { cheapComplete } from './cheapModel'
import { getApiKey } from './settings'
import { log } from './logger'

/**
 * Batch-translate text via the active provider's /v1/messages endpoint (the same
 * baseUrl + auth the SDK uses). Used to localize skill/plugin descriptions on
 * demand. Doesn't touch the user's chat session — it's a standalone API call.
 */

const ANTHROPIC_VERSION = '2023-06-01'

function parseArray(text: string): string[] {
  // tolerate markdown fences / surrounding prose — grab the outermost JSON array
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1))
    if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr as string[]
  } catch {
    /* fall through → empty (caller shows originals) */
  }
  return []
}

const TRANSLATE_INSTRUCTION =
  '将下面 JSON 数组里的每条英文翻译成简体中文。只翻译、不解释、不添加;保留命令名、API 名、代码标识符、URL、数字与品牌名原样(如 /pdf、ANTHROPIC_BASE_URL、MCP、Claude)。严格输出一个等长的 JSON 字符串数组,不要 markdown 代码块、不要多余文字。\n输入:\n'

/**
 * 便宜通道：走摘要旁路那个 OpenAI 兼容服务（默认 DeepSeek flash）。
 *
 * 提示词与主 Agent 那条完全一致，输出同样交给 parseArray 兜底解析——描述句
 * 短、结构简单，flash 足够。maxTokens 按条数给：每条描述译文撑死几十字，
 * 但整批是一个 JSON 数组，得留够整体长度。
 */
async function translateTextsCheap(texts: string[]): Promise<string[]> {
  const deduped = Array.from(new Set(texts.filter((t) => t && t.trim())))
  if (deduped.length === 0) return []

  log('translate', `translating ${deduped.length} text(s) via cheap model`)
  const result = await cheapComplete({
    user: TRANSLATE_INSTRUCTION + JSON.stringify(deduped),
    // 原文总长 + 每条的引号/逗号开销；中文译文通常比英文原文短，给到原文
    // 字符数已经宽裕，再设个下限防止小批量被截断。
    maxTokens: Math.min(4096, Math.max(512, deduped.join('').length + deduped.length * 8)),
    timeoutMs: TRANSLATE_TIMEOUT_MS
  })
  if (!result.ok) throw new Error(result.error)

  const translated = parseArray(result.text)
  if (!translated.length) throw new Error('便宜通道返回的不是合法 JSON 数组')

  const map = new Map<string, string>()
  deduped.forEach((t, i) => {
    if (translated[i]) map.set(t, translated[i])
  })
  return texts.map((t) => map.get(t) ?? '')
}

/** LLM engine: batch-translate via the active provider's /v1/messages. */
async function translateTextsLlm(texts: string[]): Promise<string[]> {
  const deduped = Array.from(new Set(texts.filter((t) => t && t.trim())))
  if (deduped.length === 0) return []

  const provider = getActiveProvider()
  if (!provider) throw new Error('没有激活的运营商,无法翻译')

  const baseUrl = provider.baseUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/v1/messages`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  }
  if (provider.authType === 'apikey') headers['x-api-key'] = provider.token
  else headers['authorization'] = `Bearer ${provider.token}`

  const body = {
    model: provider.model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: TRANSLATE_INSTRUCTION + JSON.stringify(deduped)
      }
    ]
  }

  log('translate', `translating ${deduped.length} text(s) via ${url}`)
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`翻译请求失败 (${res.status}): ${detail.slice(0, 200)}`)
  }
  let data: { content?: Array<{ type: string; text?: string }> }
  try {
    data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  } catch {
    throw new Error('翻译响应不是合法 JSON')
  }
  const out = (data.content ?? []).find((c) => c.type === 'text')?.text ?? ''
  const translated = parseArray(out)

  // map back to the (possibly duplicated) input order
  const map = new Map<string, string>()
  deduped.forEach((t, i) => {
    if (translated[i]) map.set(t, translated[i])
  })
  return texts.map((t) => map.get(t) ?? '')
}

/**
 * Batch-translate texts EN→ZH via the configured engine. Routes to Baidu when
 * the user selected it (avoids LLM rate limits); otherwise the active provider.
 * Signature is unchanged from the original LLM-only impl, so SkillsPanel keeps
 * working and degrades gracefully on error.
 */
/** 翻译接口的请求超时。此前无超时，连接被挂住时 promise 永不落地，
 *  调用方（技能面板等）会一直转圈。 */
const TRANSLATE_TIMEOUT_MS = 30000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`翻译请求超时（${TRANSLATE_TIMEOUT_MS / 1000}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量 EN→ZH。路由顺序刻意是「越便宜越优先」：
 *
 *   1. 显式选了百度 → 百度（免费额度内不花钱）
 *   2. 配了摘要 API Key → 走那个便宜模型（DeepSeek flash 之类，用户自己的钱）
 *   3. 都没有 → 才回退主 Agent
 *
 * 第 2 条是这次加的。此前只有 1 和 3：没配百度就直接打主 Agent 的
 * `/v1/messages`（`max_tokens: 4096`）——**烧的是用户的 Kimi 套餐额度**。而这
 * 里翻的只是技能/插件的描述句，是全 app 最不需要强模型的文本之一，用套餐额度
 * 去做纯属浪费。摘要旁路的 key 本来就是为这类杂活准备的。
 */
export async function translateTexts(texts: string[]): Promise<string[]> {
  // 百度被熔断（欠费/未授权）时不再硬走百度：往下落到便宜通道/主 Agent，
  // 别让翻译整个消失。
  if (getTranslateEngine() === 'baidu' && !baiduTripped()) {
    const creds = getBaiduCreds()
    if (!creds) throw new Error('已选择百度翻译,但未配置 appId / secretKey')
    return translateViaBaidu(texts, creds.appId, creds.secretKey)
  }
  if (getApiKey()) {
    try {
      return await translateTextsCheap(texts)
    } catch (error) {
      // 便宜通道失败不该让翻译整个不可用：记一笔，退回主 Agent。
      log('translate', `cheap 通道失败，回退主 Agent：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return translateTextsLlm(texts)
}
