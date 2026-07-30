import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { log } from './logger'
import { cheapSummarize } from './cheapModel'
import { loadSettings } from './settings'

/**
 * 总结类杂活的第二、第三项：**命令一句话说明**与**思考块摘要**。
 * （第一项是会话命名，在 aiTitles.ts。）
 *
 * 请求形态全部走 cheapModel.ts 的 cheapSummarize——多轮角色少样本 + stop +
 * terseText 三道防线，理由见那边的注释。这里只管"什么时候问、问完存哪"。
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
 * 2. **一律缓存，且落盘**。命令重复率极高（npm run build 这种一天几十次），
 *    按内容哈希缓存，跨重启复用。缓存命中不发请求。
 * 3. **失败静默**。返回 null，调用方继续用原来的规则摘要/前 60 字截断——
 *    这两项都是锦上添花，任何一次失败都不该在界面上留下痕迹。
 *
 * 关掉方式：设置页「AI 自动命名」同一个开关（summaryNotesEnabled 未显式关闭
 * 时跟随它）——用户关掉 AI 命名的意思就是"别拿我的额度做这类事"。
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

type NoteKind = 'cmd' | 'think'

let cache: Record<string, string> | null = null
/** 读盘失败后本次运行不再写入：每条都是花额度换来的，空对象写回等于全烧掉。
 *  与 aiTitles 同一套约定。 */
let loadFailed = false
/** 同一个 key 正在飞行中的请求：同一条命令在一屏里出现多次时只打一发。 */
const inflight = new Map<string, Promise<string | null>>()

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
  cache = (raw as Record<string, string> | null) ?? {}
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

/** 缓存键用内容哈希：命令可能很长，思考块更长，不适合直接做键。 */
function cacheKey(kind: NoteKind, text: string): string {
  return `${kind}:${createHash('sha1').update(text).digest('hex').slice(0, 16)}`
}

/** 跟随「AI 自动命名」开关：关掉它就是不想让 Tran 拿额度做总结类杂活。 */
function notesEnabled(): boolean {
  return loadSettings().aiNamingEnabled !== false
}

async function note(
  kind: NoteKind,
  rawInput: string,
  opts: { instruction: string; examples: Array<[string, string]>; maxChars: number; maxInput: number }
): Promise<string | null> {
  if (!notesEnabled()) return null
  const input = rawInput.replace(/\s+/g, ' ').trim().slice(0, opts.maxInput)
  if (!input) return null

  const key = cacheKey(kind, input)
  const cached = load()[key]
  if (cached !== undefined) return cached || null

  const pending = inflight.get(key)
  if (pending) return pending

  const run = cheapSummarize({
    instruction: opts.instruction,
    examples: opts.examples,
    input,
    maxChars: opts.maxChars
  })
    .then((result) => {
      // 判废（null）也存进去，存空串。否则同一条命令每次进视口都要重打一发——
      // 模型对同一个输入判废一次就会判废第二次，重试纯属浪费额度。
      load()[key] = result ?? ''
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

/**
 * 一条 bash 命令在做什么。
 *
 * 调用前提：这条命令**没有 description**。有 description 时 Kimi 已经给了意图，
 * 再问一遍是白花额度（见 ToolCallCard 的 summaryForTool）。
 */
export async function explainCommand(command: string): Promise<string | null> {
  return note('cmd', command, {
    instruction: '说明这条命令在做什么',
    examples: [
      ['git status --porcelain', '查看改动'],
      ['pytest tests/api -k login', '跑登录相关测试']
    ],
    maxChars: COMMAND_NOTE_CHARS,
    maxInput: MAX_COMMAND_CHARS
  })
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
