import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { log } from './logger'
import { cheapSummarize, cheapComplete } from './cheapModel'
import { loadSettings } from './settings'

/**
 * 总结类杂活的第二、第三项：**命令一句话说明**与**思考块摘要**。
 * （第一项是会话命名，在 aiTitles.ts。）
 *
 * 请求形态全部走 cheapModel.ts 的 cheapSummarize——多轮角色少样本 +
 * terseText 两道防线（原第三道 stop:['\n'] 已删：会把换行开头的模型
 * 在第 0 字截断，见 cheapModel.ts），理由见那边的注释。这里只管"什么时候问、问完存哪"。
 *
 * --- 2026-07-30 实测：这两项都成立 ---
 * 交接文档把它们卡在"等用户点提示词自检"，怕的是压不住格式。实测：
 *   命令说明   4 条真实命令 3 条合格，1 条判废（安全失败，回退显示原命令）
 *   思考块摘要 8 次全部合格。这项本来最可疑——输入 100~200 字，比命令长一个
 *              量级，容易重新触发"写长文"的反射，结果被少样本压住了
 * 延迟中位 ~1s。
 *
 * --- 三条硬约束 ---
 * 1. **绝不在流式期间调用**。调用方只在块收尾后才问；流式期间界面用规则摘要，
 *    本来就够看。
 * 2. **成功才缓存，且落盘**。命令重复率极高（npm run build 这种一天几十次），
 *    按内容哈希缓存，跨重启复用。缓存命中不发请求。
 *    2026-09-04 起判废/API 失败**不再落盘**：判废与失败是同一个 null，
 *    旧版把 null 以空串永久缓存（假设"判废一次就会判废第二次"），一次
 *    网络抖动 = 该块永久空白（实测 500 条上限里压着 45 条空串）。
 *    失败改走内存级 TTL 冷却（见 failedAt）。
 * 3. **失败静默**。返回 null，调用方继续用原来的规则摘要/前 60 字截断——
 *    这两项都是锦上添花，任何一次失败都不该在界面上留下痕迹。
 *
 * 关掉方式：设置页「AI 自动命名」那一个开关（aiNamingEnabled）——用户关掉
 * AI 命名的意思就是"别拿我的额度做这类事"，命令说明、思考摘要、思考翻译
 * 一并停掉。没有单独的开关。
 */

const STORE_FILE = 'cheap-notes.json'
/** 命令说明上限：折叠态一行要放得下，和规则摘要并排。 */
const COMMAND_NOTE_CHARS = 12
/** 思考块摘要上限：比命令说明宽一点，一段思考通常要多两三个字才说得清。 */
const THINKING_NOTE_CHARS = 16
/** 送进模型的输入上限。思考块可以很长，但前 600 字足够概括意图了。 */
const MAX_THINKING_CHARS = 600
const MAX_COMMAND_CHARS = 400
/** 缓存条数上限。超了按插入顺序丢最旧的——命令的重复是近期聚集的。 */
const MAX_ENTRIES = 500

type NoteKind = 'cmd' | 'think' | 'zh' | 'edit' | 'group'

/**
 * 思考翻译的输入上限。
 *
 * 这个 4000 是当初按「走 kimi 网页免费通道」定的，那条通道已经在
 * v1.0.46 随网页接口一起删掉了。现在它走用户自己配的 API，是全 app **最贵
 * 的一次调用**：4000 字进、maxTokens 2048 出，每展开一个思考块一次。
 *
 * 仍然留在 4000 而不是砍小：翻译要的就是整段，砍一半等于给用户看半篇译文，
 * 那比不翻还糟。控成本靠的是另外三条——按需触发（不展开不翻）、按内容哈希
 * 落盘缓存、失败后的内存级重试冷却。真要省，关掉「AI 自动命名」一起停。
 */
const MAX_TRANSLATE_CHARS = 4000

let cache: Record<string, string> | null = null
/** 读盘失败后本次运行不再写入：每条都是花额度换来的，空对象写回等于全烧掉。
 *  与 aiTitles 同一套约定。 */
