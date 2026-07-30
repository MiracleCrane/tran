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
 * --- 2026-07-30 实测（用户机器，LEVEL_ADVANCED 订阅） ---
 *
 * 【型号】chat 端点**完全不校验 model 值**：随便写什么都回 200，并把这个值原样
 *   回声在 `response.model` 里。实测连 `gpt-4o` 和现编的
 *   `zzz-not-a-real-model-20260730` 都"通"。
 *   → **"打得通"不能证明型号存在**，只有 GET /coding/v1/models 能。
 *   → 目录里真实存在的只有四个（见 listServerModels 的注释），
 *      早前候选表里的 kimi-k2.6 / kimi-k2.6-turbo / kimi-k2.7-code /
 *      kimi-k2.7-code-turbo / kimi-k3 **一个都不存在**，服务端静默回落到默认
 *      型号。所以早前那份"所有型号延迟都一样、差异在噪声里"的基准，其实是
 *      **把同一个型号测了六遍**。
 *   → 回落到哪个也是可测的：虚构 id 的 prompt_tokens = 82，与
 *      kimi-for-coding 一致；k3 系是 134/137（系统预置不同）。即虚构 id 落到
 *      的就是 kimi-for-coding。
 *
 * 【延迟】用真实 id + 正确提示词（少样本 + stop）重测，3 发热连接的中位数
 *   （两轮，相隔约半小时）：
 *      kimi-for-coding             885 / 971ms   ← 保持默认
 *      kimi-for-coding-highspeed  1098 / 990ms
 *      k3                         1237 / 1147ms
 *      k3-256k                    5547 / 2052ms  ← 抖得厉害，唯一有尾延迟风险的
 *   两轮之间 for-coding 和 highspeed 互换了名次，差值一两百毫秒——**这两个在
 *   这个任务上分不出快慢**，别拿延迟当选型依据。
 *   注意这比早前记的 1.7~1.8s 快了一倍——**不是网络变好了**：早前的基准里
 *   `outTok` 恒等于 max_tokens，说明模型每发都在写长文写到被截断，延迟是被
 *   "生成 N 个 token"撑起来的。提示词修好后输出只有 4~16 个 token，延迟自然
 *   掉下来。→ **"1.7s 延迟是硬伤"这个结论已作废**，但"不阻塞 UI、结果要缓存"
 *   仍然照做。
 *
 * 【额度】/usages 的 limit 恒为 100——那是**百分比**，不是 token 数。31 发
 *   （约 2100 token）两个窗口的 used 都没动，这只说明"低于计数器分辨率"，
 *   **不能解读为不计费**。按同端点同凭证的常理，几乎肯定计入订阅窗口。
 *
 * 【指令遵循】⚠️ 踩了两层：
 *   第一层：裸提示词（只在 system 里写"只输出结果、不超过 12 字"）——全部无视，
 *     一律开始写 markdown 长文然后被 max_tokens 截断。
 *   第二层：把少样本写成纯文本塞进单条 user 消息——**答非所问**，模型抓住
 *     第一个示例当主题，真正的输入被完全忽略（详见 cheapSummarize 的注释）。
 *   → 改成真正的 user/assistant 多轮少样本 + stop 序列后，12 条不同命令
 *      12 条都答对且都在 12 字内（kimi-for-coding 与 highspeed 各 6 条）。
 *      terseText() 仍保留作第三道防线。
 *
 * 【两个必须原样保留的参数】
 *   - `thinking: { type: 'disabled' }` 是**载重参数，不是优化**。目录里四个型号
 *     全是 `supports_thinking_type: "only"`；把这个字段整个去掉，max_tokens=36
 *     的预算会被推理吃光，`content` 回**空字符串**（实测）。
 *   - `temperature` 一律不要传：传 0 直接 400
 *     `invalid temperature: only 0.6 is allowed for this model`。
 */

const CHAT_COMPLETIONS_URL = 'https://api.kimi.com/coding/v1/chat/completions'
const MODELS_URL = 'https://api.kimi.com/coding/v1/models'

/** 目录实证存在、且实测最快的型号，也是默认值。 */
export const DEFAULT_CHEAP_MODEL = 'kimi-for-coding'

/**
 * 拿不到目录时的兜底候选。**只列目录里实证存在的**——绝不再往这里加"听说存在"
 * 的名字：chat 端点对不存在的 id 也回 200，加进来只会探测出一排假的 ✓。
 */
export const CHEAP_MODEL_CANDIDATES = [
  DEFAULT_CHEAP_MODEL,
  'kimi-for-coding-highspeed',
  'k3',
  'k3-256k'
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
function trimToWidth(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
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
 * 答非所问），第三版改成多轮 + stop 之后疑似被服务端 400，而 400 的原因无法
 * 从外部推断——必须看服务端那句话。与其让用户一遍遍在 PowerShell 里贴脚本
 * （还得手动解 HttpWebResponse 才能看到错误正文），不如做成设置页一个按钮。
 *
 * 四种形态是为了二分定位：stop 和多轮角色是两个独立变量，一次只动一个。
 *
 * 2026-07-30 直连实测结果：**四种形态全部 200**，多轮 + stop 输出
 * "构建并启动容器"，完全合格。那次 400 复现不出来——已知会 400 的只有
 * `temperature`（传 0 即 `only 0.6 is allowed for this model`），而这里从不传
 * temperature。按 stop/多轮被拒来设计是**没有依据的**，所以正式路径直接用
 * 形态 4。这个按钮保留作回归自检。
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

/** GET /coding/v1/models 的一条。 */
export interface ServerModel {
  id: string
  displayName?: string
  contextLength?: number
}

/**
 * 服务端的**权威**型号目录。
 *
 * 这是唯一能回答"某个型号存不存在"的接口——chat 端点对任意 model 值都回 200，
 * 拿它做存在性判断只会得到一排假的 ✓（2026-07-30 实测，见文件头）。
 *
 * 实测返回四个：
 *   kimi-for-coding            K2.7 Coding             262144
 *   kimi-for-coding-highspeed  K2.7 Coding Highspeed   262144
 *   k3                         K3                     1048576  （支持 think_efforts）
 *   k3-256k                    K3-256k                 262144
 */
export async function listServerModels(): Promise<ServerModel[] | null> {
  const token = await getValidAccessToken()
  if (!token) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(MODELS_URL, {
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
    : catalog?.length
      ? catalog.map((m) => m.id)
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
