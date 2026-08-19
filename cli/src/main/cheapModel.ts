import { log } from './logger'
import { getApiKey, getActiveSummaryProfile, loadSettings } from './settings'

/**
 * 轻量摘要旁路：会话命名、命令说明、思考摘要和翻译通过用户配置的
 * OpenAI 兼容 API 完成，避免占用主 Agent 的上下文。
 *
 * 这里不会读取或复用 Kimi CLI、Kimi Desktop、Kimi 网页端的任何凭证。
 * DeepSeek 默认关闭 thinking；其他兼容服务不发送该厂商专用字段。
 */

const DEFAULT_SUMMARY_API_BASE_URL = 'https://api.deepseek.com'

/** 默认使用 DeepSeek 的非思考聊天模型；用户可在设置中改成任意 OpenAI 兼容服务。 */
export const DEFAULT_CHEAP_MODEL = 'deepseek-v4-flash'

/** 拿不到模型目录时，只探测默认模型，避免测试按钮产生一串无意义请求。 */
export const CHEAP_MODEL_CANDIDATES = [
  DEFAULT_CHEAP_MODEL
] as const

const REQUEST_TIMEOUT_MS = 20000
/** 探测用更短的超时：连不上就别让用户对着转圈等。 */
const PROBE_TIMEOUT_MS = 8000

/** 型号：优先取激活的那套配置，其次旧的单份字段，最后默认值。 */
export function cheapModelId(): string {
  const fromProfile = getActiveSummaryProfile()?.model
  if (fromProfile && fromProfile.trim()) return fromProfile.trim()
  const configured = loadSettings().summaryModel
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_CHEAP_MODEL
}

/** 同上：多套配置取代了单份 summaryApiBaseUrl，旧字段仅作回退。 */
function summaryApiBaseUrl(): string {
  const fromProfile = getActiveSummaryProfile()?.baseUrl
  if (fromProfile && fromProfile.trim()) return fromProfile.trim().replace(/\/+$/, '')
  const configured = loadSettings().summaryApiBaseUrl
  return typeof configured === 'string' && configured.trim()
    ? configured.trim().replace(/\/+$/, '')
    : DEFAULT_SUMMARY_API_BASE_URL
}

export interface CheapMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CheapCallOptions {
  /** 简单形态：一条 system + 一条 user。与 messages 二选一。 */
  system?: string
  user?: string
  /** 完整消息序列（少样本要用真正的 user/assistant 轮次，见 cheapSummarize）。 */
  messages?: CheapMessage[]
  /** 输出上限。总结类任务给足一句话就行。 */
  maxTokens?: number
  /** 停止序列。`['\n']` 能从协议层砍掉多行输出，比事后清洗可靠。 */
  stop?: string[]
  /** 覆盖设置里的型号（探测用）。 */
  model?: string
  timeoutMs?: number
}

/**
 * 采样温度。
 *
 * 2026-07-30 的 DeepSeek 实测(62 次真实调用)全程是在 **temperature=0.2** 下
 * 跑的——「12 字命令说明 10/10 通过清洗」「16 字思考摘要 6/6 通过」这些结论
 * 都只对这个温度成立。此前代码一律不传，吃的是服务端默认 1.0：跑的和测的
 * 不是一套，而这些任务(定长短摘要、保留代码字面量的翻译)恰恰是越确定越好。
 *
 * 注意别被 diagnoseSummaryPrompt 那段注释带偏：那里记的 400
 * (`only 0.6 is allowed for this model`) 是**别的型号**(reasoner 系)的限制。
 * flash 与 pro 各 18 次带 0.2 全部 200。
 *
 * 但用户可以把 baseUrl 指到任意 OpenAI 兼容服务，那边可能有同样的限制，
 * 所以下面留了一条"因 temperature 被拒就去掉重打一次"的退路。
 */
const SUMMARY_TEMPERATURE = 0.2

/** 400 的原文是否在抱怨 temperature（各家措辞不一，只认这个词）。 */
function rejectedForTemperature(status: number | undefined, detail: string): boolean {
  return status === 400 && /temperature/i.test(detail)
}

