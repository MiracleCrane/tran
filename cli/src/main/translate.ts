import { getActiveProvider } from './providers'
import { getBaiduCreds, getTranslateEngine } from './translateConfig'
import { translateViaBaidu } from './baidu'
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
        content:
          '将下面 JSON 数组里的每条英文翻译成简体中文。只翻译、不解释、不添加;保留命令名、API 名、代码标识符、URL、数字与品牌名原样(如 /pdf、ANTHROPIC_BASE_URL、MCP、Claude)。严格输出一个等长的 JSON 字符串数组,不要 markdown 代码块、不要多余文字。\n输入:\n' +
          JSON.stringify(deduped)
      }
    ]
  }

  log('translate', `translating ${deduped.length} text(s) via ${url}`)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`翻译请求失败 (${res.status}): ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
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
export async function translateTexts(texts: string[]): Promise<string[]> {
  if (getTranslateEngine() === 'baidu') {
    const creds = getBaiduCreds()
    if (!creds) throw new Error('已选择百度翻译,但未配置 appId / secretKey')
    return translateViaBaidu(texts, creds.appId, creds.secretKey)
  }
  return translateTextsLlm(texts)
}
