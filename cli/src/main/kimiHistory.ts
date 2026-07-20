import { AcpClient } from './agent/AcpClient'
import { resolveWindowsKimiCommand } from './windowsKimi'
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
 * is replayed by `session/load` when a session is resumed (KimiBackend swallows
 * the replay). getSessionMessages therefore returns [] and the sidebar resume
 * opens an empty transcript whose agent-side context is still intact. Revisit
 * rendering the replayed history into the transcript.
 */

let client: AcpClient | null = null
let clientPromise: Promise<AcpClient> | null = null

function ensureClient(): Promise<AcpClient> {
  if (client) return Promise.resolve(client)
  if (!clientPromise) {
    const resolved = resolveWindowsKimiCommand()
    clientPromise = AcpClient.start({
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
        client = null
        clientPromise = null
      }
    }).then((started) => {
      client = started
      return started
    }).catch((error) => {
      clientPromise = null
      throw error
    })
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

export async function listKimiSessions(
  cwd: string,
  opts: { limit: number; offset: number }
): Promise<SessionListItem[]> {
  try {
    const acp = await ensureClient()
    const response = await acp.request<Record<string, unknown>>('session/list', {}, 30000)
    const rawSessions = Array.isArray(response?.sessions)
      ? response.sessions
      : Array.isArray(response)
        ? response
        : []
    const targetCwd = normalizeCwd(cwd)
    const sessions: SessionListItem[] = []
    for (const raw of rawSessions) {
      const entry = asRecord(raw)
      if (!entry) continue
      const sessionId = asString(entry.sessionId) ?? asString(entry.id)
      if (!sessionId) continue
      const entryCwd = asString(entry.cwd)
      // 只列当前项目目录的会话（条目不带 cwd 时保守放行）。
      if (entryCwd && normalizeCwd(entryCwd) !== targetCwd) continue
      sessions.push({
        sessionId,
        agentBackend: 'kimi',
        summary: asString(entry.title) ?? asString(entry.summary) ?? asString(entry.name) ?? '',
        lastModified: asTimestamp(entry.updatedAt) ?? asTimestamp(entry.lastModified) ?? 0,
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
