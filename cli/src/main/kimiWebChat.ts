import { log } from './logger'
import { getWebAccessToken } from './quotaService'

/**
 * 「网页免费通道」：走 www.kimi.com 的对话接口跑总结类小请求。
 *
 * --- 为什么值得单开一条（2026-07-30 用真实账号实测）---
 *
 * 总结类杂活原先全走 api.kimi.com/coding（cheapModel.ts），那条**计 Kimi Code
 * 的账**。而网页版对话是**不计费的**——不是推测，是从用户自己的额度流水里读出来的
 * （quotaService 的 ListBalanceActions）：
 *
 *   FEATURE_CODING     456 条   合计 ratio 0.0538   单条最大 0.0026（待办催更那一轮）
 *   FEATURE_AGENT (k3)   6 条   合计 ratio 0.0009
 *   FEATURE_CHAT       37 条   合计 ratio 0.0000   ← 每一条都是 0
 *
 * FEATURE_CHAT 的标题就是网页版的会话名（"k2.6: …"），37 条无一例外扣 0。
 * 所以把总结类挪到这条通道上，是真的一分额度不花。
 *
 * 凭证复用 quotaService 那条链（kimi-desktop 的 token-store + 刷新写回 +
 * 浏览器登录兜底），不需要用户再登一次。
 *
 * --- 这条通道的三个硬限制，设计必须绕着它们走 ---
 *
 * 1. **一次只吃一条消息。** `messages` 数组只有 `[0]` 被采纳（实测：把 system +
 *    少样本 + 真正输入四条一起发，服务端 `req` 事件回显的 content 只有 system
 *    那一句，其余全丢，随后报错）。这是聊天 UI 的接口，历史在服务端。
 *    → 少样本只能内嵌进同一条消息。**注意这跟 coding 端点正好相反**：那边把
 *      少样本塞进单条消息会「答非所问」，必须用多轮角色（见 cheapModel 注释）。
 *      两条通道的提示词形态不能共用，别想着统一。
 * 2. **会限流，而且挺容易。** 间隔 3s 连发 5 条，2 条回
 *    「刚刚和 Kimi 聊的人太多了」。→ 所以这条永远是「优先试，失败就回落」，
 *    绝不能当作唯一通道。
 * 3. **会话是有状态的。** 复用同一个 chat 会让后一条看见前一条的上下文（实测
 *    复用时输出全空）。→ 每次开新会话、用完删掉。代价是一次总结 3 个 HTTP
 *    往返（建/发/删），比 coding 端点慢一秒左右——对后台缓存类任务无所谓。
 *
 * 模型枚举由服务端定：`[kimi k1 k1.5 k2 k1.5-thinking]`（传别的回 422）。
 * 用 k2；流水里记成 FEATURE_CHAT，与网页版手动聊天同一个口径。
 */

const BASE = 'https://www.kimi.com'
/** 服务端允许的取值之一；传 k2.6 这类会 422（枚举见文件头）。 */
const WEB_MODEL = 'k2'
const CREATE_TIMEOUT_MS = 10000
const STREAM_TIMEOUT_MS = 25000

async function headers(): Promise<Record<string, string> | null> {
  const token = await getWebAccessToken()
  if (!token) return null
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

/** 建一次性会话。失败返回 null。 */
async function createChat(h: Record<string, string>): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS)
  try {
    const response = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: h,
      // 名字写清楚来源：万一删除失败留在用户的会话列表里，他要看得出这是谁建的。
      body: JSON.stringify({
        name: 'Tran 摘要（自动）',
        is_example: false,
        enter_method: 'new_chat',
        kimiplus_id: 'kimi'
      }),
      signal: controller.signal
    })
    if (!response.ok) return null
    const json = (await response.json()) as { id?: unknown }
    return typeof json.id === 'string' && json.id ? json.id : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 删掉一次性会话。失败只记日志——留个垃圾会话，不值得让调用方失败。 */
async function deleteChat(h: Record<string, string>, chatId: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/chat/${chatId}`, { method: 'DELETE', headers: h })
  } catch (error) {
    log('kimi-web', `临时会话删除失败 ${chatId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读 SSE，累积 cmpl 文本；命中 error 事件（多半是限流）返回 null。 */
async function readStream(response: Response): Promise<string | null> {
  const body = response.body
  if (!body) return null
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let out = ''
  let failed = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try {
        const event = JSON.parse(line.slice(5).trim()) as {
          event?: string
          text?: unknown
          error?: { message?: unknown }
        }
        if (event.event === 'cmpl' && typeof event.text === 'string') out += event.text
        if (event.event === 'error') {
          failed = true
          const message = typeof event.error?.message === 'string' ? event.error.message : '未知错误'
          log('kimi-web', `对话被拒（多半是限流）：${message.slice(0, 60)}`)
        }
      } catch {
        /* 非 JSON 的 data 行忽略 */
      }
    }
  }
  if (failed) return null
  const text = out.trim()
  return text || null
}

/**
 * 跑一次免费的总结请求。**任何异常都返回 null**，调用方必须回落到 coding 通道
 * ——这条通道会限流，把它当作「能省则省」而不是「必须成功」。
 */
export async function webSummarize(prompt: string): Promise<string | null> {
  const h = await headers()
  if (!h) return null
  const chatId = await createChat(h)
  if (!chatId) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  try {
    const response = await fetch(`${BASE}/api/chat/${chatId}/completion/stream`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        // 只有 [0] 会被采纳（见文件头限制 1）。
        messages: [{ role: 'user', content: prompt }],
        model: WEB_MODEL,
        use_search: false,
        use_deep_research: false,
        refs: [],
        history: [],
        scene_labels: [],
        extend: { sidebar: true }
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      log('kimi-web', `对话接口返回 ${response.status}`)
      return null
    }
    return await readStream(response)
  } catch (error) {
    log('kimi-web', `对话失败: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
    // 一次性会话用完就删，不在用户的 Kimi 会话列表里留垃圾。
    void deleteChat(h, chatId)
  }
}
