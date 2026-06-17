import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

interface PersistedSettings {
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

function settingsPath(): string {
  return join(app.getPath('userData'), 'forge-settings.json')
}

function load(): PersistedSettings {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(settingsPath(), 'utf8')) as PersistedSettings
  } catch {
    cache = {}
  }
  return cache
}

function save(s: PersistedSettings): void {
  cache = s
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* best-effort persistence */
  }
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
