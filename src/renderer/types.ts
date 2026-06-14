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

/** A transcript item plus its nested children (the subagent conversation under
 *  each of its tool_use blocks, linked by parent_tool_use_id). The Transcript
 *  builds a forest of these from the flat `items` list and renders recursively. */
export interface ItemNode {
  item: TranscriptItem
  /** toolUseId → child nodes (only assistant items with tool blocks use this). */
  childrenByTool: Map<string, ItemNode[]>
}

/** A Task-tool subagent, tracked from SDK task_* system messages and surfaced
 *  in the StatusBar subagent monitor (kept out of the main transcript). */
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped'

export interface SubagentTask {
  taskId: string
  description: string
  subagentType?: string
  status: SubagentStatus
  toolUseId?: string
  /** Latest progress snapshot from task_progress/task_notification. */
  tokens?: number
  toolUses?: number
  durationMs?: number
  lastToolName?: string
  summary?: string
  error?: string
  /** True once moved to the background (task_updated.is_backgrounded) — main
   *  agent is then free to continue while it keeps running. */
  isBackgrounded?: boolean
}

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