let loadFailed = false
/** 同一个 key 正在飞行中的请求：同一条命令在一屏里出现多次时只打一发。 */
const inflight = new Map<string, Promise<string | null>>()

/**
 * 判废/API 失败的内存级重试冷却（2026-09-04 新增）。
 *
 * 失败不再落盘之后必须有这么一层，否则 group 类组件 remount 会反复重打
 * （实测一分钟 ~30 发）：同一 key 失败后 TTL 内直接回 null，TTL 过后允许
 * 重试——判废的输入是确定的，重试大概率还是判废，但 5 分钟一发的频率
 * 谈不上浪费额度，换来的是"网络抖动后该块能自愈"。
 */
const FAILURE_RETRY_TTL_MS = 5 * 60_000
/** 冷却表的条数上限：防长会话无限涨（Map 按插入序，超了删最旧）。 */
const FAILURE_RETRY_MAX_KEYS = 500
const failedAt = new Map<string, number>()

function markFailure(key: string): void {
  if (failedAt.size >= FAILURE_RETRY_MAX_KEYS) {
    const oldest = failedAt.keys().next().value
    if (oldest !== undefined) failedAt.delete(oldest)
  }
  failedAt.set(key, Date.now())
}

function inFailureCooldown(key: string): boolean {
  const at = failedAt.get(key)
  return at !== undefined && Date.now() - at < FAILURE_RETRY_TTL_MS
}

function storePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function load(): Record<string, string> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('cheap-notes', `${STORE_FILE} 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('cheap-notes', `${STORE_FILE} 内容不是对象，本次运行不再写入`)
    cache = {}
    loadFailed = true
    return cache
  }
  const store = (raw as Record<string, string> | null) ?? {}
  // 2026-09-04 清理存量空串条目：旧版把判废/失败以 '' 落盘永久缓存，
  // 读盘时把这些条目滤掉（命中 '' 等于永久空白），清到过就顺手重写一次盘。
  let dropped = 0
  for (const [key, value] of Object.entries(store)) {
    if (typeof value !== 'string' || value === '') {
      delete store[key]
      dropped++
    }
  }
  cache = store
  if (dropped > 0) {
    log('cheap-notes', `清理 ${dropped} 条空串缓存条目（历史判废/失败落盘）`)
    save()
  }
  return cache
}

function save(): void {
  if (loadFailed) return
  const store = load()
  const keys = Object.keys(store)
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[key]
  }
  try {
    writeFileAtomic(storePath(), JSON.stringify(store, null, 1))
  } catch (error) {
    log('cheap-notes', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 缓存键用内容哈希：命令可能很长，思考块更长，不适合直接做键。
 *  键里带字数预算：预算不同就是不同的一句话，不该命中同一条缓存。
 *  2026-08-24 整组总结 24 → 60 字时借此把旧预算下的缓存一次性失效
 *  （免费通道，全部重打一遍无妨）；翻译没有截断预算，记 0。 */
function cacheKey(kind: NoteKind, text: string, maxChars: number): string {
  return `${kind}:${maxChars}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`
}

/** 跟随「AI 自动命名」开关：关掉它就是不想让 Tran 拿额度做总结类杂活。 */
function notesEnabled(): boolean {
  return loadSettings().aiNamingEnabled !== false
}

async function note(
  kind: NoteKind,
  rawInput: string,
  opts: {
    instruction: string
    examples: Array<[string, string]>
    maxChars: number
    maxInput: number
  }
): Promise<string | null> {
  if (!notesEnabled()) return null
  const input = rawInput.replace(/\s+/g, ' ').trim().slice(0, opts.maxInput)
  if (!input) return null

  const key = cacheKey(kind, input, opts.maxChars)
  const cached = load()[key]
  if (cached !== undefined) return cached || null

  // 失败冷却期内直接回 null，不重打（防 group 组件 remount 的请求风暴）。
  if (inFailureCooldown(key)) return null

  const pending = inflight.get(key)
  if (pending) return pending

  const run = cheapSummarize({
    instruction: opts.instruction,
    examples: opts.examples,
    input,
    maxChars: opts.maxChars,
    kind
  })
    .then((result) => {
      // 2026-09-04 起只有非空结果才落盘：判废与 API 失败是同一个 null，
      // 落盘等于把一次抖动变成永久空白。失败进内存级 TTL 冷却（见 failedAt），
      // 既防 remount 重打风暴，又允许过后自愈重试。
      if (result === null) {
        markFailure(key)
        return null
      }
      load()[key] = result
      save()
      return result
    })
    .catch((error) => {
      log('cheap-notes', `${kind} 失败: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, run)
  return run
}

