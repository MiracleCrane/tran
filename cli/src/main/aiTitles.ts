import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from './logger'
import { getValidAccessToken } from './usageService'
import { loadSettings } from './settings'
import { manualSessionTitle } from './sessionTitles'

/**
 * AI 会话命名：用 kimi 云端 chat/completions 把首条用户消息概括成短标题。
 *
 * 成本硬约束（用户已确认"目的是好区分，不追求完美"）：
 * - 每会话只生成一次，本地 ai-titles.json 缓存，有缓存绝不再调 API；
 * - 输入只给首条消息（截断 ~500 字符），thinking 关闭 + max_tokens=50，
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

function storePath(): string {
  return join(app.getPath('userData'), 'ai-titles.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(storePath(), 'utf8')) as unknown
    cache = raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(): void {
  try {
    mkdirSync(dirname(storePath()), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(load(), null, 1), 'utf8')
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

/** 为单个会话生成 AI 标题（有缓存/手动命名/开关关闭时直接跳过）。
 *  手动重命名永远最高优先，AI 不覆盖。 */
export async function generateAiTitle(sessionId: string, firstUserText: string): Promise<string | null> {
  if (!aiNamingEnabled()) return null
  if (!sessionId || !firstUserText.trim()) return null
  const existing = load()[sessionId]
  if (existing) return existing
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
