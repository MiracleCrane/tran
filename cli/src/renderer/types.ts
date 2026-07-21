import type { AgentBackendId, PickedDirectoryEntry, PermissionRequestPayload } from '../shared/ipc'

export type ToolStatus = 'pending' | 'running' | 'done' | 'error' | 'denied' | 'stopped'

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
  /** 创建/终态时间戳（任务面板耗时用；历史重放 items 无 ts，诚实缺省）。 */
  startedAt?: number
  endedAt?: number
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolBlock

/** Display info for an attachment on a user message (icon+name chip, or image
 *  preview). */
export interface UserAttachment {
  name: string
  kind: 'image' | 'text' | 'other' | 'directory'
  path?: string
  mimeType?: string
  size?: number
  /** For images: a data: URL to render the preview. */
  dataUrl?: string
  /** For text files: the inlined file contents read by the main process. */
  text?: string
  /** For directories: a shallow file list read by the main process. */
  entries?: PickedDirectoryEntry[]
  entriesTruncated?: boolean
  previewState?: 'loading' | 'error'
  previewError?: string
}

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  parentToolUseId: string | null
  attachments?: UserAttachment[]
  /** 该条发送时注入了 Swarm 指令前缀（气泡上显示小徽章）。 */
  swarm?: boolean
  /** Ctrl+S 打断并发送（插队）：中断当前轮后立即发送，气泡上显示小徽章。 */
  cutIn?: boolean
  /** 来自 session/load 重放的历史消息（分界线上方内容）。 */
  isHistory?: boolean
}

/** A message sent while the agent was busy — held above the Composer until the
 *  current turn finishes, then dropped into the transcript. */
export interface PendingMessage {
  id: string
  text: string
  attachments?: UserAttachment[]
  /** 见 UserItem.swarm。 */
  swarm?: boolean
  /** 见 UserItem.cutIn。 */
  cutIn?: boolean
}
export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  parentToolUseId: string | null
  error?: string
  /** True while this message is still streaming token-by-token. */
  streaming?: boolean
  /** 来自 session/load 重放的历史消息（分界线上方内容）。 */
  isHistory?: boolean
}
export type TranscriptItem = UserItem | AssistantItem | CompactionItem

/** 上下文压缩分界线（/compact 或自动压缩；system/compaction → TranscriptItem）。 */
export interface CompactionItem {
  id: string
  kind: 'compaction'
  parentToolUseId: string | null
  messagesCompacted?: number
  tokensBefore?: number
  tokensAfter?: number
  at: number
  /** 见 UserItem.isHistory（历史重放里不会出现，占位兼容）。 */
  isHistory?: boolean
}

/** ACP session/update 'plan' 的待办条目（kimi 全量推送，整体替换）。 */
export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: string
  activeForm?: string
}

/** AskUserQuestion（elicitation）：区别于工具审批的提问卡片。
 *  options 原样来自 ACP；回答时原样回传 optionId。 */
export interface ElicitationRequest {
  toolUseID: string
  question: string
  options: Array<{ optionId: string; name: string; kind?: string }>
  /** 多选题（toolCall 里解析到 multiSelect）；缺省按单选（radio 式）。 */
  multiSelect?: boolean
}

/** 隐藏 /usage 轮解析出的上下文用量（system/context_usage）。 */
export interface ContextUsage {
  usedText: string
  /** usedText 的数值形式（两位小数百分比 = used/total 自算）。 */
  used: number
  total: number
  pct: number
  /** /usage 的 Total 行：会话累计 token（可选）。 */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** 渲染层接收时间（悬停刷新判断 >30s 陈旧用）。 */
  at?: number
}

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
  /** Pluggable agent engine that owns this bridge session. */
  agentBackend?: AgentBackendId
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
