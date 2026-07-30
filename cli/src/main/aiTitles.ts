import { app } from 'electron'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './logger'
import { getValidAccessToken } from './usageService'
import { loadSettings } from './settings'
import { manualSessionTitle } from './sessionTitles'

/**
 * AI 会话命名：用 kimi 云端 chat/completions 把用户发言概括成短标题。
 *
 * 成本硬约束（用户已确认"目的是好区分，不追求完美"）：
 * - 每会话至多 2 次调用：首轮结束用首条发言快速命名；攒够前 3 次发言后
 *   精修一次（#17，只覆盖 AI 生成的标题，手动命名永远不动）；本地
 *   ai-titles.json 缓存，除此之外绝不调 API；
 * - 单次输入截断 ~500 字符，thinking 关闭 + max_tokens=50，
 *   实测单次调用 ≈100-200 token；
 * - 失败静默回退原标题，单次尝试不重试。
 *
 * 端点已实证：POST https://api.kimi.com/coding/v1/chat/completions，
 * model kimi-for-coding + thinking:{type:'disabled'} → 53 tokens 出标题。
 * access_token 走 usageService 的凭证刷新链，绝不写日志、不进渲染层。
 */

const CHAT_COMPLETIONS_URL = 'https://api.kimi.com/coding/v1/chat/completions'
const TITLE_MODEL = 'kimi-for-coding'
const MAX_PROMPT_CHARS = 500
const MAX_TITLE_CHARS = 30
const REQUEST_TIMEOUT_MS = 20000
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

function cleanTitle(raw: string): string | null {
  const title = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'「『《]+|["'」』》。.\s]+$/g, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim()
  return title || null
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

  const token = await getValidAccessToken()
  if (!token) return null

  const prompt = firstUserText.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: 50,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: '用 12 个字以内概括这个对话的主题，只输出标题本身，不要标点结尾。' },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      log('ai-titles', `title request rejected: ${response.status}`)
      return null
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const title = cleanTitle(json.choices?.[0]?.message?.content ?? '')
    if (!title) return null
    load()[sessionId] = title
    save()
    log('ai-titles', `named ${sessionId}: ${title}`)
    return title
  } catch (error) {
    log('ai-titles', `title request failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 从磁盘读会话的首条/最近用户消息（~/.kimi-code/sessions/wd_*​/sessionId/
 *  state.json 的 lastPrompt，实测存在）。读不到返回 null。 */
export function readSessionPromptFromDisk(sessionId: string): string | null {
  try {
    const root = join(homedir(), '.kimi-code', 'sessions')
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
 *  有缓存/手动命名/读不到 lastPrompt 的跳过。 */
export async function generateAiTitlesBatch(sessionIds: string[]): Promise<AiTitlesBatchResult> {
  const result: AiTitlesBatchResult = { generated: 0, skipped: 0, failed: 0 }
  if (!aiNamingEnabled()) return result
  for (const sessionId of sessionIds) {
    if (load()[sessionId] || manualSessionTitle(sessionId)) {
      result.skipped++
      continue
    }
    const prompt = readSessionPromptFromDisk(sessionId)
    if (!prompt) {
      result.skipped++
      continue
    }
    const title = await generateAiTitle(sessionId, prompt)
    if (title) result.generated++
    else result.failed++
    await new Promise((resolve) => setTimeout(resolve, BATCH_INTERVAL_MS))
  }
  return result
}

/** 悬停预览（零 token）：首条消息截断 80 字。消息数 state.json 没有就不给。 */
export function getSessionPreview(sessionId: string): { firstPrompt?: string } {
  const prompt = readSessionPromptFromDisk(sessionId)
  if (!prompt) return {}
  return { firstPrompt: prompt.replace(/\s+/g, ' ').trim().slice(0, 80) }
}
