import { readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getSettingsFilePath, loadSettings, saveSettings } from './settings'
import {
  composerModelsForBackend,
  currentAgentBackend,
  currentBackend,
  saveComposerModelsForBackend as persistComposerModelsForBackend
} from './preferences'
import { log } from './logger'
import { readWslClaudeSettings, writeWslClaudeSettings } from './wslConfig'
import { hermesConfigPath, readHermesProvider } from './hermesConfig'
import type {
  ClaudeExecutionBackend,
  ComposerModel,
  Provider,
  ProviderBackend,
  ProviderAuthType,
  ProviderProfile,
  ProviderProfiles
} from '../shared/ipc'

type PersistedSettings = ReturnType<typeof loadSettings>
type ProviderConfigChangeReason = 'native' | 'settings'

/**
 * Multi-provider API switching.
 *
 * Forge keeps provider lists client-side, then applies the active provider to
 * Claude's native settings.json and to each spawned Claude process. Windows and
 * WSL backends intentionally have separate provider lists and active IDs, so a
 * WSL switch does not overwrite the Windows Claude profile.
 */

function currentProviderBackend(): ProviderBackend {
  if (currentAgentBackend() === 'hermes') return 'hermes'
  return currentBackend()
}

function normalizeProviderBackend(backend: ProviderBackend): ProviderBackend {
  if (backend === 'hermes') return 'hermes'
  return backend === 'wsl' && process.platform === 'win32' ? 'wsl' : 'windows'
}

function providerList(s: PersistedSettings, backend: ProviderBackend): Provider[] {
  if (backend === 'hermes') return [readHermesProvider()]
  return backend === 'wsl' ? (s.wslProviders ?? []) : (s.providers ?? [])
}

function setProviderList(s: PersistedSettings, backend: ProviderBackend, list: Provider[]): void {
  if (backend === 'hermes') return
  if (backend === 'wsl') s.wslProviders = list
  else s.providers = list
}

function activeProviderId(s: PersistedSettings, backend: ProviderBackend): string | null | undefined {
  if (backend === 'hermes') return readHermesProvider().id
  return backend === 'wsl' ? s.wslActiveProviderId : s.activeProviderId
}

function setActiveProviderId(
  s: PersistedSettings,
  backend: ProviderBackend,
  id: string | null
): void {
  if (backend === 'hermes') return
  if (backend === 'wsl') s.wslActiveProviderId = id
  else s.activeProviderId = id
}

function backendLabel(backend: ProviderBackend): string {
  if (backend === 'hermes') return 'Hermes'
  return backend === 'wsl' ? 'WSL' : 'Windows'
}

const NATIVE_PROVIDER_ID_PREFIX = 'native-config'
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'
]

