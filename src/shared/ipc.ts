import type { SDKMessage, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export interface StartSessionOptions {
  cwd: string
  /** Optional API key override. If omitted, the SDK uses the logged-in profile / env. */
  apiKey?: string
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  /** Resume an existing session by id. */
  resume?: string
  /** Pre-generated bridge map key, so the renderer can send messages before the
   *  claude.exe subprocess finishes spawning. */
  bridgeSessionId?: string
}

export interface StartSessionResult {
  sessionId: string
}

/** main -> renderer: a streamed SDK message or a session-ended signal. */
export type AgentEvent =
  | { type: 'agent:message'; sessionId: string; message: SDKMessage }
  | { type: 'agent:ended'; sessionId: string; error?: string }

export interface PermissionRequestPayload {
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  decisionReason?: string
  agentID?: string
}

export interface PermissionResponsePayload {
  toolUseID: string
  behavior: 'allow' | 'deny'
  message?: string
}

export interface SessionListItem {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
}

/** A user/assistant message from a past session transcript (for the sidebar resume view). */
export interface HistoryMessage {
  type: 'user' | 'assistant'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
}

/** Surface exposed on window.api via the preload contextBridge. */
export interface ForgeApi {
  startSession(opts: StartSessionOptions): Promise<StartSessionResult>
  sendMessage(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  closeSession(sessionId: string): Promise<void>
  listSessions(cwd: string): Promise<SessionListItem[]>
  getSessionMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]>

  pickDirectory(): Promise<string | null>
  getApiKey(): Promise<string | null>
  setApiKey(key: string): Promise<void>

  respondPermission(resp: PermissionResponsePayload): Promise<void>

  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  onPermissionRequest(cb: (r: PermissionRequestPayload) => void): () => void
}

declare global {
  interface Window {
    api: ForgeApi
  }
}
