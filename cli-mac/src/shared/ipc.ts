import type { SDKMessage, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AgentBackendId, AgentBackendInfo } from './agentBackends'
export type { AgentBackendId, AgentBackendInfo } from './agentBackends'

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
  /** Which pluggable agent backend should own this session. */
  agentBackend?: AgentBackendId
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
  answers?: Record<string, unknown>
}

export interface SessionListItem {
  sessionId: string
  agentBackend?: AgentBackendId
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
  runtimeBackend?: ClaudeExecutionBackend
}

export interface SessionListOptions {
  limit?: number
  offset?: number
  backend?: ClaudeExecutionBackend | 'all'
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
  agentBackend?: AgentBackendId
  author?: string
  category?: string
  homepage?: string
  sourceUrl?: string
  installed?: boolean
  enabled?: boolean
  /** Marketplace this came from (e.g. "claude-plugins-official"). */
  marketplace: string
}

export interface PickedDirectoryEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number
  modifiedAt: number
}

/** A file the user picked to attach. Images carry base64 data; text files
 *  carry their (size-capped) content; directories carry a shallow entry list;
 *  others carry just the path reference. */
export interface PickedFile {
  path: string
  name: string
  kind: 'image' | 'text' | 'other' | 'directory'
  mimeType: string
  /** image: base64 (no data: prefix); text: utf-8 content; other/directory: '' */
  data: string
  size: number
  entries?: PickedDirectoryEntry[]
  entriesTruncated?: boolean
}

/** A model shown in the Composer dropdown (user-editable in Settings). */
export interface ComposerModel {
  id: string
  label: string
}

export type ClaudeExecutionBackend = 'windows' | 'wsl'
export type ProviderBackend = ClaudeExecutionBackend | 'hermes'

export interface PickDirectoryOptions {
  backend?: ClaudeExecutionBackend
}

/** Misc app preferences managed by the Settings panel. */
export interface Preferences {
  /** Which pluggable agent engine Forge should use. */
  agentBackend?: AgentBackendId
  /** Default effort for new sessions (AgentBridge fallback). */
  defaultEffort?: EffortLevel
  /** Default permission mode for new sessions. */
  defaultPermissionMode?: PermissionMode
  /** Which Claude runtime/history backend Forge should use. */
  claudeExecutionBackend?: ClaudeExecutionBackend
  /** Whether WSL-specific UI and backend capabilities are exposed. */
  wslSupportEnabled?: boolean
  /** Models shown in the Composer dropdown; empty/undefined = built-in list. */
  composerModels?: ComposerModel[]
  /** Models shown when the Codex agent backend is active. */
  codexComposerModels?: ComposerModel[]
  /** Models shown when the Hermes agent backend is active. */
  hermesComposerModels?: ComposerModel[]
  /** Experimental: route Chromium's compositing through the ANGLE Vulkan
   *  backend on Windows (default D3D11). Off by default; requires restart and
   *  is higher-variance across GPU drivers. */
  vulkanBackend?: boolean
  /** Close window → hide to system tray instead of quitting. Persisted after
   *  the user picks once on first close; editable in Settings afterwards. */
  minimizeToTray?: boolean
  /** Show OS native notifications when a session ends while the window is
   *  inactive (default true). */
  nativeNotifications?: boolean
  /** When false, Forge re-shows the close prompt (minimize vs. quit) on every
   *  window close. Default false = always ask until the user picks. */
  closePromptDismissed?: boolean
}

export interface ProviderProfile {
  backend: ProviderBackend
  providers: Provider[]
  activeProviderId: string | null
  composerModels?: ComposerModel[]
}

export interface ProviderProfiles {
  activeBackend: ProviderBackend
  profiles: ProviderProfile[]
}

export interface RuntimeStatus {
  agentBackend: AgentBackendId
  agentName: string
  agentVersion?: string
  agentPath?: string
  backend: ClaudeExecutionBackend
  provider: Provider | null
  model: string
  claudeCodeVersion?: string
  claudeCodePath?: string
  versionError?: string
  wslDistro?: string
  checkedAt: number
}

export interface RuntimeStatusOptions {
  refreshProbe?: boolean
}

export interface UpdateAssetInfo {
  name: string
  size?: number
  browserDownloadUrl: string
}

export interface UpdateCheckResult {
  checkedAt: number
  currentVersion: string
  latestVersion?: string
  updateAvailable: boolean
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  body?: string
  asset?: UpdateAssetInfo
  error?: string
}

export interface UpdateDownloadOptions {
  assetUrl?: string
  directory?: string
  requestId?: string
  openWhenDone?: boolean
}

export interface UpdateDownloadProgress {
  requestId?: string
  fileName: string
  path: string
  receivedBytes: number
  totalBytes?: number
  percent?: number
  bytesPerSecond: number
  elapsedMs: number
  done?: boolean
}

export interface UpdateInstallResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface DiagnosticReportOptions {
  cwd?: string
  appearance?: Record<string, unknown>
}

export interface DiagnosticReportResult {
  canceled?: boolean
  path?: string
}