function nativeProviderId(backend: ProviderBackend): string {
  return `${NATIVE_PROVIDER_ID_PREFIX}:${backend}`
}

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function readWindowsClaudeSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeWindowsClaudeSettings(data: Record<string, unknown>): void {
  const p = claudeSettingsPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    log('providers', `failed to write ${p}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function readClaudeSettings(backend: ProviderBackend): Record<string, unknown> {
  if (backend === 'hermes') return {}
  return backend === 'wsl' ? readWslClaudeSettings() : readWindowsClaudeSettings()
}

function writeClaudeSettings(backend: ProviderBackend, data: Record<string, unknown>): void {
  if (backend === 'hermes') return
  if (backend === 'wsl') writeWslClaudeSettings(data)
  else writeWindowsClaudeSettings(data)
}

function envFromSettings(backend: ProviderBackend): Record<string, string> {
  const root = readClaudeSettings(backend)
  const raw = root['env'] && typeof root['env'] === 'object'
    ? root['env'] as Record<string, unknown>
    : {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function modelFromEnv(env: Record<string, string>): string {
  return (
    env['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'] ||
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] ||
    env['ANTHROPIC_MODEL'] ||
    'claude-opus-4-8'
  )
}

function hasProviderEnv(env: Record<string, string>): boolean {
  return PROVIDER_ENV_KEYS.some((key) => !!env[key]?.trim())
}

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function providerConfigEquals(a: Provider, b: Provider): boolean {
  return (
    normalizedBaseUrl(a.baseUrl) === normalizedBaseUrl(b.baseUrl) &&
    a.token.trim() === b.token.trim() &&
    a.authType === b.authType &&
    a.model.trim() === b.model.trim()
  )
}

function providerEquals(a: Provider, b: Provider): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    providerConfigEquals(a, b)
  )
}

function providerFromNativeConfig(backend: ProviderBackend): Provider | null {
  const env = envFromSettings(backend)
  if (!hasProviderEnv(env)) return null

  const apiKey = env['ANTHROPIC_API_KEY']?.trim() ?? ''
  const bearerToken = env['ANTHROPIC_AUTH_TOKEN']?.trim() ?? ''
  const authType: ProviderAuthType = apiKey ? 'apikey' : 'bearer'

  return {
    id: nativeProviderId(backend),
    name: backend === 'wsl' ? 'WSL 本机配置' : '本机配置',
    baseUrl: env['ANTHROPIC_BASE_URL']?.trim() || 'https://api.anthropic.com',
    token: authType === 'apikey' ? apiKey : bearerToken,
    authType,
    model: modelFromEnv(env)
  }
}

function shouldSyncNativeConfig(backend: ProviderBackend): boolean {
  if (backend === 'hermes') return false
  return backend === 'windows' || backend === currentProviderBackend()
}

function syncProviderListWithNativeConfig(s: PersistedSettings, backend: ProviderBackend): boolean {
  if (!shouldSyncNativeConfig(backend)) return false

  const nativeProvider = providerFromNativeConfig(backend)
  if (!nativeProvider) return false

  const list = [...providerList(s, backend)]
  const matching = list.find((provider) =>
    provider.id !== nativeProvider.id && providerConfigEquals(provider, nativeProvider)
  )
  if (matching) {
    if (activeProviderId(s, backend) === matching.id) return false
    setActiveProviderId(s, backend, matching.id)
    return true
  }

  const existingIndex = list.findIndex((provider) => provider.id === nativeProvider.id)
  const providerToSave =
    existingIndex >= 0 && list[existingIndex].name.trim()
      ? { ...nativeProvider, name: list[existingIndex].name }
      : nativeProvider
  let changed = false

  if (existingIndex >= 0) {
    if (!providerEquals(list[existingIndex], providerToSave)) {
      list[existingIndex] = providerToSave
      changed = true
    }
  } else {
    list.push(providerToSave)
    changed = true
  }

  if (activeProviderId(s, backend) !== providerToSave.id) {
    setActiveProviderId(s, backend, providerToSave.id)
    changed = true
  }

  if (changed) setProviderList(s, backend, list)
  return changed
}

function createSeedProvider(backend: ProviderBackend): Provider {
  const env = envFromSettings(backend)
  const pe = backend === 'windows' ? process.env as Record<string, string | undefined> : {}
  const baseUrl = env['ANTHROPIC_BASE_URL'] || pe['ANTHROPIC_BASE_URL'] || ''
  const token =
    env['ANTHROPIC_AUTH_TOKEN'] ||
    env['ANTHROPIC_API_KEY'] ||
    pe['ANTHROPIC_AUTH_TOKEN'] ||
    pe['ANTHROPIC_API_KEY'] ||
    ''
  const authType: ProviderAuthType =
    env['ANTHROPIC_API_KEY'] || pe['ANTHROPIC_API_KEY'] ? 'apikey' : 'bearer'

  return {
    id: randomUUID(),
    name: backend === 'wsl' ? 'WSL 默认' : '默认',
    baseUrl: baseUrl || 'https://api.anthropic.com',
    token: token || '',
    authType,
    model: modelFromEnv(env)
  }
}

function seedDefaultForBackend(s: PersistedSettings, backend: ProviderBackend): boolean {
  if (backend === 'hermes') return false
  if (providerList(s, backend).length) return false
  const provider = createSeedProvider(backend)
  setProviderList(s, backend, [provider])
  setActiveProviderId(s, backend, provider.id)
  log('providers', `seeded ${backendLabel(backend)} default provider: ${provider.baseUrl} (${provider.authType})`)
  return true
}

function settingsForBackend(backend: ProviderBackend): PersistedSettings {
  const s = loadSettings()
  const changed = seedDefaultForBackend(s, backend) || syncProviderListWithNativeConfig(s, backend)
  if (changed) saveSettings(s)
  return s
}

export function refreshProviderProfileFromNativeConfig(backend: ProviderBackend): boolean {
  const normalized = normalizeProviderBackend(backend)
  const s = loadSettings()
  const changed = syncProviderListWithNativeConfig(s, normalized)
  if (changed) saveSettings(s)
  return changed
}

export function listProviders(): Provider[] {
  const backend = currentProviderBackend()
  return [...providerList(settingsForBackend(backend), backend)]
}

export function getProviderProfile(backend: ProviderBackend): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  if (normalized === 'hermes') {
    const provider = readHermesProvider()
    const s = loadSettings()
    return {
      backend: 'hermes',
      providers: [provider],
      activeProviderId: provider.id,
      composerModels: s.hermesComposerModels
    }
  }
  const s = settingsForBackend(normalized)
  return {
    backend: normalized,
    providers: [...providerList(s, normalized)],
    activeProviderId: activeProviderId(s, normalized) ?? null,
    composerModels: composerModelsForBackend(s, normalized)
  }
}

export function getProviderProfiles(): ProviderProfiles {
  return {
    activeBackend: currentProviderBackend(),
    profiles: [getProviderProfile('windows'), getProviderProfile('wsl'), getProviderProfile('hermes')]
  }
}

export function getActiveProvider(): Provider | null {
  const backend = currentProviderBackend()
  const s = settingsForBackend(backend)
  const list = providerList(s, backend)
  if (!list.length) return null
  return list.find((p) => p.id === activeProviderId(s, backend)) ?? null
}

export function saveProvider(p: Provider): Provider[] {
  const backend = currentProviderBackend()
  if (backend === 'hermes') throw new Error('Hermes 运营商由 Hermes config.yaml 管理，请使用 `hermes model` 切换。')
  const s = settingsForBackend(backend)
  const list = [...providerList(s, backend)]
  const idx = list.findIndex((x) => x.id === p.id)
  if (idx >= 0) list[idx] = p
  else list.push(p)
  setProviderList(s, backend, list)
  saveSettings(s)

  if (p.id === activeProviderId(s, backend)) applyToClaudeConfig(p, backend)
  return list
}

export function saveProviderForBackend(backend: ProviderBackend, p: Provider): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  if (normalized === 'hermes') throw new Error('Hermes 运营商由 Hermes config.yaml 管理，请使用 `hermes model` 切换。')
  const s = settingsForBackend(normalized)
  const list = [...providerList(s, normalized)]
  const idx = list.findIndex((x) => x.id === p.id)
  if (idx >= 0) list[idx] = p
  else list.push(p)
  setProviderList(s, normalized, list)
  saveSettings(s)

  if (p.id === activeProviderId(s, normalized)) applyToClaudeConfig(p, normalized)
  return getProviderProfile(normalized)
}

export function deleteProvider(id: string): Provider[] {
  const backend = currentProviderBackend()
  if (backend === 'hermes') throw new Error('Hermes 运营商由 Hermes config.yaml 管理，请使用 `hermes model` 切换。')
  const s = settingsForBackend(backend)
  const list = providerList(s, backend).filter((p) => p.id !== id)
  if (activeProviderId(s, backend) === id) {
    setActiveProviderId(s, backend, list[0]?.id ?? null)
  }
  setProviderList(s, backend, list)
  saveSettings(s)
  return list
}

export function deleteProviderForBackend(backend: ProviderBackend, id: string): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  if (normalized === 'hermes') throw new Error('Hermes 运营商由 Hermes config.yaml 管理，请使用 `hermes model` 切换。')
  const s = settingsForBackend(normalized)
  const list = providerList(s, normalized).filter((p) => p.id !== id)
  const removedActive = activeProviderId(s, normalized) === id
  if (removedActive) setActiveProviderId(s, normalized, list[0]?.id ?? null)
  setProviderList(s, normalized, list)
  saveSettings(s)
  const nextActive = list.find((p) => p.id === activeProviderId(s, normalized))
  if (removedActive && nextActive) applyToClaudeConfig(nextActive, normalized)
  return getProviderProfile(normalized)
}

/**
 * Write a provider's connection params into the selected backend's native
 * settings.json env. Only ANTHROPIC_BASE_URL plus the active auth key are
 * touched; model mappings, MCP servers, and other settings are preserved.
 */
function applyToClaudeConfig(p: Provider, backend: ProviderBackend): void {
  if (backend === 'hermes') return
  const root = readClaudeSettings(backend)
  const env = (root['env'] && typeof root['env'] === 'object'
    ? root['env']
    : {}) as Record<string, string>
  env['ANTHROPIC_BASE_URL'] = p.baseUrl
  if (p.authType === 'apikey') {
    env['ANTHROPIC_API_KEY'] = p.token
    delete env['ANTHROPIC_AUTH_TOKEN']
  } else {
    env['ANTHROPIC_AUTH_TOKEN'] = p.token
    delete env['ANTHROPIC_API_KEY']
  }
  root['env'] = env
  writeClaudeSettings(backend, root)
}

export function setActiveProvider(id: string): void {
  const backend = currentProviderBackend()
  if (backend === 'hermes') {
    if (id !== readHermesProvider().id) throw new Error('Hermes 运营商由 Hermes config.yaml 管理。')
    return
  }
  const s = settingsForBackend(backend)
  const p = providerList(s, backend).find((x) => x.id === id)
  if (!p) throw new Error('运营商不存在')
  setActiveProviderId(s, backend, id)
  saveSettings(s)
  applyToClaudeConfig(p, backend)
  log('providers', `active ${backendLabel(backend)} provider -> "${p.name}" (${p.baseUrl}, ${p.authType})`)
}

export function setActiveProviderForBackend(backend: ProviderBackend, id: string): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  if (normalized === 'hermes') {
    if (id !== readHermesProvider().id) throw new Error('Hermes 运营商由 Hermes config.yaml 管理。')
    return getProviderProfile('hermes')
  }
  const s = settingsForBackend(normalized)
  const p = providerList(s, normalized).find((x) => x.id === id)
  if (!p) throw new Error('provider not found')
  setActiveProviderId(s, normalized, id)
  saveSettings(s)
  applyToClaudeConfig(p, normalized)
  log('providers', `active ${backendLabel(normalized)} provider -> "${p.name}" (${p.baseUrl}, ${p.authType})`)
  return getProviderProfile(normalized)
}

export function saveComposerModelsProfile(
  backend: ProviderBackend,
  models: ComposerModel[]
): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  if (normalized === 'hermes') {
    const s = loadSettings()
    s.hermesComposerModels = models
    saveSettings(s)
    return getProviderProfile('hermes')
  }
  persistComposerModelsForBackend(normalized, models)
  return getProviderProfile(normalized)
}

/**
 * On first run, seed a Windows default provider from the existing Claude config.
 * WSL providers are seeded lazily when the user switches the app to WSL mode.
 */
export function seedDefaultIfNeeded(): void {
  const s = loadSettings()
  const changed = seedDefaultForBackend(s, 'windows')
  if (changed) saveSettings(s)
}

function watchFileByDirectory(filePath: string, onChange: () => void): (() => void) | null {
  const dir = dirname(filePath)
  const file = basename(filePath)
  try {
    mkdirSync(dir, { recursive: true })
    const watcher: FSWatcher = watch(dir, { persistent: false }, (_event, changedFile) => {
      if (!changedFile || changedFile.toString() === file) onChange()
    })
    return () => watcher.close()
  } catch (error) {
    log('providers', `watch ${filePath} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function watchProviderConfigFiles(
  onChanged: (reason: ProviderConfigChangeReason) => void
): () => void {
  let nativeTimer: ReturnType<typeof setTimeout> | null = null
  let hermesTimer: ReturnType<typeof setTimeout> | null = null
  let settingsTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup: Array<() => void> = []

  const scheduleNativeRefresh = (): void => {
    if (nativeTimer !== null) clearTimeout(nativeTimer)
    nativeTimer = setTimeout(() => {
      nativeTimer = null
      try {
        if (refreshProviderProfileFromNativeConfig('windows')) onChanged('native')
      } catch (error) {
        log('providers', `native config refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, 180)
  }

  const scheduleHermesRefresh = (): void => {
    if (hermesTimer !== null) clearTimeout(hermesTimer)
    hermesTimer = setTimeout(() => {
      hermesTimer = null
      onChanged('native')
    }, 180)
  }

  const scheduleSettingsRefresh = (): void => {
    if (settingsTimer !== null) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      settingsTimer = null
      onChanged('settings')
    }, 180)
  }

  const nativeWatcher = watchFileByDirectory(claudeSettingsPath(), scheduleNativeRefresh)
  if (nativeWatcher) cleanup.push(nativeWatcher)
  const hermesWatcher = watchFileByDirectory(hermesConfigPath(), scheduleHermesRefresh)
  if (hermesWatcher) cleanup.push(hermesWatcher)

  const settingsWatcher = watchFileByDirectory(getSettingsFilePath(), scheduleSettingsRefresh)
  if (settingsWatcher) cleanup.push(settingsWatcher)

  return () => {
    if (nativeTimer !== null) clearTimeout(nativeTimer)
    if (hermesTimer !== null) clearTimeout(hermesTimer)
    if (settingsTimer !== null) clearTimeout(settingsTimer)
    cleanup.forEach((dispose) => dispose())
  }
}

/** Build a blank provider (for the add form). */
export function blankProvider(): Provider {
  return {
    id: randomUUID(),
    name: '',
    baseUrl: 'https://api.anthropic.com',
    token: '',
    authType: 'bearer',
    model: 'claude-opus-4-8'
  }
}