export type CheapCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

/**
 * 限流退避与串行化。
 *
 * 为什么必须有：Tran 的调用模式是**突发并发**——一轮结束后一屏冒出五六个工具卡，
 * explainCommand 会同时打五六发（inflight 去重只挡得住同一条命令）。任何服务在
 * 这种瞬时并发下都可能回 429，而这条旁路的失败策略是静默回退，表现就是"命令说明
 * 时有时无"，用户根本不知道发生了什么。
 *
 * 2026-08 实测（10 条并发）：无防护成功 2/10，加上串行队列 + 指数退避后 10/10。
 *
 * 设计上刻意不给所有请求无条件加间隔：不限流的服务不该被拖慢。只有**真的撞过
 * 429 之后**才进入冷却期并拉开间距，一段时间不再撞就自动恢复全速。
 */
const RATE_LIMIT_MAX_RETRIES = 6
const RATE_LIMIT_BASE_DELAY_MS = 1500
/** 单次退避上限：免费档平台拥塞是常态（2026-08 用户明确"慢一点排队我愿意"），
 *  耐心放到 ~76s 总长（1.5/3/6/12/24/30），但单次别超过 30s 没边界。 */
const RATE_LIMIT_MAX_DELAY_MS = 30_000
/** 撞限流后，后续请求之间强制拉开的最小间距。 */
const COOLDOWN_SPACING_MS = 1200
/** 冷却期长度：这段时间内没再撞限流就恢复全速。 */
const COOLDOWN_WINDOW_MS = 60_000

let queueTail: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0
let cooldownUntil = 0

function isRateLimited(status: number | undefined, detail: string): boolean {
  // 不能只看状态码：部分服务用 HTTP 200 + body 里的错误码表示限流（实测遇到过），
  // 只判 429 会整类漏掉、退避重试永远触发不到。所以正文也一起匹配。
  return (
    status === 429 ||
    /too many requests|rate limit|rate_limit|访问量过大|请求过于频繁|限流/i.test(detail)
  )
}

/**
 * 「这条旁路坏了，而且不是抖动」——需要让用户看见的那类失败。
 *
 * 这条链路的失败策略是**静默回退**（命令说明缺失就显示原命令），因为它们全是
 * "有则更好"。但那个设计有个盲区：额度耗尽 / Key 失效 / 欠费属于**不会自愈**的
 * 故障，静默下去的表现是"功能悄悄不工作了"，用户完全无从察觉——2026-08 用户
 * 明确要求"没额度了要提示"。限流不算：它会自愈，退避重试兜得住。
 */
export type SummaryIssueKind = 'quota' | 'auth' | 'network'

export function classifySummaryIssue(
  status: number | undefined,
  detail: string
): SummaryIssueKind | null {
  if (status === 401 || status === 403 || /invalid api key|unauthorized|authenticationerror/i.test(detail)) {
    return 'auth'
  }
  if (
    status === 402 ||
    /insufficient|quota|balance|arrears|欠费|余额不足|额度不足|额度已用尽|超出配额/i.test(detail)
  ) {
    return 'quota'
  }
  return null
}

let issueListener: ((kind: SummaryIssueKind, detail: string) => void) | null = null
/** 主进程接线：把这类故障推给渲染层（见 ipc.ts）。 */
export function onSummaryIssue(fn: (kind: SummaryIssueKind, detail: string) => void): void {
  issueListener = fn
}

/** 同一类问题的通报间隔——每次调用都弹一遍等于刷屏。 */
const ISSUE_NOTIFY_INTERVAL_MS = 10 * 60_000
const lastIssueNotifiedAt = new Map<SummaryIssueKind, number>()

function reportIssue(status: number | undefined, detail: string): void {
  const kind = classifySummaryIssue(status, detail)
  if (!kind) return
  const now = Date.now()
  if (now - (lastIssueNotifiedAt.get(kind) ?? 0) < ISSUE_NOTIFY_INTERVAL_MS) return
  lastIssueNotifiedAt.set(kind, now)
  log('cheap-model', `摘要 API 故障[${kind}]：${detail.slice(0, 160)}`)
  issueListener?.(kind, detail.slice(0, 200))
}

