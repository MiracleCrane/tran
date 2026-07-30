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
 * 指令遵循：⚠️ **这是真正的坑，而且踩了两层**。
 *   第一层：裸提示词（只在 system 里写"只输出结果、不超过 12 字"）——六个
 *     型号全部无视，一律开始写 markdown 长文然后被 max_tokens 截断。
 *   第二层：把少样本写成纯文本塞进单条 user 消息——**答非所问**，模型抓住
 *     第一个示例当主题，真正的输入被完全忽略（详见 cheapSummarize 的注释）。
 *   → 结论：少样本必须用真正的 user/assistant 轮次；加 stop 序列；再叠一层
 *     terseText() 输出侧清洗。三道防线，任何一道兜住都算。
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
  const messages: CheapMessage[] =
    opts.messages ??
    [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      { role: 'user' as const, content: opts.user ?? '' }
    ]
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
    stop: ['\n'],
    // 给到 maxChars 的几倍空间：太小的话即使格式对了也会被截断。
    maxTokens: Math.max(32, opts.maxChars * 3)
  })
  if (!result.ok) return null
  return terseText(result.text, opts.maxChars)
}

/**
 * 提示词策略自检：同一个任务用四种请求形态各打一发，把**服务端原始报错**
 * 一并带回来。
 *
 * 存在的理由：我在提示词上连摔两跤（裸提示词写长文、单条 user 塞少样本导致
 * 答非所问），第三版改成多轮 + stop 之后服务端直接 400，而 400 的原因无法
 * 从外部推断——必须看服务端那句话。与其让用户一遍遍在 PowerShell 里贴脚本
 * （还得手动解 HttpWebResponse 才能看到错误正文），不如做成设置页一个按钮。
 *
 * 四种形态是为了二分定位：stop 和多轮角色是两个独立变量，一次只动一个。
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
