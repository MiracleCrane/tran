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
 * --- 2026-07-30 实测（用户机器，LEVEL_ADVANCED 订阅，每型号 5 发热连接） ---
 *
 * 型号：这个端点**认任意 model 值**。kimi-for-coding / kimi-k2.6 /
 * kimi-k2.6-turbo / kimi-k2.7-code / kimi-k2.7-code-turbo / kimi-k3 全部通。
 *
 * 延迟：除 k3（中位 2951ms）外**全部 1.7~1.8s，差异在噪声内**——
 *   for-coding 1813 / k2.6 1784 / k2.6-turbo 1707 / k2.7-code 1693。
 *   所谓"极速版"在这个端点上没有可测的优势（早前单发看到的 809ms 是冷启动
 *   握手 + 抖动造成的假象）。**所以默认型号保持 kimi-for-coding，不折腾。**
 *
 * 额度：/usages 的 limit 恒为 100——那是**百分比**，不是 token 数。31 发
 *   （约 2100 token）两个窗口的 used 都没动，这只说明"低于计数器分辨率"，
 *   **不能解读为不计费**。按同端点同凭证的常理，几乎肯定计入订阅窗口。
 *
 * 指令遵循：⚠️ **这是真正的坑**。要求"一句话、不超过 12 字、只输出结果"，
 *   六个型号**全部无视**，一律开始写 markdown 长文（"我来解析这个命令：
 *   ## 命令分解 ..."）然后被 max_tokens 截断。inTok=36 说明服务端没注入大段
 *   系统提示词，是模型本身的"解释给你听"反射压不住。
 *   → 故所有调用方必须走 terseText() 做输出侧防守，且不能指望提示词单独生效：
 *     少样本示例 + 约束重复放进 user 消息 + 输出侧清洗，三样一起上。
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

/**
 * 这些开场白是模型准备开始写长文的信号（实测六个型号无一例外）。命中即判废，
 * 绝不能把它当结果存下来——存进 ai-titles.json 是会一直留着的。
 */
const ESSAY_OPENERS = [
  /^我来/,
  /^让我/,
  /^好的[，,：:]/,
  /^这(是|条|个)/,
  /^以下/,
  /^这里/,
  /^当然/,
  /^首先/,
  /^this is /i,
  /^here('s| is) /i,
  /^let me /i,
  /^sure[,.]/i,
  /^the (command|following)/i
]

/**
 * 把模型输出收成一行短文本；判不出可用结果就返回 null（让调用方回退，
 * 而不是存一段垃圾）。
 *
 * 三道处理，对应实测到的三种翻车形态：
 * 1. markdown 标题/围栏/列表 —— 模型开始排版了，取第一行有效文字；
 * 2. 开场白（"我来解析这个命令："）—— 整条判废；
 * 3. 超长 —— 说明它根本没在遵守字数，判废而不是硬截（硬截出来的是半句话）。
 */
export function terseText(raw: string, maxChars: number): string | null {
  // 围栏要按"块"跳过而不是按行过滤：只丢 ``` 那两行的话，代码内容会漏出来
  // 当成结果（实测 "## 标题\n```\ncode\n```" 会返回 "code"）。
  let inFence = false
  let firstLine: string | undefined
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line) continue
    // markdown 结构行：标题、表格、列表、引用
    if (/^(#{1,6}\s|\||[-*+]\s|>\s)/.test(line)) continue
    firstLine = line
    break
  }
  if (!firstLine) return null

  const text = firstLine
    .replace(/^[*_`"'「『《]+|[*_`"'」』》。.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  if (ESSAY_OPENERS.some((re) => re.test(text))) return null
  // 宽限一倍：略微超字数还能用，成倍超说明它在写文章。
  if (text.length > maxChars * 2) return null
  return text.slice(0, maxChars)
}

/**
 * 短总结的标准调用：少样本 + 约束重复进 user 消息 + 输出侧 terseText。
 *
 * 单靠 system 里写"只输出结果"是**实测无效**的（见文件头）。少样本示例是
 * 目前最可靠的格式约束手段，所以调用方必须给 examples。
 */
export async function cheapSummarize(opts: {
  /** 任务说明，例如"说明这条命令在做什么"。 */
  instruction: string
  /** 少样本：[输入, 期望输出]。至少给两条，格式才压得住。 */
  examples: Array<[string, string]>
  input: string
  maxChars: number
}): Promise<string | null> {
  const shots = opts.examples.map(([q, a]) => `输入：${q}\n输出：${a}`).join('\n')
  const result = await cheapComplete({
    system: `${opts.instruction}。只输出结果本身，不要解释、不要 markdown、不要标点结尾，不超过 ${opts.maxChars} 字。`,
    // 约束在 user 里再说一遍：system 单独说服不了它。
    user: `${shots}\n输入：${opts.input}\n输出：`,
    // 给到 maxChars 的几倍空间：太小的话即使格式对了也会被截断，
    // 而写文章的那种无论给多少都会超——由 terseText 判废。
    maxTokens: Math.max(32, opts.maxChars * 3)
  })
  if (!result.ok) return null
  return terseText(result.text, opts.maxChars)
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