export type HealthCheckState = 'pass' | 'warn' | 'fail'

export interface HealthCheckItem {
  id: string
  label: string
  state: HealthCheckState
  detail: string
  fixable?: boolean
}

export interface WslHealthReport {
  checkedAt: number
  cwd: string
  cwdWsl?: string
  defaultDistro?: string
  checks: HealthCheckItem[]
  diagnostics: string
}

export interface SettingsBackup {
  version: 1
  exportedAt: string
  settings: Record<string, unknown>
  appearance?: Record<string, unknown>
}

/** Which engine translateTexts() routes to. 'llm' = active provider's
 *  /v1/messages; 'baidu' = Baidu generic-translate API (avoids model rate limits). */
export type TranslateEngine = 'llm' | 'baidu'

/** Baidu translate credentials. appId is non-secret; secretKey is the API key
 *  (encrypted at rest via safeStorage, returned plaintext to the renderer for
 *  editing — same stance as provider tokens). */
export interface BaiduTranslateConfig {
  appId: string
  secretKey: string
}

export interface TranslateConfig {
  engine: TranslateEngine
  baidu: BaiduTranslateConfig
}

/** Result of a translate-connection test (Baidu credentials check). */
export interface TranslateTestResult {
  ok: boolean
  /** The translated sample text on success. */
  translated?: string
  /** Human-readable failure reason on error. */
  error?: string
}

/** A user/assistant message from a past session transcript (for the sidebar resume view). */
export interface HistoryMessage {
  type: 'user' | 'assistant'
  uuid: string
  session_id: string
  message: unknown
  parent_tool_use_id: string | null
}

/** --- Git integration types --- */
export interface GitBranchInfo {
  name: string
  current: boolean
}

export interface GitCommit {
  hash: string
  shortHash: string
  message: string
  author: string
  date: number // ms since epoch
}