/** 连续网络失败计数（超时/断连，无 HTTP 状态码）。名义上"会自愈"所以不在
 *  classifySummaryIssue 里，但一挂一下午的表现就是「AI 命名/翻译悄悄不工作」
 *  （2026-08-14 用户实测：火山端点连不上，命名全部静默回退）。连满阈值才报，
 *  成功一次清零。 */
const NETWORK_FAILURE_THRESHOLD = 3
let consecutiveNetFailures = 0

function reportNetworkIssue(detail: string): void {
  const now = Date.now()
  if (now - (lastIssueNotifiedAt.get('network') ?? 0) < ISSUE_NOTIFY_INTERVAL_MS) return
  lastIssueNotifiedAt.set('network', now)
  log('cheap-model', `摘要 API 连续 ${consecutiveNetFailures} 次网络失败：${detail.slice(0, 160)}`)
  issueListener?.('network', detail.slice(0, 200))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 串行执行 + 冷却期内拉开间距。所有出网请求都必须经过这里。 */
async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    if (Date.now() < cooldownUntil) {
      const wait = lastRequestAt + COOLDOWN_SPACING_MS - Date.now()
      if (wait > 0) await sleep(wait)
    }
    lastRequestAt = Date.now()
    return task()
  })
  // 队尾始终推进，且吞掉异常——否则一次失败会让整条链后续全部拒绝。
  queueTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 打一次小请求。thinking 关闭是关键——总结任务开思考纯烧额度还慢。
 *
 * 两种重试，触发条件完全不同：
 * - **服务不接受 temperature**：确定性的配置冲突，去掉参数重打一次必然有结果。
 * - **限流**：指数退避重试。这是唯一值得重打的"云端抖动"，因为免费档撞限流是
 *   常态而非异常；其余失败（型号不认、额度用尽、网络断）一律不重试——这些功能
 *   全是"有则更好"，盲目重试只会在故障时把请求量翻倍。
 */
export async function cheapComplete(opts: CheapCallOptions): Promise<CheapCallResult> {
  let result = await enqueue(() => cheapCompleteOnce(opts, true))

  for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
    if (result.ok || !isRateLimited(result.status, result.error)) break
    // 撞了就进冷却：后续请求（含本次重试）自动拉开间距。
    cooldownUntil = Date.now() + COOLDOWN_WINDOW_MS
    const delay = Math.min(RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt)
    log('cheap-model', `限流，${delay}ms 后重试（第 ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES} 次）`)
    await sleep(delay)
    result = await enqueue(() => cheapCompleteOnce(opts, true))
  }

  if (!result.ok && rejectedForTemperature(result.status, result.error)) {
    log('cheap-model', '服务不接受 temperature，去掉重试一次')
    result = await enqueue(() => cheapCompleteOnce(opts, false))
  }
  // 额度耗尽/凭证失效这类不会自愈的故障要浮到界面上，否则功能只是"悄悄不工作"。
  if (!result.ok) reportIssue(result.status, result.error)
  // 网络层失败（超时/断连，无状态码）：连续满阈值也报一次（见 reportNetworkIssue）。
  if (result.ok) {
    consecutiveNetFailures = 0
  } else if (result.status === undefined) {
    consecutiveNetFailures += 1
    if (consecutiveNetFailures >= NETWORK_FAILURE_THRESHOLD) reportNetworkIssue(result.error)
  }
  return result
}

