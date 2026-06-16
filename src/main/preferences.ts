import { loadSettings, saveSettings } from './settings'
import { armVulkanBackendPreference } from './gpuBackend'
import type { ClaudeExecutionBackend, ComposerModel, Preferences } from '../shared/ipc'

/** App preferences (Settings panel). Stored in forge-settings.json alongside
 *  providers/projects. */

export function currentBackend(s: ReturnType<typeof loadSettings> = loadSettings()): ClaudeExecutionBackend {
  const wslSupportEnabled = s.wslSupportEnabled ?? s.claudeExecutionBackend === 'wsl'
  return process.platform === 'win32' && wslSupportEnabled && s.claudeExecutionBackend === 'wsl'
    ? 'wsl'
    : 'windows'
}

export function composerModelsForBackend(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend
): ComposerModel[] | undefined {
  return backend === 'wsl' ? s.wslComposerModels : s.composerModels
}

export function setComposerModelsForBackend(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend,
  models: ComposerModel[]
): void {
  if (backend === 'wsl') s.wslComposerModels = models
  else s.composerModels = models
}

export function saveComposerModelsForBackend(
  backend: ClaudeExecutionBackend,
  models: ComposerModel[]
): ComposerModel[] {
  const s = loadSettings()
  setComposerModelsForBackend(s, backend, models)
  saveSettings(s)
  return composerModelsForBackend(s, backend) ?? []
}

export function getPreferences(): Preferences {
  const s = loadSettings()
  const backend = currentBackend(s)
  return {
    defaultEffort: s.defaultEffort,
    defaultPermissionMode: s.defaultPermissionMode,
    wslSupportEnabled: s.wslSupportEnabled ?? s.claudeExecutionBackend === 'wsl',
    claudeExecutionBackend: currentBackend(s),
    composerModels: composerModelsForBackend(s, backend),
    vulkanBackend: s.vulkanBackend,
    minimizeToTray: s.minimizeToTray,
    nativeNotifications: s.nativeNotifications,
    closePromptDismissed: s.closePromptDismissed
  }
}

/** Merge-apply the provided fields (only keys present in `prefs` are overwritten). */
export function savePreferences(prefs: Preferences): Preferences {
  const s = loadSettings()
  if (prefs.defaultEffort !== undefined) s.defaultEffort = prefs.defaultEffort
  if (prefs.defaultPermissionMode !== undefined) s.defaultPermissionMode = prefs.defaultPermissionMode
  if (prefs.wslSupportEnabled !== undefined) {
    s.wslSupportEnabled = prefs.wslSupportEnabled
    if (!prefs.wslSupportEnabled) s.claudeExecutionBackend = 'windows'
  }
  if (prefs.claudeExecutionBackend !== undefined) {
    s.claudeExecutionBackend =
      prefs.claudeExecutionBackend === 'wsl' && !s.wslSupportEnabled
        ? 'windows'
        : prefs.claudeExecutionBackend
  }
  if (prefs.composerModels !== undefined) {
    setComposerModelsForBackend(s, currentBackend(s), prefs.composerModels)
  }
  if (prefs.vulkanBackend !== undefined) {
    s.vulkanBackend = prefs.vulkanBackend
    armVulkanBackendPreference(prefs.vulkanBackend)
  }
  if (prefs.minimizeToTray !== undefined) s.minimizeToTray = prefs.minimizeToTray
  if (prefs.nativeNotifications !== undefined) s.nativeNotifications = prefs.nativeNotifications
  if (prefs.closePromptDismissed !== undefined) s.closePromptDismissed = prefs.closePromptDismissed
  saveSettings(s)
  return getPreferences()
}