/** 文件编辑说明上限：比命令说明宽一点，"改了哪个文件的什么"要多两三个字。 */
const EDIT_NOTE_CHARS = 14
/** 集合行整组总结上限：跟在计数后面的一句话，行内容得下就全显，真超出行尾
 *  交给 CSS 省略号 + 悬停全文气泡（2026-08-24 用户拍板，24 → 60）。 */
const GROUP_NOTE_CHARS = 60
/** 编辑说明的输入上限：路径 + 新内容头足够表达意图。 */
const MAX_EDIT_SAMPLE_CHARS = 500
/** 整组总结的输入上限：各块首句拼起来，太长截断。 */
const MAX_GROUP_SAMPLE_CHARS = 800

/**
 * 一次文件编辑（Edit/Write）在做什么。
 *
 * 2026-08-18 用户：「每个编辑文件有总结（Bash 自带 description 不需要）」。
 * Bash 有 description 自报意图，编辑类工具没有——光看路径看不出改了什么。
 * 输入样本由渲染层拼好：路径 + 新内容头部（≤500 字），按内容哈希缓存。
 */
export async function explainEdit(sample: string): Promise<string | null> {
  return note('edit', sample, {
    instruction: '用一句话说明这次文件编辑改了什么',
    examples: [
      [
        'cli/src/renderer/components/Sidebar.tsx\nconst emptyProjectGroups = addedProjectRawPaths.filter((p) => !nonEmptyLabels.has(p))',
        '侧栏保留空项目组头'
      ],
      ['cli/package.json\n"version": "1.1.23"', '版本号升到 1.1.23'],
      ['cli/src/main/cheapModel.ts\n-  stop: [\'\\n\'],', '删掉摘要请求的 stop 参数']
    ],
    maxChars: EDIT_NOTE_CHARS,
    maxInput: MAX_EDIT_SAMPLE_CHARS
  })
}

/**
 * 一条折叠集合行（思考 N 段 + 工具 ×M）整组在做什么。
 *
 * 2026-08-18 用户：「这整个块有总结」。输入样本由渲染层从组内各块拼好
 * （每块取首句/工具摘要，≤800 字），按内容哈希缓存——同一组在历史重建后
 * 再渲染零成本。2026-09-04 起失败与其他类别同规则：不落盘，走 failedAt
 * 的 TTL 冷却（原 cacheNull=false 每次渲染重打，实测一分钟 ~30 发）。
 */
export async function summarizeActivityGroup(sample: string): Promise<string | null> {
  return note('group', sample, {
    instruction: '用一句话总结这一段 AI 工作做了什么',
    examples: [
      [
        '思考: 用户说压缩像假成功，需要查 wire 日志…\n读取文件: KimiBackend.ts\n编辑文件: cheapModel.ts\n运行命令: npm run typecheck',
        '排查并修复压缩假成功'
      ],
      [
        '思考: 侧栏段标字号太小…\n编辑文件: Sidebar.tsx\n编辑文件: Sidebar.tsx\n运行命令: npm run build',
        '调大侧栏段标字号'
      ]
    ],
    maxChars: GROUP_NOTE_CHARS,
    maxInput: MAX_GROUP_SAMPLE_CHARS
  })
}