async function cheapCompleteOnce(
  opts: CheapCallOptions,
  withTemperature: boolean
): Promise<CheapCallResult> {
  const token = getApiKey()
  if (!token) return { ok: false, error: '未配置摘要 API Key（设置 → 系统）' }

  const model = opts.model ?? cheapModelId()
  const messages: CheapMessage[] =
    opts.messages ??
    [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.user ?? '' }
    ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
  const baseUrl = summaryApiBaseUrl()
  /**
   * 是否给这次请求带上"关思考"。
   *
   * 默认关思考：这些任务是 12/16 字的短摘要，推理帮不上忙却极烧额度——实测火山
   * 方舟上的 GLM-5.2 回一条命令说明，开思考多花 762 个推理 token，关掉是 0，
   * 两边答案质量一样。免费额度按 token 算（推理 token 也算），差 700 倍。
   * 更隐蔽的后果：混合思考模型不关思考时推理会把 max_tokens 吃光，`content`
   * 返回空串而 `reasoning_content` 有内容，表现是"模型什么都不回"。
   *
   * 字段只发给**已知接受它的服务**：别家收到不认识的字段可能直接 400，
   * 那就不是省额度而是整条链路挂掉。方舟按整个域名放行——它是聚合平台，
   * 同一域名后面挂什么模型取决于接入点，逐个判断迟早漏。
   */
  const knownAcceptsThinkingField =
    /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl) ||
    /(?:^|\.)volces\.com/i.test(baseUrl) ||
    // 智谱（GLM-4.7-Flash 这类混合思考模型）：不关思考的话 12 字摘要也要先推理
    // 几秒（2026-08-17 用户实测"智谱那条慢得像卡住"）。
    /(?:^|\.)bigmodel\.cn/i.test(baseUrl)
  const disableThinking = loadSettings().summaryThinkingEnabled !== true && knownAcceptsThinkingField
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 50,
        ...(withTemperature ? { temperature: SUMMARY_TEMPERATURE } : {}),
        ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
        messages
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
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
      error?: { code?: unknown; message?: unknown }
    }
    const message = json.choices?.[0]?.message
    const text = message?.content
    if (typeof text !== 'string' || !text.trim()) {
      /**
       * 空 content 有两种成因，必须在错误信息里区分开，否则上层无从判断。
       *
       * 1. **限流**：部分服务用 HTTP 200 + body 里的错误码表示限流。走到这里
       *    response.ok 是真，只是没有 content。若只写"返回内容为空"，错误码就
       *    丢了，cheapComplete 的限流重试永远触发不到。
       * 2. **思考吃光了预算**：混合思考模型没关 thinking 时，推理占满 max_tokens，
       *    content 空而 reasoning_content 有内容。把长度带出来，排查时一眼可辨
       *    （否则只能看到"模型什么都不回"）。
       */
      const apiCode = json.error?.code
      const apiMessage = json.error?.message
      if (apiCode !== undefined || apiMessage !== undefined) {
        return { ok: false, error: `${String(apiCode ?? '')}: ${String(apiMessage ?? '')}`.trim() }
      }
      const reasoning = message?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        return { ok: false, error: `返回内容为空（推理占满预算，reasoning ${reasoning.length} 字符）` }
      }
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
  return trimToWidth(text, maxChars)
}

/**
 * 切到 maxChars 以内，但**不切在词中间**。
 *
 * 2026-07-30 实测：硬 `slice(0, maxChars)` 会切出
 *   "压缩 Electron "（尾部空格 + 词被腰斩）
 *   "定位流式导致 remount 的"（挂着一个孤零零的"的"）
 *   "git push 代理配"（切在"配置"中间）
 * 这些还都是**判废兜不住的**——长度在 maxChars 和 2×maxChars 之间，前面每一道
 * 防线都放行了，最后死在这一行上。标题是要长期存进 ai-titles.json 的，切坏一次
 * 就一直难看。
 */
/**
 * 超出上限但只超一点点时，宁可让它超着也不切。
 *
 * 2026-07-30 实测（跑真实会话，15 条思考摘要）：中文没有词边界可依，切到上限
 * 正好落在词中间的有两条——"排查 Claude Code 配"（配置）、"验证端到端 Claude
 * 后端会"（后端会话）。这两条只超了 1 个字。UI 上多一两个字看不出来，
 * 断掉的词却一眼就是坏的。
 */
const OVERFLOW_GRACE_CHARS = 3

