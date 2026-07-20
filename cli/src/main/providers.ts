import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { getSettingsFilePath, loadSettings, saveSettings } from './settings'
import { composerModelsForBackend } from './preferences'
import { log } from './logger'
import type {
  ComposerModel,
  Provider,
  ProviderBackend,
  ProviderProfile,
  ProviderProfiles
} from '../shared/ipc'

type PersistedSettings = ReturnType<typeof loadSettings>
type ProviderConfigChangeReason = 'native' | 'settings'

/**
 * Legacy multi-provider storage.
 *
 * Tran 目前只有 Kimi 后端（不走 Anthropic 运营商），运营商面板入口已在 UI
 * 隐藏。这个模块保留原有 IPC/存储形状（settings.json 里的 providers 列表），
 * 供 translate(LlmEngine) 和未来支持运营商的后端复用；不再读写 Claude/WSL/
 * Hermes 的原生配置文件，所有 backend 参数统一归一到 'windows'。
 */

function normalizeProviderBackend(_backend: ProviderBackend): 'windows' {
  return 'windows'
}

function providerList(s: PersistedSettings): Provider[] {
  return s.providers ?? []
}

function setProviderList(s: PersistedSettings, list: Provider[]): void {
  s.providers = list
}

function activeProviderId(s: PersistedSettings): string | null | undefined {
  return s.activeProviderId
}

function setActiveProviderId(s: PersistedSettings, id: string | null): void {
  s.activeProviderId = id
}

export function listProviders(): Provider[] {
  const s = loadSettings()
  return [...providerList(s)]
}

export function getProviderProfile(backend: ProviderBackend): ProviderProfile {
  const normalized = normalizeProviderBackend(backend)
  const s = loadSettings()
  return {
    backend: normalized,
    providers: [...providerList(s)],
    activeProviderId: activeProviderId(s) ?? null,
    composerModels: composerModelsForBackend(s, normalized)
  }
}

export function getProviderProfiles(): ProviderProfiles {
  return {
    activeBackend: 'windows',
    profiles: [getProviderProfile('windows')]
  }
}

export function getActiveProvider(): Provider | null {
  const s = loadSettings()
  const list = providerList(s)
  if (!list.length) return null
  return list.find((p) => p.id === activeProviderId(s)) ?? null
}

export function saveProvider(p: Provider): Provider[] {
  const s = loadSettings()
  const list = [...providerList(s)]
  const idx = list.findIndex((x) => x.id === p.id)
  if (idx >= 0) list[idx] = p
  else list.push(p)
  setProviderList(s, list)
  saveSettings(s)
  return list
}

export function saveProviderForBackend(backend: ProviderBackend, p: Provider): ProviderProfile {
  saveProvider(p)
  return getProviderProfile(backend)
}

export function deleteProvider(id: string): Provider[] {
  const s = loadSettings()
  const list = providerList(s).filter((p) => p.id !== id)
  if (activeProviderId(s) === id) {
    setActiveProviderId(s, list[0]?.id ?? null)
  }
  setProviderList(s, list)
  saveSettings(s)
  return list
}

export function deleteProviderForBackend(backend: ProviderBackend, id: string): ProviderProfile {
  deleteProvider(id)
  return getProviderProfile(backend)
}

export function setActiveProvider(id: string): void {
  const s = loadSettings()
  const p = providerList(s).find((x) => x.id === id)
  if (!p) throw new Error('运营商不存在')
  setActiveProviderId(s, id)
  saveSettings(s)
  log('providers', `active provider -> "${p.name}" (${p.baseUrl}, ${p.authType})`)
}

export function setActiveProviderForBackend(backend: ProviderBackend, id: string): ProviderProfile {
  setActiveProvider(id)
  return getProviderProfile(backend)
}

export function saveComposerModelsProfile(
  backend: ProviderBackend,
  models: ComposerModel[]
): ProviderProfile {
  const s = loadSettings()
  s.composerModels = models
  saveSettings(s)
  return getProviderProfile(backend)
}

/** 历史遗留：旧版会从 Claude 配置播种默认运营商。Tran 不再播种（运营商面板
 *  已隐藏），保留空实现以免启动流程改动。 */
export function seedDefaultIfNeeded(): void {
  // no-op, see note above
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
  let settingsTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup: Array<() => void> = []

  const scheduleSettingsRefresh = (): void => {
    if (settingsTimer !== null) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => {
      settingsTimer = null
      onChanged('settings')
    }, 180)
  }

  const settingsWatcher = watchFileByDirectory(getSettingsFilePath(), scheduleSettingsRefresh)
  if (settingsWatcher) cleanup.push(settingsWatcher)

  return () => {
    if (settingsTimer !== null) clearTimeout(settingsTimer)
    cleanup.forEach((dispose) => dispose())
  }
}

/** Build a blank provider (for the add form). */
export function blankProvider(): Provider {
  return {
    id: randomUUID(),
    name: '',
    baseUrl: '',
    token: '',
    authType: 'bearer',
    model: 'kimi-default'
  }
}