/**
 * 破坏性标志 → 说明里必须出现的词。
 *
 * 12 个字装不下一条命令的全部含义，模型会挑它认为重要的说——而它挑掉的
 * 恰恰常是危险的那一半。2026-07-30 实测(见 DeepSeek 基准报告)：
 *   `git reset --hard HEAD~1`            → 「撤销最近一次提交」
 *   `git push --force-with-lease ...`    → 「安全推送认证分支」(Flash)
 * 第一条 Flash 和 Pro **都是**这样，丢弃未提交改动这件事整个消失了。用户扫
 * 一眼说明就点确认，丢的是没提交的活。换更强的型号解决不了——12 字的预算
 * 摆在那里。
 *
 * 所以这里不靠模型自觉：命中破坏性标志、而说明里一个对应的词都没有，就把
 * 这条说明判废。判废不是"没有说明"这么简单——界面上命令原文一直都在，说明
 * 只是跟在后面的一句注解(见 ToolCallCard)，去掉它用户看到的就是原始命令，
 * 那才是此时最诚实的展示。
 */
const RISK_RULES: Array<{ label: string; test: RegExp; keywords: string[] }> = [
  { label: 'force', test: /--force\b|--force-with-lease\b|(?:^|\s)-f(?=\s|$)/, keywords: ['强制', '强推', '覆盖'] },
  { label: 'hard-reset', test: /--hard\b/, keywords: ['丢弃', '硬', '重置', '强制'] },
  { label: 'delete', test: /--delete\b|-delete\b|--prune\b|\bprune\b|(?:^|\s)rm\s|Remove-Item/i, keywords: ['删除', '清理', '移除'] },
  { label: 'pipe-to-shell', test: /\|\s*(?:sudo\s+)?(?:ba|z|fi)?sh\b|\|\s*python\d?\b|Invoke-Expression|\biex\b/i, keywords: ['执行', '运行', '安装'] },
  { label: 'recurse-force', test: /-Recurse\b[\s\S]*-Force\b|-Force\b[\s\S]*-Recurse\b|(?:^|\s)-rf\b|(?:^|\s)-fr\b/i, keywords: ['强制', '递归', '删除'] }
]

/** 命中的破坏性规则里，有哪一条的关键词在说明中一个都没出现。 */
function droppedRisk(command: string, note: string): string | null {
  for (const rule of RISK_RULES) {
    if (!rule.test.test(command)) continue
    if (!rule.keywords.some((word) => note.includes(word))) return rule.label
  }
  return null
}

/**
 * 一条 bash 命令在做什么。
 *
 * 调用前提：这条命令**没有 description**。有 description 时 Agent 已经给了意图，
 * 再问一遍是白花额度（见 ToolCallCard 的 summaryForTool）。
 *
 * 两道防护，缺一不可：
 * 1. 少样本里放一条破坏性命令，把"危险语义要留住"示范给模型；
 * 2. 出来之后再按 RISK_RULES 查一遍，漏了就判废。
 * 光靠 1 压不住(报告里 Pro 也漏)，光靠 2 会误杀得太多。
 */
export async function explainCommand(command: string): Promise<string | null> {
  const result = await note('cmd', command, {
    instruction: '说明这条命令在做什么。带破坏性的操作必须点明（强制、删除、丢弃、覆盖）',
    examples: [
      ['git status --porcelain', '查看改动'],
      ['pytest tests/api -k login', '跑登录相关测试'],
      ['git reset --hard HEAD~1', '硬回退并丢弃改动']
    ],
    maxChars: COMMAND_NOTE_CHARS,
    maxInput: MAX_COMMAND_CHARS
  })
  if (!result) return null
  // 这一步刻意放在缓存之后：判废不写回缓存，将来改了词表，同一条命令的旧
  // 说明会被重新审一遍，不用等缓存过期，也不会因此多打一次请求。
  const dropped = droppedRisk(command, result)
  if (dropped) {
    log('cheap-notes', `命令说明漏掉「${dropped}」语义，判废改显示原命令`)
    return null
  }
  return result
}

