import { log } from './logger'
import { getValidAccessToken } from './usageService'
import { loadSettings } from './settings'

/**
 * 「便宜模型」旁路：把不需要精确的杂活（会话命名、命令一句话说明、思考块
 * 摘要…）交给一次小请求，而不是让主 agent 在自己的上下文里做。
 *
 * 省的不是钱——你走的是 Kimi Code 订阅，额度是 5 小时/每周的窗口而不是按
 * token 计费——**省的是主会话的上下文窗口**，那才是稀缺的。让主 agent 总结
 * 得把整段内容再过一遍上下文；走这里，主会话一个 token 都不动。
 *
 * 端点与鉴权沿用 aiTitles 已实证的那条：
 *   POST https://api.kimi.com/coding/v1/chat/completions
 *   Bearer = Kimi CLI 的 OAuth access_token（usageService 的续期链）
 * access_token 绝不写日志、绝不进渲染层。
 *
 * ⚠️ 型号：实证可用的只有 `kimi-for-coding`（bundle 里也只有这一个 model id，
 * 大概是个别名，服务端解析到具体版本）。`kimi-k2.6` / `kimi-k2.7-code` 之类
 * 能不能在**这个**端点上用，只能拿真 token 打一发才知道——所以型号是设置项，
 * 并且提供 probeModels() 让用户自己探。不硬编码任何猜测。
 */

const CHAT_COMPLETIONS_URL = 'https://api.kimi.com/coding/v1/chat/completions'

/** 唯一实证可用的型号，也是默认值。 */
export const DEFAULT_CHEAP_MODEL = 'kimi-for-coding'

/** 探测时依次尝试的候选（含默认值）。都是"听说存在"，通不通看服务端。 */
export const CHEAP_MODEL_CANDIDATES = [
  DEFAULT_CHEAP_MODEL,
  'kimi-k2.6',
  'kimi-k2.6-turbo',
  'kimi-k2.7-code',
  'kimi-k2.7-code-turbo',
  'kimi-k3'
] as const

const REQUEST_TIMEOUT_MS = 20000
/** 探测用更短的超时：连不上就别让用户对着转圈等。 */
const PROBE_TIMEOUT_MS = 8000

/** 设置里选的型号；没选或选了空串一律回落默认值。 */
export function cheapModelId(): string {
  const configured = loadSettings().summaryModel
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_CHEAP_MODEL
}

export interface CheapCallOptions {
  system: string
  user: string
  /** 输出上限。总结类任务给足一句话就行。 */
  maxTokens?: number
  /** 覆盖设置里的型号（探测用）。 */
  model?: string
  timeoutMs?: number
}

export type CheapCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

/**
 * 打一次小请求。thinking 关闭是关键——总结任务开思考纯烧额度还慢。
 *
 * 失败一律不重试：这些功能全是"有则更好"，重试只会在云端抖动时把额度翻倍。
 */
export async function cheapComplete(opts: CheapCallOptions): Promise<CheapCallResult> {
  const token = await getValidAccessToken()
  if (!token) return { ok: false, error: '未登录（找不到 Kimi CLI 的凭证）' }

  const model = opts.model ?? cheapModelId()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 50,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      // 响应体常带"model not found"之类的原因，探测时要靠它区分"型号不认"
      // 和"额度用尽"，所以截一段带回去（不含任何凭证）。
      let detail = ''
      try {
        detail = (await response.text()).slice(0, 300)
      } catch {
        /* 拿不到就算了 */
      }
      log('cheap-model', `请求被拒 model=${model} status=${response.status}`)
      return {
        ok: false,
        status: response.status,
        error: detail ? `${response.status}: ${detail}` : `HTTP ${response.status}`
      }
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: '返回内容为空' }
    }
    return { ok: true, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('cheap-model', `请求失败 model=${model}: ${message}`)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

export interface CheapModelProbe {
  model: string
  ok: boolean
  /** 失败原因（服务端返回的原文片段，用于区分"不认这个型号"和"额度不足"）。 */
  error?: string
  /** 往返耗时（ms）。这个任务在 UI 上，延迟比能力重要——挑最快的那个。 */
  latencyMs?: number
}

/**
 * 逐个探测候选型号：每个打一发最小请求（max_tokens=1），报通/不通与延迟。
 *
 * 串行而不是并行：并行会在同一瞬间打 6 发，额度窗口紧的时候容易被限流，
 * 那样得到的"不通"是假阴性。
 */
export async function probeCheapModels(models?: string[]): Promise<CheapModelProbe[]> {
  const list = models?.length ? models : [...CHEAP_MODEL_CANDIDATES]
  const out: CheapModelProbe[] = []
  for (const model of list) {
    const startedAt = Date.now()
    const result = await cheapComplete({
      model,
      system: '只回一个字：好',
      user: '好',
      maxTokens: 1,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const latencyMs = Date.now() - startedAt
    out.push(
      result.ok
        ? { model, ok: true, latencyMs }
        : { model, ok: false, error: result.error, latencyMs }
    )
  }
  log('cheap-model', `探测完成：可用 ${out.filter((r) => r.ok).map((r) => r.model).join(', ') || '无'}`)
  return out
}