function trimToWidth(text: string, maxChars: number): string {
  if (text.length <= maxChars + OVERFLOW_GRACE_CHARS) return text
  let cut = maxChars
  // 落在 ASCII 词（英文/数字）内部就退到词首，别把 Electron 腰斩成 Electr。
  // 退得太多就算了——宁可少一个词，也不要半个词。
  const isWordChar = (ch: string): boolean => /[A-Za-z0-9_.-]/.test(ch)
  if (cut < text.length && isWordChar(text[cut]!) && isWordChar(text[cut - 1]!)) {
    let back = cut
    while (back > 0 && isWordChar(text[back - 1]!)) back--
    if (back >= Math.ceil(maxChars / 2)) cut = back
  }
  // 尾部的空白、标点、以及悬空的虚词——单独留着只会让人以为文本被截断了。
  const trimmed = text
    .slice(0, cut)
    .replace(/[\s，,、。.:：;；·—-]+$/, '')
    .replace(/(的|了|和|与|在|把|被|对|从|到|个|之|其)$/, '')
    .trim()
  // 全被修没了（整段都是标点/虚词）就退回朴素切法，别返回空串。
  return trimmed || text.slice(0, maxChars).trim()
}

/**
 * 短总结的标准调用：**多轮角色少样本** + stop 序列 + 输出侧 terseText。
 *
 * ⚠️ 少样本必须用真正的 user/assistant 轮次，**不能把示例塞进一条 user 消息**。
 * 2026-07-30 实测：把示例写成
 *     输入：git status --porcelain
 *     输出：查看改动
 *     输入：<真正的命令>
 *     输出：
 * 这种纯文本形式塞进单条 user 消息，模型不把它当示例——它把整段当成"一堆待
 * 处理的内容"，然后按 coding 调优的本能去写一份《命令速查表》，主题取的是
 * **第一个示例**。于是不管真正的输入是什么，六个型号全都在回答
 * `git status --porcelain`（命名任务里则全都在回答示例里的"401 排查"）。
 * 真正的输入被完全忽略——这比"不听格式"严重得多，是答非所问。
 *
 * 换成多轮角色后，模型看到的是"这段对话里我一直这么答"，才是真的 few-shot。
 * 再加 stop: ['\n'] 从协议层砍掉多行，比事后清洗可靠。
 * terseText 仍然保留：三道防线，任何一道兜住都算。
 */
