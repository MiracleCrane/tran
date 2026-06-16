import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import {
  composerModelsForBackend,
  currentBackend,
  saveComposerModelsForBackend as persistComposerModelsForBackend
} from './preferences'
import { log } from './logger'
import { readWslClaudeSettings, writeWslClaudeSettings } from './wslConfig'
import type {
  ClaudeExecutionBackend,
  ComposerModel,
  Provider,
  ProviderAuthType,
  ProviderProfile,
  ProviderProfiles
} from '../shared/ipc'

type PersistedSettings = ReturnType<typeof loadSettings>
type ProviderBackend = ClaudeExecutionBackend

/**
 * Multi-provider API switching.
 *
 * Forge keeps provider lists client-side, then applies the active provider to
 * Claude's native settings.json and to each spawned Claude process. Windows and
 * WSL backends intentionally have separate provider lists and active IDs, so a
 * WSL switch does not overwrite the Windows Claude profile.
 */

function currentProviderBackend(): ProviderBackend {
  return currentBackend()
}

function normalizeProviderBackend(backend: ProviderBackend): ProviderBackend {
  return backend === 'wsl' && process.platform === 'win32' ? 'wsl' : 'windows'
}

function providerList(s: PersistedSettings, backend: ProviderBackend): Provider[] {
  return backend === 'wsl' ? (s.wslProviders ?? []) : (s.providers ?? [])
}

function setProviderList(s: PersistedSettings, backend: ProviderBackend, list: Provider[]): void {
  if (backend === 'wsl') s.wslProviders = list
  else s.providers = list
}

function activeProviderId(s: PersistedSettings, backend: ProviderBackend): string | null | undefined {
  return backend === 'wsl' ? s.wslActiveProviderId : s.activeProviderId
}

function setActiveProviderId(
  s: PersistedSettings,
  backend: ProviderBackend,
  id: string | null
): void {
  if (backend === 'wsl') s.wslActiveProviderId = id
  else s.activeProviderId = id
}

function backendLabel(backend: ProviderBackend): string {
  return backend === 'wsl' ? 'WSL' : 'Windows'
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
  return backend === 'wsl' ? readWslClaudeSettings() : readWindowsClaudeSettings()
}

function writeClaudeSettings(backend: ProviderBackend, data: Record<string, unknown>): void {
  if (backend === 'wsl') writeWslClaudeSettings(data)
  else writeWindowsClaudeSettings(data)
}

function envFromSettings(backend: ProviderBackend): Record<string, string> {
  const root = readClaudeSettings(backend)
  return (root['env'] && typeof root['env'] === 'object' ? root['env'] : {}) as Record<string, string>
}

function modelFromEnv(env: Record<string, string>): string {
  return (
    env['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'] ||
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] ||
    env['ANTHROPIC_MODEL'] ||
    'claude-opus-4-8'
  )
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
  if (providerList(s, backend).length) return false
  const provider = createSeedProvider(backend)
  setProviderList(s, backend, [provider])
  setActiveProviderId(s, backend, provider.id)
  log('providers', `seeded ${backendLabel(backend)} default provider: ${provider.baseUrl} (${provider.authType})`)
  return true
}

function settingsForBackend(backend: ProviderBackend): PersistedSettings {
  const s = loadSettings()
  if (seedDefaultForBackend(s, backend)) saveSettings(s)
  return s
}

export function listProviders(): Provider[] {
  const backend = currentProviderBackend()
  return [...providerList(settingsForBackend(backend), backend)]
}

export function getProviderProfile(backend: ProviderBackend): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
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
    profiles: [getProviderProfile('windows'), getProviderProfile('wsl')]
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
