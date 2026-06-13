import type { PermissionRequestPayload } from '../shared/ipc'

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'denied'

export interface TextBlock {
  kind: 'text'
  text: string
}
export interface ThinkingBlock {
  kind: 'thinking'
  text: string
}
export interface ToolBlock {
  kind: 'tool'
  toolUseId: string
  name: string
  input: unknown
  status: ToolStatus
  result?: unknown
  resultIsError?: boolean
  elapsed?: number
  errorMessage?: string
  /** Accumulated raw JSON while a tool_use block streams in. */
  inputRaw?: string
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolBlock

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  parentToolUseId: string | null
}
export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  parentToolUseId: string | null
  error?: string
  /** True while this message is still streaming token-by-token. */
  streaming?: boolean
}
export type TranscriptItem = UserItem | AssistantItem

export interface SessionMeta {
  /** The bridge handle id — this is what every IPC call must target. */
  sessionId: string
  /** The SDK's own internal session id (for resume/listSessions later). */
  sdkSessionId?: string
  cwd: string
  model: string
  permissionMode: string
  tools: string[]
}

export interface SessionStatus {
  running: boolean
  costUsd?: number
  turns?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  stopReason?: string
  compacting?: boolean
  error?: string
}

export interface StartArgs {
  cwd: string
  apiKey?: string
  model?: string
}

export type { PermissionRequestPayload }
