import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { HistoryMessage, SessionListItem } from '../shared/ipc'
import { log } from './logger'
import { resolveMacCodexCommand } from './macCodex'

interface CodexIndexEntry {
  id: string
  thread_name?: string
  updated_at?: string
}

interface CodexRolloutMeta {
  id: string
  cwd?: string
  path: string
  archived?: boolean
  gitBranch?: string
  updatedAt?: number
  summary?: string
}

const rolloutCache = new Map<string, CodexRolloutMeta | null>()

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function sessionIndexPath(): string {
  return join(codexHome(), 'session_index.jsonl')
}

function readJsonLines(path: string): unknown[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
  } catch {
    return []
  }
}

function readSessionIndex(): CodexIndexEntry[] {
  return readJsonLines(sessionIndexPath()).filter(
    (entry): entry is CodexIndexEntry =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as CodexIndexEntry).id === 'string'
  )
}

function walkRollouts(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walkRollouts(path, out)
    else if (entry.isFile() && /^rollout-.+\.jsonl$/i.test(entry.name)) out.push(path)
  }
  return out
}

function parseRolloutMeta(path: string, archived = false): CodexRolloutMeta | null {
  try {
    const firstLine = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0]
    const first = JSON.parse(firstLine) as {
      type?: string
      payload?: {
        id?: string
        cwd?: string
        timestamp?: string
        git?: { branch?: string }
      }
    }
    const id = first.payload?.id ?? rolloutIdFromPath(path)
    if (!id) return null
    return {
      id,
      cwd: first.payload?.cwd,
      path,
      archived,
      gitBranch: first.payload?.git?.branch,
      updatedAt: rolloutUpdatedAt(path, first.payload?.timestamp),
      summary: firstUserMessageSummary(path)
    }
  } catch {
    const id = rolloutIdFromPath(path)
    return id
      ? { id, path, archived, updatedAt: rolloutUpdatedAt(path), summary: firstUserMessageSummary(path) }
      : null
  }
}

function rolloutUpdatedAt(path: string, timestamp?: string): number {
  const parsed = timestamp ? Date.parse(timestamp) : 0
  if (parsed) return parsed
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function firstUserMessageSummary(path: string): string | undefined {
  for (const raw of readJsonLines(path)) {
    const item = raw as {
      type?: string
      payload?: {
        type?: string
        message?: string
      }
    }
    const text =
      item.type === 'event_msg' && item.payload?.type === 'user_message'
        ? item.payload.message?.trim()
        : undefined
    const summary = cleanUserMessageSummary(text)
    if (summary) return summary
  }
  return undefined
}

function cleanUserMessageSummary(text: string | undefined): string | undefined {
  if (!text) return undefined
  if (text.startsWith('<agents-instructions>')) return undefined
  const withoutProjectContext = text.replace(/^Project context:[^\n]*(?:\r?\n){1,2}/, '').trim()
  if (!withoutProjectContext || withoutProjectContext.startsWith('<agents-instructions>')) return undefined
  return withoutProjectContext.replace(/\s+/g, ' ').slice(0, 120)
}

function rolloutIdFromPath(path: string): string | null {
  const match = basename(path).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)
  return match?.[1] ?? null
}

export function findCodexRollout(sessionId: string): CodexRolloutMeta | null {
  if (rolloutCache.has(sessionId)) return rolloutCache.get(sessionId) ?? null
  const roots = [
    { path: join(codexHome(), 'sessions'), archived: false },
    { path: join(codexHome(), 'archived_sessions'), archived: true }
  ]
  for (const root of roots) {
    for (const path of walkRollouts(root.path)) {
      if (!basename(path).includes(sessionId)) continue
      const meta = parseRolloutMeta(path, root.archived)
      if (meta) {
        rolloutCache.set(sessionId, meta)
        return meta
      }
    }
  }
  rolloutCache.set(sessionId, null)
  return null
}

function listCodexRollouts(): CodexRolloutMeta[] {
  const roots = [
    { path: join(codexHome(), 'sessions'), archived: false },
    { path: join(codexHome(), 'archived_sessions'), archived: true }
  ]
  return roots.flatMap((root) =>
    walkRollouts(root.path)
      .map((path) => parseRolloutMeta(path, root.archived))
      .filter((meta): meta is CodexRolloutMeta => !!meta)
  )
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return true
  return resolve(a).toLocaleLowerCase() === resolve(b).toLocaleLowerCase()
}

