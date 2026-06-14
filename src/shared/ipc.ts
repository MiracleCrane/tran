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

/** Connection state of an MCP server, as reported by the Claude Agent SDK. */
export type McpServerStatusKind = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

/** A renderer-facing view of one MCP server. Mirrors the SDK's McpServerStatus,
 *  trimmed to the serializable fields the panel needs. */
export interface McpServerEntry {
  name: string
  status: McpServerStatusKind
  /** Where it was configured: project (.mcp.json), user, local, … */
  scope?: string
  /** Reported by the server once connected. */
  serverInfo?: { name: string; version: string }
  error?: string
  tools?: { name: string; description?: string }[]
  config?: {
    type: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
    headers?: Record<string, string>
    /** Advanced/extra keys the form doesn't surface (timeout, alwaysLoad, …),
     *  carried through so the raw-JSON view/edit is faithful. */
    [key: string]: unknown
  }
}

/** Config-file scope for persisting an MCP server (matches `claude mcp -s`). */
export type McpScope = 'user' | 'project' | 'local'

/** Serializable MCP server config as written to the config files. */
export type McpServerConfigInput =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }

export interface SaveMcpServerArgs {
  cwd: string
  scope: McpScope
  name: string
  config: McpServerConfigInput
}

export interface DeleteMcpServerArgs {
  cwd: string
  scope: McpScope
  name: string
}

/** How a provider's token is sent to the API. */
export type ProviderAuthType = 'bearer' | 'apikey'

/** A saved API provider. The active one is applied at every claude.exe spawn
 *  (env injection) and also written into Claude's native settings.json on switch. */
export interface Provider {
  id: string
  /** Display label, e.g. "智谱代理" / "Anthropic 官方". */
  name: string
  /** ANTHROPIC_BASE_URL. */
  baseUrl: string
  /** Auth credential (PROXY_MANAGED / sk-ant-… / custom). */
  token: string
  /** bearer → ANTHROPIC_AUTH_TOKEN (Authorization: Bearer); apikey → ANTHROPIC_API_KEY (x-api-key). */
  authType: ProviderAuthType
  /** Default model passed to the session (options.model). */
  model: string
}

/** A saved working directory ("project"). The sidebar's top switcher lists these;
 *  each has its own session history (scoped by cwd). */
export interface Project {
  /** Absolute path — also the unique key. */
  path: string
  /** Display name (folder name by default, user-renameable). */
  name: string
  addedAt: number
}

/** A skill available to the session (returned by the SDK's supportedCommands(),
 *  which lists skills as slash commands). */
export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

/** A plugin/skill entry from a local marketplace catalog (browse-only). */
export interface MarketplacePlugin {
  name: string
  description: string
  author?: string
  category?: string
  homepage?: string
  sourceUrl?: string
  /** Marketplace this came from (e.g. "claude-plugins-official"). */
  marketplace: string
}

/** A file the user picked to attach. Images carry base64 data; text files
 *  carry their (size-capped) content; others carry just the path reference. */
export interface PickedFile {
  path: string
  name: string
  kind: 'image' | 'text' | 'other'
  mimeType: string
  /** image: base64 (no data: prefix); text: utf-8 content; other: '' */
  data: string
  size: number
}

/** A model shown in the Composer dropdown (user-editable in Settings). */
export interface ComposerModel {
  id: string
  label: string
}

/** Misc app preferences managed by the Settings panel. */
export interface Preferences {
  /** Default effort for new sessions (AgentBridge fallback). */
  defaultEffort?: EffortLevel
  /** Default permission mode for new sessions. */
  defaultPermissionMode?: PermissionMode
  /** Models shown in the Composer dropdown; empty/undefined = built-in list. */
  composerModels?: ComposerModel[]
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
  /** Send a user message. `content` is either a text string or an array of
   *  content blocks (text + image) when attachments are present. */
  sendMessage(sessionId: string, content: string | unknown[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void>
  closeSession(sessionId: string): Promise<void>
  listSessions(cwd: string): Promise<SessionListItem[]>
  getSessionMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]>
  /** Rename a past session (appends a custom title). */
  renameSession(sessionId: string, title: string, cwd: string): Promise<void>
  /** Delete a session's transcript file. */
  deleteSession(sessionId: string, cwd: string): Promise<void>
  /** Read a subagent's own conversation transcript (for the monitor popover). */
  getSubagentMessages(sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]>

  /** List every MCP server the active session knows about (settings-file +
   *  dynamically added), with live connection status. Requires an active session. */
  listMcpServers(sessionId: string): Promise<McpServerEntry[]>
  /** Enable/disable an MCP server by name. Persists to settings (same as `claude mcp`). */
  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void>

  /** Move a running foreground subagent/Bash (by its tool_use_id) to the
   *  background, freeing the main agent's turn. Omit id = background all. */
  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean>

  /** --- Attachments & file links --- */
  /** Open a file picker rooted at cwd, read the chosen files, and return them
   *  (images as base64, text files as content) for attaching to a message. */
  pickFiles(cwd: string): Promise<PickedFile[]>
  /** Reveal a file (path resolved against cwd) in the OS file manager. */
  revealInExplorer(cwd: string, pathStr: string): Promise<boolean>

  /** Persist a server to a config file (user/project/local scope). Does NOT touch
   *  the live session — the caller restarts the session to apply. */
  saveMcpServer(args: SaveMcpServerArgs): Promise<void>
  /** Remove a server from its config file. */
  deleteMcpServer(args: DeleteMcpServerArgs): Promise<void>

  /** --- Providers (multi-operator API switching) --- */
  listProviders(): Promise<Provider[]>
  getActiveProvider(): Promise<Provider | null>
  /** Create or update a provider (upsert by id). Returns the updated list. */
  saveProvider(provider: Provider): Promise<Provider[]>
  /** Remove a provider by id. Returns the updated list. */
  deleteProvider(id: string): Promise<Provider[]>
  /** Make a provider active: writes its params into Claude's settings.json + sets
   *  activeProviderId. Caller restarts the session to apply. */
  setActiveProvider(id: string): Promise<void>

  /** --- Projects (saved working directories) --- */
  listProjects(): Promise<Project[]>
  /** Add a directory (idempotent) and mark it last-used. Returns the list. */
  addProject(path: string, name?: string): Promise<Project[]>
  removeProject(path: string): Promise<Project[]>
  renameProject(path: string, name: string): Promise<Project[]>
  setLastProject(path: string): Promise<void>
  /** The project to auto-enter on app start (last-used, else first, else null). */
  getStartupProject(): Promise<Project | null>

  /** --- Skills --- */
  /** Skills available to the active session (via supportedCommands). */
  listSkills(sessionId: string): Promise<SkillInfo[]>
  /** Browse the local plugin marketplace catalogs (read-only). */
  listMarketplacePlugins(): Promise<MarketplacePlugin[]>

  /** Batch-translate texts EN→ZH via the active provider's /v1/messages. Returns
   *  one translation per input (empty string for any that failed). */
  translateTexts(texts: string[]): Promise<string[]>

  /** --- Preferences (Settings panel) --- */
  getPreferences(): Promise<Preferences>
  savePreferences(prefs: Preferences): Promise<Preferences>

  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>

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
