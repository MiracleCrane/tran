import { AcpClient } from './agent/AcpClient'
import { resolveWindowsKimiCommand } from './windowsKimi'
import { localSessionTitle, manualSessionTitle } from './sessionTitles'
import { aiSessionTitle } from './aiTitles'
import { log } from './logger'
import type { SessionListItem } from '../shared/ipc'

/**
 * Kimi session history via ACP.
 *
 * Kimi keeps its transcripts inside the CLI's own storage; the supported way to
 * enumerate them is `session/list` on an ACP connection (advertised via
 * sessionCapabilities.list). We keep a small long-lived `kimi acp` process just
 * for history queries — separate from the AgentBridge's session client.
 *
 * TODO(history): ACP has no "read messages of an old session" method — history
 * is replayed by `session/load` when a session is resumed, and KimiBackend now
 * accumulates the replay into transcript items (system/history). getSessionMessages
 * therefore still returns []; the sidebar resume view is driven by the replay.
 */

let client: AcpClient | null = null
let clientPromise: Promise<AcpClient> | null = null
let lastUsedAt = 0

/** 历史连接空闲 TTL：kimi 进程内的 session/list 数据快照会过期（实测列表冻结），
 *  空闲超过 TTL 的连接下次使用前关闭重建——外部新会话最多落后一个 TTL 可见。
 *  此外每次查询后由 armIdleReaper 主动回收：到点仍空闲即关闭连接，避免 kimi
 *  进程在之后再无查询时白驻留到应用退出（单个约 300MB）。 */
const HISTORY_CLIENT_IDLE_TTL_MS = 30_000

let idleTimer: ReturnType<typeof setTimeout> | null = null

/** 主动空闲回收：TTL 原本只在下次使用时惰性判断——若之后再也没有历史查询，
 *  空闲的 kimi 进程（实测约 300MB）会一直驻留到应用退出。每次查询后武装
 *  定时器，到点仍空闲就主动关闭连接让进程退出；再次查询会重建。 */
function armIdleReaper(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!client || Date.now() - lastUsedAt < HISTORY_CLIENT_IDLE_TTL_MS) return
    client.close()
    client = null
    clientPromise = null
  }, HISTORY_CLIENT_IDLE_TTL_MS)
  idleTimer.unref?.()
}

function ensureClient(): Promise<AcpClient> {
  if (client) {
    if (Date.now() - lastUsedAt <= HISTORY_CLIENT_IDLE_TTL_MS) return Promise.resolve(client)
    // 空闲超时：主动关闭旧连接。其 close 事件异步到达，onClose 里有代际比对，
    // 不会抹掉下面重建的新连接。
    client.close()
    client = null
    clientPromise = null
  }
  if (!clientPromise) {
    let promise!: Promise<AcpClient>
    promise = (async () => {
      const resolved = await resolveWindowsKimiCommand()
      return AcpClient.start({
      command: resolved.command,
      argsPrefix: resolved.argsPrefix,
      args: ['acp'],
      displayPath: resolved.displayPath,
      logTag: 'kimi-history',
      clientInfo: { name: 'tran', title: 'Tran', version: '1.0.0' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    }, {
      onNotification: () => {},
      onServerRequest: (msg) => {
        // 历史连接不处理任何反向请求（权限/文件读写都属于活跃会话）。
        if (msg.id !== undefined) client?.respondError(msg.id, 'Tran history client does not handle requests.', -32601)
      },
      onClose: () => {
        // 只清理“当前这一代”连接的关闭：过期被换下的旧连接 close 事件晚到时，
        // 不能误清已重建的新连接。
        if (clientPromise === promise) {
          client = null
          clientPromise = null
        }
      }
    })
    })().then((started) => {
      client = started
      return started
    }).catch((error) => {
      if (clientPromise === promise) clientPromise = null
      throw error
    })
    clientPromise = promise
  }
  return clientPromise
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Windows 路径归一化：正斜杠、去尾斜杠、小写（kimi session/list 返回
 *  `C:/project/...`，而渲染层传入的 cwd 通常是反斜杠路径，直接 === 会全被滤掉）。 */
function normalizeCwd(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 无标题会话的显示豁免。
 *
 * kimi 对从没发过消息的会话，title 恒为 "New Session"。这类空壳不该出现在
 * 侧栏，但有一个必须留的例外：用户刚发出第一条消息、kimi 那边标题还没刷新
 * 的那几秒——正在说话的对话不能从列表里消失。
 *
 * 原先用的是「最近 10 分钟更新过就豁免」。太宽了：任何在 10 分钟内被写过的
 * 空会话都会现身，用户看到的就是"切个会话又冒出来一条 New Session，过一会儿
 * 自己又没了"。现在改成只豁免**本进程当前还持有的那些 ACP 会话**（liveIds，
 * 由主进程的 AgentBridge 提供）——即"你现在开着的/刚后台化的"，历次运行残留
 * 的空壳一律立刻过滤。
 */
export async function listKimiSessions(
  cwd: string,
  opts: { limit: number; offset: number; scope?: 'project' | 'all'; liveIds?: Set<string> }
): Promise<SessionListItem[]> {
  try {
    const acp = await ensureClient()
    lastUsedAt = Date.now()
    armIdleReaper()
    const response = await acp.request<Record<string, unknown>>('session/list', {}, 30000)
    const rawSessions = Array.isArray(response?.sessions)
      ? response.sessions
      : Array.isArray(response)
        ? response
        : []
    const targetCwd = normalizeCwd(cwd)
    const allProjects = opts.scope === 'all'
    const sessions: SessionListItem[] = []
    for (const raw of rawSessions) {
      const entry = asRecord(raw)
      if (!entry) continue
      const sessionId = asString(entry.sessionId) ?? asString(entry.id)
      if (!sessionId) continue
      const entryCwd = asString(entry.cwd)
      // 「当前项目」只列本目录的会话（条目不带 cwd 时保守放行）；「全部」不过滤。
      if (!allProjects && entryCwd && normalizeCwd(entryCwd) !== targetCwd) continue
      // 标题优先级：手动重命名 > AI 命名 > kimi 原标题 > 本地首条消息兜底。
      const kimiTitle = asString(entry.title) ?? asString(entry.summary) ?? asString(entry.name) ?? ''
      const kimiTitleValid = kimiTitle && kimiTitle !== 'New Session' ? kimiTitle : undefined
      const displayTitle =
        manualSessionTitle(sessionId) ?? aiSessionTitle(sessionId) ?? kimiTitleValid ?? localSessionTitle(sessionId)
      const lastModified = asTimestamp(entry.updatedAt) ?? asTimestamp(entry.lastModified) ?? 0
      // 空壳治理：无有效标题（= 没发过消息）的会话只有当它还被本进程持有时
      // 才显示，见上面 listKimiSessions 的注释。
      if (!displayTitle && !opts.liveIds?.has(sessionId)) continue
      sessions.push({
        sessionId,
        agentBackend: 'kimi',
        summary: displayTitle ?? kimiTitle,
        lastModified,
        ...(entryCwd ? { cwd: entryCwd } : {}),
        runtimeBackend: 'windows'
      })
    }
    return sessions
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(opts.offset, opts.offset + opts.limit)
  } catch (error) {
    log('kimi-history', `listKimiSessions failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}
