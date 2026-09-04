import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { join } from 'node:path'
import { log } from './logger'
import { kimiSessionsRoot } from './kimiHome'
import { cheapSummarize } from './cheapModel'
import { loadSettings } from './settings'
import { manualSessionTitle } from './sessionTitles'

/**
 * AI 会话命名：把用户发言概括成短标题。
 *
 * 请求本身走 cheapModel.ts 那条共用旁路（端点/鉴权/型号/超时都在那边），
 * 这里只管命名的策略与缓存。型号是设置项——命名和其他总结类杂活共用同一个。
 *
 * 成本硬约束（用户已确认"目的是好区分，不追求完美"）：
 * - 每会话至多 2 次调用：首轮结束用首条发言快速命名；攒够前 3 次发言后
 *   精修一次（#17，只覆盖 AI 生成的标题，手动命名永远不动）；本地
 *   ai-titles.json 缓存，除此之外绝不调 API；
 * - 单次输入截断 ~500 字符，thinking 关闭 + max_tokens=50，
 *   实测单次调用 ≈100-200 token；
 * - 失败静默回退原标题，单次尝试不重试。
 */

const MAX_PROMPT_CHARS = 500
/** 标题字数上限。少样本示例也按这个长度给，两边要一致。 */
const MAX_TITLE_CHARS = 12
const BATCH_INTERVAL_MS = 300

let cache: Record<string, string> | null = null
/** 读盘失败（区别于"文件不存在"）后本次运行不再写入：ai-titles.json 里每条
 *  都是花过 token 换来的，空对象写回去等于把整份缓存烧掉、下次全部重算。 */
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'ai-titles.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('ai-titles', `ai-titles.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('ai-titles', 'ai-titles.json 内容不是对象，本次运行不再写入')
    cache = {}
    loadFailed = true
    return cache
  }
  cache = (raw as Record<string, string> | null) ?? {}
  return cache
}

function save(): void {
  if (loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('ai-titles', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 设置页「AI 自动命名」开关（默认开）；关闭后任何路径都不调 API。 */
export function aiNamingEnabled(): boolean {
  return loadSettings().aiNamingEnabled !== false
}

export function aiSessionTitle(sessionId: string): string | undefined {
  return load()[sessionId]
}

export function allAiTitles(): Record<string, string> {
  return { ...load() }
}

/** 为单个会话生成 AI 标题（有缓存/手动命名/开关关闭时直接跳过；
 *  opts.overwriteAiTitle 允许覆盖已有 AI 标题——#17 前几次发言精修用）。
 *  手动重命名永远最高优先，AI 不覆盖。 */
export async function generateAiTitle(
  sessionId: string,
  firstUserText: string,
  opts?: { overwriteAiTitle?: boolean }
): Promise<string | null> {
  if (!aiNamingEnabled()) return null
  if (!sessionId || !firstUserText.trim()) return null
  const existing = load()[sessionId]
  if (existing && !opts?.overwriteAiTitle) return existing
  if (manualSessionTitle(sessionId)) return null

  const prompt = firstUserText.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS)
  // 少样本是压住"开始写长文"反射的关键（单靠 system 里的约束实测无效）。
  // 2026-08-19 提质：补一条"压缩措辞而非复述原话"的示范——小模型（GLM-4-9B）
  // 偷懒时会把首条消息原样截短当标题（"创建四个文件并写入内容"这种流水账）。
  const title = await cheapSummarize({
    instruction: '用一个短标题概括这段对话要做的事，提炼主题，不要复述原话',
    examples: [
      ['帮我看看这个登录接口为什么 401，token 明明是新的', '排查登录接口 401'],
      ['把侧边栏的会话列表改成虚拟滚动，现在几百条很卡', '侧边栏虚拟滚动'],
      ['在 .scratch 目录下依次创建 fold-a.txt、fold-b.txt、fold-c.txt 四个文件，每个写一行 hello', '批量创建测试文件']
    ],
    input: prompt,
    maxChars: MAX_TITLE_CHARS,
    kind: 'title'
  })
  if (!title) {
    log('ai-titles', '命名未得到可用结果（回退原标题）')
    return null
  }
  load()[sessionId] = title
  save()
  log('ai-titles', `named ${sessionId}: ${title}`)
  return title
}

/** 从磁盘读会话的首条/最近用户消息（$KIMI_CODE_HOME/sessions/wd_*​/sessionId/
 *  state.json 的 lastPrompt，实测存在）。读不到返回 null。
 *  路径走 kimiHome()：写死 ~/.kimi-code 在 home 被重定向时只会读到过期副本，
 *  新会话一律读空、AI 命名静默退化成兜底标题。 */
export function readSessionPromptFromDisk(sessionId: string): string | null {
  try {
    const root = kimiSessionsRoot()
    for (const wd of readdirSync(root, { withFileTypes: true })) {
      if (!wd.isDirectory()) continue
      const stateFile = join(root, wd.name, sessionId, 'state.json')
      if (!existsSync(stateFile)) continue
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastPrompt?: unknown }
      if (typeof state.lastPrompt === 'string' && state.lastPrompt.trim()) {
        return state.lastPrompt
      }
      return null
    }
  } catch (error) {
    log('ai-titles', `read prompt failed ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return null
}

export interface AiTitlesBatchResult {
  generated: number
  skipped: number
  failed: number
}

/** 老会话一键补全：串行逐个生成，每次间隔 ~300ms，避免并发打爆云端。
 *  有缓存/手动命名/读不到 lastPrompt 的跳过。
 *  onProgress 每个会话处理完报一次（done 含 skipped/failed）——批量可能跑
 *  几分钟，按钮上没进度就是用户眼里的"卡住"（2026-08-19 用户反馈）。 */
export async function generateAiTitlesBatch(
  sessionIds: string[],
  onProgress?: (done: number, total: number) => void
): Promise<AiTitlesBatchResult> {
  const result: AiTitlesBatchResult = { generated: 0, skipped: 0, failed: 0 }
  if (!aiNamingEnabled()) return result
  const total = sessionIds.length
  let done = 0
  for (const sessionId of sessionIds) {
    if (load()[sessionId] || manualSessionTitle(sessionId)) {
      result.skipped++
    } else {
      const prompt = readSessionPromptFromDisk(sessionId)
      if (!prompt) {
        result.skipped++
      } else {
        const title = await generateAiTitle(sessionId, prompt)
        if (title) result.generated++
        else result.failed++
        await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL_MS))
      }
    }
    done++
    onProgress?.(done, total)
  }
  return result
}

/** 悬停预览（零 token）：首条消息截断 80 字。消息数 state.json 没有就不给。 */
export function getSessionPreview(sessionId: string): { firstPrompt?: string } {
  const prompt = readSessionPromptFromDisk(sessionId)
  if (!prompt) return {}
  return { firstPrompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 80) }
}
