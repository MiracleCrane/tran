import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Provider,
  Project,
  EffortLevel,
  PermissionMode,
  ComposerModel,
  ClaudeExecutionBackend,
  AgentBackendId,
  TranslateEngine
} from '../shared/ipc'
import { AGENT_BACKEND_IDS } from '../shared/agentBackends'

const SETTINGS_SCHEMA_VERSION = 1
const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto'
])
const CLAUDE_BACKENDS = new Set<ClaudeExecutionBackend>(['windows', 'wsl'])
const TRANSLATE_ENGINES = new Set<TranslateEngine>(['llm', 'baidu'])

interface PersistedSettings {
  /** Settings schema version for migrations/normalization. */
  schemaVersion?: number
  /** base64 of safeStorage-encrypted bytes */
  apiKeyEnc?: string
  /** plaintext fallback when safeStorage is unavailable */
  apiKeyPlain?: string
  /** Saved API providers (client-side only). The active one is applied at spawn. */
  providers?: Provider[]
  /** id of the active provider; null/undefined = none active. */
  activeProviderId?: string | null
  /** Saved API providers used when the Claude runtime backend is WSL. */
  wslProviders?: Provider[]
  /** id of the active WSL provider; null/undefined = none active. */
  wslActiveProviderId?: string | null
  /** Saved working directories shown in the sidebar project switcher. */
  projects?: Project[]
  /** Last-used project path (auto-entered on app start). */
  lastProjectPath?: string
  /** Preferences managed by the Settings panel. */
  agentBackend?: AgentBackendId
  defaultEffort?: EffortLevel
  defaultPermissionMode?: PermissionMode
  /** Gate for all WSL-facing UI and WSL backend features. */
  wslSupportEnabled?: boolean
  claudeExecutionBackend?: ClaudeExecutionBackend
  /** Composer model list used by the Windows Claude backend. */
  composerModels?: ComposerModel[]
  /** Composer model list used by the WSL Claude backend. */
  wslComposerModels?: ComposerModel[]
  /** Composer model list used by the Codex app-server backend. */
  codexComposerModels?: ComposerModel[]
  /** Composer model list used by the Hermes ACP backend. */
  hermesComposerModels?: ComposerModel[]
  /** Experimental Windows-only GPU toggle (ANGLE Vulkan backend). */
  vulkanBackend?: boolean
  /** Close window → hide to system tray instead of quitting (persisted after
   *  the user picks once on first close). */
  minimizeToTray?: boolean
  /** User has already answered the first-close prompt (don't ask again). */
  closePromptDismissed?: boolean
  /** Show OS native notifications when a session ends while window is inactive
   *  (default true). */
  nativeNotifications?: boolean
  /** --- Translate engine config (Translate panel) --- */
  /** Which engine translateTexts() routes to. */
  translateEngine?: TranslateEngine
  /** Baidu app id (non-secret). */
  baiduAppId?: string
  /** base64 of safeStorage-encrypted Baidu secret key. */
  baiduSecretEnc?: string
  /** plaintext fallback when safeStorage is unavailable. */
  baiduSecretPlain?: string
}

let cache: PersistedSettings | null = null
let cacheMtimeMs: number | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'forge-settings.json')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeProvider(value: unknown): Provider | null {
  const provider = asRecord(value)
  if (!provider) return null
  const id = optionalString(provider.id)?.trim()
  if (!id) return null
  const authType = provider.authType === 'apikey' ? 'apikey' : 'bearer'
  return {
    id,
    name: optionalString(provider.name) ?? '',
    baseUrl: optionalString(provider.baseUrl) ?? 'https://api.anthropic.com',
    token: optionalString(provider.token) ?? '',
    authType,
    model: optionalString(provider.model) ?? 'claude-opus-4-8'
  }
}

function normalizeProviders(value: unknown): Provider[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const providers: Provider[] = []
  for (const item of value) {
    const provider = normalizeProvider(item)
    if (!provider || seen.has(provider.id)) continue
    seen.add(provider.id)
    providers.push(provider)
  }
  return providers
}

function normalizeActiveProviderId(value: unknown, providers?: Provider[]): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  if (!providers || providers.some((provider) => provider.id === value)) return value
  return providers[0]?.id ?? null
}

function normalizeProject(value: unknown): Project | null {
  const project = asRecord(value)
  if (!project) return null
  const path = optionalString(project.path)?.trim()
  if (!path) return null
  return {
    path,
    name: optionalString(project.name) ?? path,
    addedAt: typeof project.addedAt === 'number' && Number.isFinite(project.addedAt)
      ? project.addedAt
      : Date.now()
  }
}

function normalizeProjects(value: unknown): Project[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const item of value) {
    const project = normalizeProject(item)
    if (!project || seen.has(project.path)) continue
    seen.add(project.path)
    projects.push(project)
  }
  return projects
}

function normalizeComposerModel(value: unknown): ComposerModel | null {
  const model = asRecord(value)
  if (!model) return null
  const id = optionalString(model.id)?.trim()
  if (!id) return null
  return {
    id,
    label: optionalString(model.label)?.trim() || id
  }
}