export function listCodexSessions(
  cwd: string,
  options: { limit: number; offset: number }
): SessionListItem[] {
  const index = new Map(readSessionIndex().map((entry) => [entry.id, entry]))
  const items = listCodexRollouts()
    .filter((rollout) => !rollout.archived && samePath(rollout.cwd, cwd))
    .map((rollout) => ({ entry: index.get(rollout.id), rollout }))
    .sort((a, b) => {
      const left = Date.parse(a.entry?.updated_at ?? '') || a.rollout.updatedAt || 0
      const right = Date.parse(b.entry?.updated_at ?? '') || b.rollout.updatedAt || 0
      return right - left
    })
    .slice(options.offset, options.offset + options.limit)

  return items.map(({ entry, rollout }) => ({
    sessionId: rollout.id,
    agentBackend: 'codex' as const,
    summary: entry?.thread_name || rollout.summary || 'Codex session',
    lastModified: Date.parse(entry?.updated_at ?? '') || rollout.updatedAt || 0,
    cwd: rollout?.cwd,
    gitBranch: rollout?.gitBranch,
    runtimeBackend: 'windows' as const
  }))
}

function userMessage(uuid: string, text: string): HistoryMessage {
  return {
    type: 'user',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: { content: text }
  }
}

function assistantText(uuid: string, text: string): HistoryMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: { content: [{ type: 'text', text }] }
  }
}

function assistantTool(uuid: string, toolUseId: string, command: string): HistoryMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_use', id: toolUseId, name: 'shell', input: { command } }]
    }
  }
}

function toolResult(uuid: string, toolUseId: string, content: string, isError: boolean): HistoryMessage {
  return {
    type: 'user',
    uuid,
    session_id: '',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }]
    }
  }
}

export function getCodexSessionMessages(sessionId: string): HistoryMessage[] {
  const rollout = findCodexRollout(sessionId)
  if (!rollout) return []
  const messages: HistoryMessage[] = []
  let index = 0
  for (const raw of readJsonLines(rollout.path)) {
    const item = raw as {
      type?: string
      payload?: {
        type?: string
        name?: string
        arguments?: string
        call_id?: string
        output?: string
        message?: string
        item?: {
          id?: string
          type?: string
          command?: string
          aggregated_output?: string
          exit_code?: number | null
        }
      }
    }
    const payload = item.payload
    if (!payload) continue
    if (item.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
      messages.push(userMessage(`codex-user-${index++}`, payload.message))
    } else if (item.type === 'event_msg' && payload.type === 'agent_message' && payload.message) {
      messages.push(assistantText(`codex-assistant-${index++}`, payload.message))
    } else if (item.type === 'response_item' && payload.type === 'function_call' && payload.call_id) {
      messages.push(
        assistantTool(
          `codex-tool-${index++}`,
          payload.call_id,
          payload.arguments || payload.name || 'tool call'
        )
      )
    } else if (item.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id) {
      messages.push(
        toolResult(`codex-tool-result-${index++}`, payload.call_id, payload.output ?? '', false)
      )
    } else if (item.type === 'event_msg' && payload.type === 'exec_command' && payload.item?.command) {
      const toolUseId = payload.item.id ?? `codex-tool-${index}`
      messages.push(assistantTool(`codex-tool-${index++}`, toolUseId, payload.item.command))
    } else if (
      item.type === 'event_msg' &&
      payload.type === 'exec_command_output' &&
      payload.item?.id
    ) {
      messages.push(
        toolResult(
          `codex-tool-result-${index++}`,
          payload.item.id,
          payload.item.aggregated_output ?? '',
          payload.item.exit_code !== 0
        )
      )
    }
  }
  return messages
}

export function renameCodexSession(sessionId: string, title: string): void {
  const path = sessionIndexPath()
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const next = lines.map((line) => {
    if (!line.trim()) return line
    try {
      const entry = JSON.parse(line) as CodexIndexEntry
      if (entry.id === sessionId) {
        entry.thread_name = title
        entry.updated_at = new Date().toISOString()
        return JSON.stringify(entry)
      }
    } catch {
      /* keep malformed lines */
    }
    return line
  })
  writeFileSync(path, next.join('\n'), 'utf8')
}

export function deleteCodexSession(sessionId: string): void {
  try {
    const resolved = resolveMacCodexCommand()
    const result = spawnSync(resolved.command, [...resolved.argsPrefix, 'archive', sessionId], {
      cwd: dirname(sessionIndexPath()),
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.error || result.status !== 0) {
      throw result.error ?? new Error(result.stderr || `codex archive exited ${result.status}`)
    }
    rolloutCache.delete(sessionId)
  } catch (error) {
    log('codex', `archive failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}
