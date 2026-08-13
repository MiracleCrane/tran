import { log } from './logger'
import { ensureKimiServer } from './kimiServerApi'
import type { PlanEntryInfo } from '../shared/ipc'

/**
 * 待办真值：从 kimi 本地 server 直接读，**零 token**。
 *
 * --- 为什么需要这条路（2026-07-30 实测）---
 *
 * Tran 的待办此前只有一个来源：ACP 流里的 `plan` 帧。而 plan 帧只在模型跑 turn
 * 且恰好调了 todo_list 工具时才推。于是切走再切回来、或者重启之后，待办面板是
 * 空的，要等下一次模型碰待办才会重新出现——用户反复提的「待办更新总是不及时，
 * 或者一直就不更新了」，这是其中一半的直接原因（另一半是多会话轮询抢占，
 * 已由 45c61b7 修掉）。
 *
 * 真值在这里：
 *   GET /api/v1/sessions/{sessionId}/transcript?agent_id=main
 *   → data.todos = [{ todoId, items: [{title, status}], updatedAt }]
 *
 * ⚠️ `agent_id` 是**必需**参数，漏了会得到 200 + `{code:40001, msg:"agent_id:
 * Invalid input: expected string, received undefined"}`——HTTP 层是 200，错误在
 * 信封里，所以只看 res.ok 会以为成功。交接文档里记的 "GET /transcript 响应里
 * 直接带 todos" 漏了这个参数，照着写会拿到一个没有 todos 字段的错误信封。
 *
 * --- 为什么不用 WebSocket（交接文档 §3.1 的方案，实测走不通）---
 *
 * ws://127.0.0.1:<port>/api/v1/ws 本身是通的（子协议 `kimi-code.bearer.<token>`
 * 鉴权成功，server_hello 的 protocol_version=2），`subscribe` 的形状也试出来了：
 *   → {"type":"subscribe","payload":{"session_ids":[...]}}
 *   ← {"type":"ack","payload":{"accepted":[],"not_found":[...],"cursors":{}}}
 * 但**Tran 的会话全部落在 not_found 里**。原因：web server 只订阅得了它自己托管
 * 的会话，而 Tran 走的是 `kimi acp`（另一个进程）。这与 #34 记的 REST tasks 只
 * 覆盖 web server 自己的会话是同一条边界。
 *
 * 而同一个 sessionId 走上面那条 REST 却读得到真值——因为它读的是磁盘上的会话
 * 状态，不依赖"这个会话是不是我在跑"。所以：**REST 拉真值可行，WS 推送不可行**。
 * 别再去接 WS 了。
 *
 * server 连不上一律返回 null（静默降级）：待办是辅助信息，绝不能影响聊天主链路。
 */

const TODOS_TIMEOUT_MS = 6000

/** kimi 的 status 取值 → Tran 的 PlanEntry.status。 */
function mapStatus(raw: unknown): PlanEntryInfo['status'] {
  const s = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (s === 'done' || s === 'completed') return 'completed'
  if (s === 'in_progress' || s === 'active' || s === 'running') return 'in_progress'
  return 'pending'
}

export interface SessionTodos {
  entries: PlanEntryInfo[]
  /** 服务端记的最后更新时刻（epoch ms）；用来和实时 plan 帧比新旧。 */
  updatedAt: number | null
}

/**
 * 拉一个会话的待办真值。拿不到（server 没起、会话没有待办、网络错）返回 null，
 * 与"待办是空的"区分开——前者不该覆盖界面上已有的内容，后者应该。
 */
/** kimi server 的「会话不存在」错误码。 */
const SESSION_GONE_CODE = 40401

/** 哨兵：这个会话在 kimi 侧已经没了，别再轮询。与 null（暂时拉不到）区分。 */
export const SESSION_GONE = 'session-gone' as const

export async function fetchSessionTodos(
  sessionId: string
): Promise<SessionTodos | null | typeof SESSION_GONE> {
  // sessionId 会拼进 URL，先挡住路径穿越/注入。
  if (!/^[\w-]+$/.test(sessionId)) return null
  const handle = await ensureKimiServer()
  if (!handle) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TODOS_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${handle.baseUrl}/api/v1/sessions/${sessionId}/transcript?agent_id=main`,
      { headers: { authorization: `Bearer ${handle.token}` }, signal: controller.signal }
    )
    if (!response.ok) return null
    // HTTP 200 不等于成功：错误在信封的 code 字段里（见文件头）。
    const json = (await response.json()) as {
      code?: number
      msg?: string
      data?: { todos?: unknown }
    }
    if (json.code !== 0) {
      // 会话在 kimi 那边根本不存在（40401）：这不是"暂时拉不到"，是**永远**
      // 拉不到。以前一律返回 null，渲染层就每 10 秒重试一次、无限循环——实测
      // 日志里 `session not found` 刷了几百条，同时界面上既没有待办也没有任何
      // 提示。这类致命错误单独标记出来，让调用方停手。
      const gone = json.code === SESSION_GONE_CODE || /session not found/i.test(json.msg ?? '')
      if (gone) {
        log('kimi-todos', `会话已不存在，停止轮询：${sessionId}`)
        return SESSION_GONE
      }
      log('kimi-todos', `transcript 返回 code=${json.code} ${json.msg ?? ''}`)
      return null
    }
    const todos = json.data?.todos
    if (!Array.isArray(todos) || todos.length === 0) return { entries: [], updatedAt: null }

    // 形态：[{todoId, items:[{title,status}], updatedAt}]。目前恒为一组
    // （todoId:"todo"），但按数组处理——多组时全部摊平，顺序即服务端顺序。
    const entries: PlanEntryInfo[] = []
    let updatedAt: number | null = null
    for (const group of todos) {
      const record = group as { items?: unknown; updatedAt?: unknown }
      const at = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : NaN
      if (Number.isFinite(at)) updatedAt = Math.max(updatedAt ?? 0, at)
      if (!Array.isArray(record.items)) continue
      for (const item of record.items) {
        const it = item as { title?: unknown; status?: unknown }
        const content = typeof it.title === 'string' ? it.title.trim() : ''
        if (!content) continue
        entries.push({ content, status: mapStatus(it.status) })
      }
    }
    return { entries, updatedAt }
  } catch (error) {
    // AbortError 也走这里：超时不值得报警，待办拉不到就是拉不到。
    log('kimi-todos', `拉取待办失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