export interface GitStatus {
  staged: string[]
  unstaged: string[]
  untracked: string[]
  /** Files in a merge/rebase conflict (UU/AA/DD/…). */
  conflicts: string[]
  clean: boolean
  /** Commits local has that upstream doesn't; null when there is no upstream. */
  ahead: number | null
  /** Commits upstream has that local doesn't; null when there is no upstream. */
  behind: number | null
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
  listSessions(cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]>
  getSessionMessages(
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<HistoryMessage[]>
  /** Rename a past session (appends a custom title). */
  renameSession(
    sessionId: string,
    title: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<void>
  /** Delete a session's transcript file. */
  deleteSession(sessionId: string, cwd: string, backend?: ClaudeExecutionBackend): Promise<void>
  /** Read a subagent's own conversation transcript (for the monitor popover). */
  getSubagentMessages(sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]>

  /** List every MCP server the active session knows about (settings-file +
   *  dynamically added), with live connection status. Requires an active session. */
  listMcpServers(sessionId: string): Promise<McpServerEntry[]>
  /** Reload the backend's MCP configuration/status cache when supported, then return the list. */
  refreshMcpServers(sessionId: string): Promise<McpServerEntry[]>
  /** Enable/disable an MCP server by name. Persists to settings (same as `claude mcp`). */
  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void>

  /** Move a running foreground subagent/Bash (by its tool_use_id) to the
   *  background, freeing the main agent's turn. Omit id = background all. */
  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean>

  /** --- Attachments & file links --- */
  /** Open a file picker rooted at cwd, read the chosen files, and return them
   *  (images as base64, text files as content) for attaching to a message. */
  pickFiles(cwd: string): Promise<PickedFile[]>
  /** Read files that were dropped into the renderer. */
  readFiles(cwd: string, paths: string[]): Promise<PickedFile[]>
  /** Resolve an Electron-backed DOM File to its native filesystem path. */
  getPathForFile(file: File): string
  /** Reveal a file (path resolved against cwd) in the OS file manager. */
  revealInExplorer(cwd: string, pathStr: string): Promise<boolean>

  /** Persist a server to a config file (user/project/local scope). Does NOT touch
   *  the live session — the caller restarts the session to apply. */
  saveMcpServer(args: SaveMcpServerArgs): Promise<void>
  /** Remove a server from its config file. */
  deleteMcpServer(args: DeleteMcpServerArgs): Promise<void>

  /** --- Providers (multi-operator API switching for the current Claude backend) --- */
  listProviders(): Promise<Provider[]>
  getActiveProvider(): Promise<Provider | null>
  getProviderProfiles(): Promise<ProviderProfiles>
  /** Create or update a provider (upsert by id). Returns the updated list. */
  saveProvider(provider: Provider): Promise<Provider[]>
  saveProviderForBackend(backend: ProviderBackend, provider: Provider): Promise<ProviderProfile>
  /** Remove a provider by id. Returns the updated list. */
  deleteProvider(id: string): Promise<Provider[]>
  deleteProviderForBackend(backend: ProviderBackend, id: string): Promise<ProviderProfile>
  /** Make a provider active: writes its params into the current backend's
   *  Claude settings.json + sets that backend's active provider id. Caller
   *  restarts the session to apply. */
  setActiveProvider(id: string): Promise<void>
  setActiveProviderForBackend(backend: ProviderBackend, id: string): Promise<ProviderProfile>
  saveComposerModelsForBackend(
    backend: ProviderBackend,
    models: ComposerModel[]
  ): Promise<ProviderProfile>

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
  /** Browse plugin marketplace catalogs for the selected agent backend (read-only). */
  listMarketplacePlugins(agentBackend?: AgentBackendId, cwd?: string): Promise<MarketplacePlugin[]>

  /** Batch-translate texts EN→ZH via the active provider's /v1/messages. Returns
   *  one translation per input (empty string for any that failed). */
  translateTexts(texts: string[]): Promise<string[]>

  /** --- Translate engine config (Translate panel) --- */
  /** Read the current translation engine + Baidu credentials. */
  getTranslateConfig(): Promise<TranslateConfig>
  /** Persist the engine choice + Baidu credentials (secretKey encrypted at rest). */
  saveTranslateConfig(cfg: TranslateConfig): Promise<TranslateConfig>
  /** Test Baidu credentials by translating a sample — does not persist. */
  testTranslate(appId: string, secretKey: string): Promise<TranslateTestResult>

  /** --- Preferences (Settings panel) --- */
  listAgentBackends(): Promise<AgentBackendInfo[]>
  listAgentModels(): Promise<ComposerModel[]>
  getPreferences(): Promise<Preferences>
  savePreferences(prefs: Preferences): Promise<Preferences>
  getRuntimeStatus(cwd?: string, model?: string, options?: RuntimeStatusOptions): Promise<RuntimeStatus>
  runWslHealthCheck(cwd: string): Promise<WslHealthReport>
  repairWslEnvironment(cwd: string): Promise<WslHealthReport>
  getDiagnosticLog(): Promise<string>
  checkForUpdates(): Promise<UpdateCheckResult>
  downloadAndInstallUpdate(options?: UpdateDownloadOptions): Promise<UpdateInstallResult>
  exportDiagnosticReport(options?: DiagnosticReportOptions): Promise<DiagnosticReportResult>
  exportSettings(appearance?: Record<string, unknown>): Promise<SettingsBackup>
  importSettings(backup: SettingsBackup): Promise<void>

  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<void>
  closeWindow(): Promise<void>

  /** --- System tray & native notifications --- */
  /** User's answer to the first-close prompt. `minimize` = hide to tray,
   *  `remember` = persist the choice so the prompt never shows again. */
  resolveClose(decision: { minimize: boolean; remember: boolean }): Promise<void>
  /** Restore and focus the main window (e.g. from tray or a notification click). */
  showWindow(): Promise<void>
  /** Subscribe to the first-close prompt request (main → renderer). */
  onClosePrompt(cb: () => void): () => void
  onUpdateAvailable(cb: (info: UpdateCheckResult) => void): () => void
  onUpdateDownloadProgress(cb: (progress: UpdateDownloadProgress) => void): () => void
  onProvidersChanged(cb: () => void): () => void

  pickDirectory(options?: PickDirectoryOptions): Promise<string | null>
  getApiKey(): Promise<string | null>
  setApiKey(key: string): Promise<void>

  respondPermission(resp: PermissionResponsePayload): Promise<void>

  /** --- Git integration --- */
  isGitRepo(cwd: string): Promise<boolean>
  gitGetCurrentBranch(cwd: string): Promise<string | null>
  gitListBranches(cwd: string): Promise<GitBranchInfo[]>
  gitCheckoutBranch(cwd: string, branch: string): Promise<void>
  gitCreateBranch(cwd: string, name: string): Promise<void>
  gitDeleteBranch(cwd: string, name: string, force?: boolean): Promise<void>
  gitPull(cwd: string): Promise<{ stdout: string; stderr: string }>
  gitPush(cwd: string): Promise<{ stdout: string; stderr: string }>
  gitStatus(cwd: string): Promise<GitStatus>
  gitAdd(cwd: string, paths?: string[]): Promise<void>
  gitCommit(cwd: string, message: string): Promise<void>
  gitLog(cwd: string, limit?: number): Promise<GitCommit[]>
  gitStash(cwd: string, action?: string, message?: string): Promise<string>
  gitRevert(cwd: string, commitHash: string): Promise<void>
  /** Unified diff text. staged=true → already-staged changes; paths → limit to files. */
  gitDiff(cwd: string, opts?: { staged?: boolean; paths?: string[] }): Promise<string>
  /** git fetch (update remote-tracking refs, no merge). */
  gitFetch(cwd: string): Promise<{ stdout: string; stderr: string }>
  /** Unstage paths (omit for all). */
  gitReset(cwd: string, paths?: string[]): Promise<void>
  /** Push current branch and set upstream (git push -u origin HEAD). */
  gitPushUpstream(cwd: string): Promise<{ stdout: string; stderr: string }>

  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  onPermissionRequest(cb: (r: PermissionRequestPayload) => void): () => void
}

declare global {
  interface Window {
    api: ForgeApi
  }
}
