import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { HistoryMessage, SessionListItem } from '../shared/ipc'
import { log } from './logger'
import { resolveWindowsHermesCommand } from './windowsHermes'

type JsonRecord = Record<string, unknown>

interface HermesExportedSession extends JsonRecord {
  id: string
  messages?: JsonRecord[]
}

function runHermes(args: string[], timeoutMs = 30000): string {
  const resolved = resolveWindowsHermesCommand()
  const result = spawnSync(resolved.command, [...resolved.argsPrefix, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `hermes exited ${result.status ?? 'unknown'}`)
  }
  return result.stdout ?? ''
}

function parseJsonLines(text: string): JsonRecord[] {
  const out: JsonRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as JsonRecord)
      }
    } catch {
      /* skip malformed export lines */
    }
  }
  return out
}

function exportHermesSessions(): HermesExportedSession[] {
  return parseJsonLines(runHermes(['sessions', 'export', '--source', 'acp', '-'], 120000))
    .filter((session): session is HermesExportedSession => typeof session.id === 'string')
}

function exportHermesSession(sessionId: string): HermesExportedSession | null {
  const session = parseJsonLines(runHermes(['sessions', 'export', '--session-id', sessionId, '-'], 30000))
    .find((item) => typeof item.id === 'string')
  return session ? (session as HermesExportedSession) : null
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
  } catch {
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase()
  }
}

function samePath(a: string | undefined, b: string): boolean {
  const left = normalizeComparablePath(a)
  const right = normalizeComparablePath(b)
  return !left || !right || left === right
}

function sessionCwd(session: JsonRecord): string | undefined {
  const direct = asString(session.cwd)
  if (direct) return direct
  const config = parseMaybeJsonRecord(session.model_config)
  return asString(config?.cwd) ?? asString(config?.workspace) ?? asString(config?.working_dir)
}

function sessionPreview(session: HermesExportedSession): string {
  const title = asString(session.title)
  if (title) return title
  const preview = asString(session.preview)
  if (preview) return preview
  for (const message of session.messages ?? []) {
    if (message.role !== 'user') continue
    const text = textFromContent(message.content)
    if (text) return text.replace(/\s+/g, ' ').slice(0, 120)
  }
  return 'Hermes session'
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return timestampMs(numeric)
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function sessionLastModified(session: HermesExportedSession): number {
  return (
    timestampMs(session.last_active) ||
    timestampMs(session.ended_at) ||
    timestampMs(lastMessage(session)?.timestamp) ||
    timestampMs(session.started_at) ||
    Date.now()
  )
}

function lastMessage(session: HermesExportedSession): JsonRecord | undefined {
  const messages = session.messages ?? []
  return messages.length ? messages[messages.length - 1] : undefined
}

export function listHermesSessions(
  cwd: string,
  options: { limit: number; offset: number }
): SessionListItem[] {
  try {
    return exportHermesSessions()
      .filter((session) => session.archived !== 1 && session.archived !== true)
      .filter((session) => samePath(sessionCwd(session), cwd))
      .sort((a, b) => sessionLastModified(b) - sessionLastModified(a))
      .slice(options.offset, options.offset + options.limit)
      .map((session) => ({
        sessionId: session.id,
        agentBackend: 'hermes' as const,
        summary: sessionPreview(session),
        lastModified: sessionLastModified(session),
        cwd: sessionCwd(session),
        runtimeBackend: 'windows' as const
      }))
  } catch (error) {
    log('hermes-history', `list sessions failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export function getHermesSessionMessages(sessionId: string): HistoryMessage[] {
  try {
    const session = exportHermesSession(sessionId)
    if (!session) return []
    return (session.messages ?? [])
      .flatMap((message, index) => historyMessagesFromHermesMessage(session.id, message, index))
      .slice(0, 500)
  } catch (error) {
    log('hermes-history', `get messages failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

export function renameHermesSession(sessionId: string, title: string): void {
  const trimmed = title.trim()
  if (!trimmed) return
  runHermes(['sessions', 'rename', sessionId, trimmed], 30000)
}

export function deleteHermesSession(sessionId: string): void {
  runHermes(['sessions', 'delete', '--yes', sessionId], 30000)
}

function historyMessagesFromHermesMessage(
  sessionId: string,
  message: JsonRecord,
  index: number
): HistoryMessage[] {
  const role = asString(message.role)
  const uuid = asString(message.id) ?? `hermes-history-${index}`
  if (role === 'user') {
    return [historyUser(sessionId, uuid, contentForUser(message))]
  }
  if (role === 'assistant') {
    const content: JsonRecord[] = []
    const text = textFromContent(message.content)
    if (text) content.push({ type: 'text', text })
    const reasoning = asString(message.reasoning_content) ?? asString(message.reasoning)
    if (reasoning) content.unshift({ type: 'thinking', thinking: reasoning })
    for (const toolCall of toolCalls(message.tool_calls)) {
      content.push(toolUseBlock(toolCall, content.length))
    }
    if (!content.length) return []
    return [historyAssistant(sessionId, uuid, content)]
  }
  if (role === 'tool') {
    const toolUseId = asString(message.tool_call_id) ?? `hermes-tool-${index}`
    return [historyToolResult(sessionId, uuid, toolUseId, textFromContent(message.content), false)]
  }
  return []
}

function historyUser(sessionId: string, uuid: string, content: string | JsonRecord[]): HistoryMessage {
  return {
    type: 'user',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content }
  }
}

function historyAssistant(sessionId: string, uuid: string, content: JsonRecord[]): HistoryMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { content }
  }
}

function historyToolResult(
  sessionId: string,
  uuid: string,
  toolUseId: string,
  content: string,
  isError: boolean
): HistoryMessage {
  return historyUser(sessionId, uuid, [
    { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }
  ])
}

function contentForUser(message: JsonRecord): string | JsonRecord[] {
  const text = textFromContent(message.content)
  if (text) return text
  return []
}

function toolUseBlock(toolCall: JsonRecord, index: number): JsonRecord {
  const fn = asRecord(toolCall.function)
  const id = asString(toolCall.id) ?? `hermes-tool-${index}`
  const name = asString(fn?.name) ?? asString(toolCall.name) ?? asString(toolCall.type) ?? 'tool'
  const rawArguments = fn?.arguments ?? toolCall.arguments ?? toolCall.input
  return {
    type: 'tool_use',
    id,
    name,
    input: parseToolInput(rawArguments)
  }
}

function parseToolInput(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord
  if (typeof value === 'string') {
    const parsed = parseMaybeJsonRecord(value)
    if (parsed) return parsed
    return { input: value }
  }
  return {}
}

function toolCalls(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is JsonRecord => !!asRecord(item))
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value.map(textFromContentItem).filter(Boolean).join('\n')
  }
  const record = asRecord(value)
  if (!record) return ''
  return asString(record.text) ?? asString(record.content) ?? stringifyJson(record)
}

function textFromContentItem(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (!record) return ''
  if (record.type === 'text') return asString(record.text) ?? ''
  if (record.type === 'image') return '[image]'
  return asString(record.text) ?? asString(record.content) ?? ''
}

function parseMaybeJsonRecord(value: unknown): JsonRecord | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null
  } catch {
    return null
  }
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