function normalizeComposerModels(value: unknown): ComposerModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const models: ComposerModel[] = []
  for (const item of value) {
    const model = normalizeComposerModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

function normalizeSettings(raw: unknown): PersistedSettings {
  const source = asRecord(raw) ?? {}
  const settings: PersistedSettings = {
    ...(source as PersistedSettings),
    schemaVersion: SETTINGS_SCHEMA_VERSION
  }

  settings.apiKeyEnc = optionalString(source.apiKeyEnc)
  settings.apiKeyPlain = optionalString(source.apiKeyPlain)
  settings.baiduAppId = optionalString(source.baiduAppId)
  settings.baiduSecretEnc = optionalString(source.baiduSecretEnc)
  settings.baiduSecretPlain = optionalString(source.baiduSecretPlain)
  settings.lastProjectPath = optionalString(source.lastProjectPath)

  settings.providers = normalizeProviders(source.providers)
  settings.activeProviderId = normalizeActiveProviderId(source.activeProviderId, settings.providers)
  settings.wslProviders = normalizeProviders(source.wslProviders)
  settings.wslActiveProviderId = normalizeActiveProviderId(source.wslActiveProviderId, settings.wslProviders)
  settings.projects = normalizeProjects(source.projects)

  settings.agentBackend = AGENT_BACKEND_IDS.includes(source.agentBackend as AgentBackendId)
    ? source.agentBackend as AgentBackendId
    : undefined
  settings.defaultEffort = EFFORT_LEVELS.has(source.defaultEffort as EffortLevel)
    ? source.defaultEffort as EffortLevel
    : undefined
  settings.defaultPermissionMode = PERMISSION_MODES.has(source.defaultPermissionMode as PermissionMode)
    ? source.defaultPermissionMode as PermissionMode
    : undefined
  settings.claudeExecutionBackend = CLAUDE_BACKENDS.has(source.claudeExecutionBackend as ClaudeExecutionBackend)
    ? source.claudeExecutionBackend as ClaudeExecutionBackend
    : undefined
  settings.translateEngine = TRANSLATE_ENGINES.has(source.translateEngine as TranslateEngine)
    ? source.translateEngine as TranslateEngine
    : undefined

  settings.wslSupportEnabled = optionalBoolean(source.wslSupportEnabled)
  settings.vulkanBackend = optionalBoolean(source.vulkanBackend)
  settings.minimizeToTray = optionalBoolean(source.minimizeToTray)
  settings.closePromptDismissed = optionalBoolean(source.closePromptDismissed)
  settings.nativeNotifications = optionalBoolean(source.nativeNotifications)

  settings.composerModels = normalizeComposerModels(source.composerModels)
  settings.wslComposerModels = normalizeComposerModels(source.wslComposerModels)
  settings.codexComposerModels = normalizeComposerModels(source.codexComposerModels)
  settings.hermesComposerModels = normalizeComposerModels(source.hermesComposerModels)

  return settings
}

function settingsChanged(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) !== JSON.stringify(b)
  } catch {
    return true
  }
}

function writeSettingsFile(path: string, settings: PersistedSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
}

function load(): PersistedSettings {
  const path = settingsPath()
  const mtimeMs = readMtimeMs(path)
  if (cache && cacheMtimeMs === mtimeMs) return cache
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    cache = normalizeSettings(raw)
    if (settingsChanged(raw, cache)) {
      writeSettingsFile(path, cache)
    }
    cacheMtimeMs = readMtimeMs(path)
  } catch {
    cache = normalizeSettings({})
    cacheMtimeMs = mtimeMs
  }
  return cache
}

function save(s: PersistedSettings): void {
  cache = normalizeSettings(s)
  const path = settingsPath()
  try {
    writeSettingsFile(path, cache)
    cacheMtimeMs = readMtimeMs(path)
  } catch {
    /* best-effort persistence */
  }
}

export function getSettingsFilePath(): string {
  return settingsPath()
}

/** Read the full persisted settings (cached). Used by providers.ts. */
export function loadSettings(): PersistedSettings {
  return load()
}

/** Write the full persisted settings (updates the cache). Used by providers.ts. */
export function saveSettings(s: PersistedSettings): void {
  save(s)
}

export function getSettingsSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(load())) as Record<string, unknown>
}

export function replaceSettingsSnapshot(snapshot: Record<string, unknown>): void {
  save({ ...snapshot } as PersistedSettings)
}

export function getApiKey(): string | null {
  const s = load()
  if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.apiKeyPlain ?? null
}

export function setApiKey(key: string | null): void {
  const s = load()
  if (key && safeStorage.isEncryptionAvailable()) {
    s.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
    delete s.apiKeyPlain
  } else if (key) {
    s.apiKeyPlain = key
    delete s.apiKeyEnc
  } else {
    delete s.apiKeyEnc
    delete s.apiKeyPlain
  }
  save(s)
}

/** Read the saved Baidu translate secret key (decrypted). Mirrors getApiKey. */
export function getBaiduSecret(): string | null {
  const s = load()
  if (s.baiduSecretEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.baiduSecretEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.baiduSecretPlain ?? null
}

/** Persist the Baidu translate secret key (encrypted when safeStorage is up).
 *  Pass null/empty to clear. Mirrors setApiKey. */
export function setBaiduSecret(key: string | null): void {
  const s = load()
  if (key && safeStorage.isEncryptionAvailable()) {
    s.baiduSecretEnc = safeStorage.encryptString(key).toString('base64')
    delete s.baiduSecretPlain
  } else if (key) {
    s.baiduSecretPlain = key
    delete s.baiduSecretEnc
  } else {
    delete s.baiduSecretEnc
    delete s.baiduSecretPlain
  }
  save(s)
}