export async function cheapSummarize(opts: {
  /** 任务说明，例如"说明这条命令在做什么"。 */
  instruction: string
  /** 少样本：[输入, 期望输出]。至少给两条，格式才压得住。 */
  examples: Array<[string, string]>
  input: string
  maxChars: number
}): Promise<string | null> {
  const messages: CheapMessage[] = [
    {
      role: 'system',
      content: `${opts.instruction}。只输出结果本身，不要解释、不要 markdown、不超过 ${opts.maxChars} 字。`
    }
  ]
  for (const [q, a] of opts.examples) {
    messages.push({ role: 'user', content: q })
    messages.push({ role: 'assistant', content: a })
  }
  messages.push({ role: 'user', content: opts.input })

  const result = await cheapComplete({
    messages,
    // 不传 stop：硅基 GLM-4-9B 这类模型回复以 "\n" 开头，stop:['\n'] 会在
    // 第 0 个字符处截断，content 直接为空——整条摘要/命名/命令说明链路全灭
    //（2026-08-18 实测复现：同一 payload 带 stop content=''，去掉就正常）。
    // 单行约束由 terseText 兜底（取首个非空行 + 宽度/开场白判定），够用。
    // 给到 maxChars 的几倍空间：太小的话即使格式对了也会被截断。
    maxTokens: Math.max(32, opts.maxChars * 3)
  })
  if (!result.ok) return null
  const cleaned = terseText(result.text, opts.maxChars)
  // 判废要留痕：原文打出来，下次"命名没生效"才查得到原因（2026-08-19：
  //  只记"未得到可用结果"看不到模型到底回了什么）。
  if (cleaned === null) {
    log('cheap-model', `terseText 判废: ${result.text.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
  return cleaned
}

/**
 * 提示词策略自检：同一个任务用四种请求形态各打一发，把**服务端原始报错**
 * 一并带回来。
 *
 * 存在的理由：我在提示词上连摔两跤（裸提示词写长文、单条 user 塞少样本导致
 * 答非所问），第三版改成多轮 + stop 之后疑似被服务端 400，而 400 的原因无法
 * 从外部推断——必须看服务端那句话。与其让用户一遍遍在 PowerShell 里贴脚本
 * （还得手动解 HttpWebResponse 才能看到错误正文），不如做成设置页一个按钮。
 *
 * 四种形态是为了二分定位：stop 和多轮角色是两个独立变量，一次只动一个。
 *
 * 2026-07-30 直连实测结果：**四种形态全部 200**，多轮 + stop 输出
 * "构建并启动容器"，完全合格。那次 400 复现不出来。按 stop/多轮被拒来设计是
 * **没有依据的**，所以正式路径直接用形态 4。这个按钮保留作回归自检。
 *
 * 关于当时记下的 `temperature` 400（传 0 即 `only 0.6 is allowed for this
 * model`）：那是 reasoner 系型号的限制，不适用于 flash/pro——同日 62 次
 * 基准调用全程带 temperature=0.2，flash 与 pro 各 18 次全部 200。正式路径
 * 现在按实测那样传 0.2，并对"因 temperature 被拒"留了一次去掉重打的退路。
 */
export interface PromptDiagnosis {
  label: string
  ok: boolean
  /** 模型原样输出（换行换成 ⏎ 便于单行展示）。 */
  output?: string
  /** 失败时服务端返回的原文片段。 */
  error?: string
  latencyMs: number
  /** terseText 清洗后的结果；null 表示这一形态的输出不可用。 */
  cleaned?: string | null
}

const DIAG_INSTRUCTION = '说明这条命令在做什么。只输出结果本身，不要解释、不要 markdown、不超过 12 字。'
const DIAG_INPUT = 'docker compose up -d --build web worker'
const DIAG_SHOTS: Array<[string, string]> = [
  ['git status --porcelain', '查看改动'],
  ['pytest tests/api -k login', '跑登录相关测试']
]

export async function diagnoseSummaryPrompt(): Promise<PromptDiagnosis[]> {
  const plain: CheapMessage[] = [
    { role: 'system', content: DIAG_INSTRUCTION },
    { role: 'user', content: DIAG_INPUT }
  ]
  const multiTurn: CheapMessage[] = [{ role: 'system', content: DIAG_INSTRUCTION }]
  for (const [q, a] of DIAG_SHOTS) {
    multiTurn.push({ role: 'user', content: q })
    multiTurn.push({ role: 'assistant', content: a })
  }
  multiTurn.push({ role: 'user', content: DIAG_INPUT })

  const variants: Array<{ label: string; messages: CheapMessage[]; stop?: string[] }> = [
    { label: '1 基线：单轮，无 stop', messages: plain },
    { label: '2 单轮 + stop', messages: plain, stop: ['\n'] },
    { label: '3 多轮少样本，无 stop', messages: multiTurn },
    { label: '4 多轮少样本 + stop', messages: multiTurn, stop: ['\n'] }
  ]

  const out: PromptDiagnosis[] = []
  for (const v of variants) {
    const startedAt = Date.now()
    const result = await cheapComplete({
      messages: v.messages,
      ...(v.stop ? { stop: v.stop } : {}),
      maxTokens: 36
    })
    const latencyMs = Date.now() - startedAt
    out.push(
      result.ok
        ? {
            label: v.label,
            ok: true,
            output: result.text.replace(/\r?\n/g, ' ⏎ ').slice(0, 300),
            cleaned: terseText(result.text, 12),
            latencyMs
          }
        : { label: v.label, ok: false, error: result.error.slice(0, 400), latencyMs }
    )
    // 串行 + 间隔：并发打会被限流，那样的失败会被误读成"这个形态不支持"。
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  log('cheap-model', `提示词自检完成：${out.filter((r) => r.ok).length}/${out.length} 形态可用`)
  return out
}

export interface CheapModelProbe {
  model: string
  ok: boolean
  /** 失败原因（服务端返回的原文片段，用于区分"不认这个型号"和"额度不足"）。 */
  error?: string
  /** 往返耗时（ms）。这个任务在 UI 上，延迟比能力重要——挑最快的那个。 */
  latencyMs?: number
  /** 是否出现在服务端目录里。false + ok=true = 服务端在静默回落，不是真可用。 */
  known: boolean
  displayName?: string
  contextLength?: number
}

/** OpenAI 兼容 `/models` 响应中的一条。 */
export interface ServerModel {
  id: string
  displayName?: string
  contextLength?: number
}

/** 读取用户所配置服务的模型目录；不支持 `/models` 时返回 null。 */
export async function listServerModels(): Promise<ServerModel[] | null> {
  const token = getApiKey()
  if (!token) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${summaryApiBaseUrl()}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    if (!response.ok) {
      log('cheap-model', `型号目录请求被拒 status=${response.status}`)
      return null
    }
    const json = (await response.json()) as {
      data?: Array<{ id?: unknown; display_name?: unknown; context_length?: unknown }>
    }
    if (!Array.isArray(json.data)) return null
    return json.data
      .filter((entry): entry is { id: string } & typeof entry => typeof entry?.id === 'string' && !!entry.id)
      .map((entry) => ({
        id: entry.id,
        ...(typeof entry.display_name === 'string' ? { displayName: entry.display_name } : {}),
        ...(typeof entry.context_length === 'number' ? { contextLength: entry.context_length } : {})
      }))
  } catch (error) {
    log('cheap-model', `型号目录请求失败: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探测可用型号：**先拉目录定"存不存在"，再逐个打一发定"通不通 + 多快"**。
 *
 * 两件事必须分开报，因为它们的失败模式完全不同：目录说了算的是存在性，打一发
 * 说了算的是当下的额度/网络。早前只做后者，于是六个不存在的型号全报 ✓——
 * 用户照着挑一个填进设置，实际跑的还是默认型号，而且毫无提示。
 *
 * 串行而不是并行：并行会在同一瞬间打满，额度窗口紧的时候容易被限流，那样得到
 * 的"不通"是假阴性。
 */
export async function probeCheapModels(models?: string[]): Promise<CheapModelProbe[]> {
  const catalog = await listServerModels()
  const known = new Map((catalog ?? []).map((m) => [m.id, m]))

  // 探测目标：目录（拿不到就用兜底表）+ 用户当前填的那个（可能是目录外的，
  // 正因为在目录外才更该让他看到警告）。
  const configured = cheapModelId()
  const base = models?.length
    ? models
    : [...CHEAP_MODEL_CANDIDATES]
  const list = base.includes(configured) ? base : [...base, configured]

  const out: CheapModelProbe[] = []
  for (const model of list) {
    const entry = known.get(model)
    const startedAt = Date.now()
    const result = await cheapComplete({
      model,
      system: '只回一个字：好',
      user: '好',
      maxTokens: 1,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const latencyMs = Date.now() - startedAt
    // catalog 为 null 时无从判断存在性，一律按"未知"处理而不是谎报 known。
    const isKnown = catalog ? known.has(model) : false
    out.push({
      model,
      ok: result.ok,
      latencyMs,
      known: isKnown,
      ...(entry?.displayName ? { displayName: entry.displayName } : {}),
      ...(entry?.contextLength ? { contextLength: entry.contextLength } : {}),
      ...(result.ok ? {} : { error: result.error })
    })
  }
  log(
    'cheap-model',
    `探测完成：目录 ${catalog ? `${catalog.length} 个` : '不可用'}，可用 ${out.filter((r) => r.ok && r.known).map((r) => r.model).join(', ') || '无'}`
  )
  return out
}