/** 整段文本走用户配置的摘要 API，不做 terseText 清洗。 */
async function summarizeRaw(prompt: string): Promise<string | null> {
  const result = await cheapComplete({
    user: prompt,
    maxTokens: 2048,
    timeoutMs: 40000
  })
  return result.ok ? result.text : null
}

/**
 * 把思考过程整段译成中文。
 *
 * 为什么需要：Kimi 的思考过程大量是英文（模型内部推理用什么语言不受 Tran 控制，
 * 也不该靠提示词去掰——那会干扰它推理）。展开思考块看到一屏英文，等于没法看。
 * 折叠态那行有中文摘要还好，展开之后就只能硬读。
 *
 * 与 summarizeThinking 的分工：
 * - 折叠态 → 摘要（一句话，知道它在干嘛就行）
 * - 展开后 → 全文翻译（真要读的时候）
 * 两者都缓存，键不同。
 *
 * 通道（2026-08-14 用户定稿）：与命名/摘要/命令说明共用同一条「摘要 / 命名 API」
 * 通道，不再有百度/运营商引擎之分。没配 key 就是 null——没有也不该有"拿主 agent
 * 额度兜底"这一层（翻不了就显示原文，界面给一句轻提示）。
 */
export async function translateThinking(text: string): Promise<string | null> {
  if (!notesEnabled()) return null
  const input = text.trim().slice(0, MAX_TRANSLATE_CHARS)
  if (!input) return null

  // 翻译没有截断预算，预算位记 0（见 cacheKey 注释）。
  const key = cacheKey('zh', input, 0)
  const cached = load()[key]
  if (cached !== undefined) return cached || null

  // 与 note() 同一规则：失败冷却期内不重打。
  if (inFailureCooldown(key)) return null

  const pending = inflight.get(key)
  if (pending) return pending

  // 通道统一（2026-08-14 用户定稿）：翻译/命名/摘要全部走「摘要 / 命名 API」
  // 一条通道，不再有百度/运营商之分。没配 key → null（界面显示原文 + 轻提示）。
  const run = summarizeRaw(buildTranslatePrompt(input))
    .then((result) => {
      const value = result?.trim() ?? ''
      // 2026-09-04 起空结果不落盘（与 note() 同一语义：失败不该永久生效），
      // 进 TTL 冷却防每次展开都重打一发。
      if (!value) {
        markFailure(key)
        return null
      }
      load()[key] = value
      save()
      return value
    })
    .catch((error) => {
      log('cheap-notes', `思考翻译失败: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, run)
  return run
}

/** LLM 通道的翻译提示词（原文较长，抽出让 translateThinking 读起来顺）。 */
function buildTranslatePrompt(input: string): string {
  return [
    '把下面这段 AI 的思考过程翻译成中文。要求：',
    '1. 只输出译文本身，不要任何前言、解释或"以下是译文"之类的话；',
    '2. 保留原有的分段和换行；',
    '3. 代码、命令、文件路径、变量名、报错原文一律保持不变，不要翻译；',
    '4. 技术术语按中文技术圈的习惯译法，拿不准就保留英文。',
    '',
    '原文：',
    input
  ].join('\n')
}

/** 一段思考在做什么。折叠态用它替掉"正文前 60 字截断"。 */
export async function summarizeThinking(text: string): Promise<string | null> {
  return note('think', text, {
    instruction: '用一句话概括这段思考在做什么',
    examples: [
      [
        '用户说待办不更新。我需要先确认是渲染层没收到，还是主进程根本没拿到新数据。先看 IPC 那条链路，如果 IPC 有数据那问题在渲染层的 memo 上……',
        '定位待办不更新的环节'
      ],
      [
        '这个 400 报错的原因不能靠猜。我应该把四种请求形态各打一发，一次只动一个变量，看服务端原文怎么说。先构造基线……',
        '二分定位 400 的原因'
      ]
    ],
    maxChars: THINKING_NOTE_CHARS,
    maxInput: MAX_THINKING_CHARS
  })
}
