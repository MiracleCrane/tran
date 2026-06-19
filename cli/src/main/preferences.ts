import { loadSettings, saveSettings } from './settings'
import { armVulkanBackendPreference } from './gpuBackend'
import type { ClaudeExecutionBackend, ComposerModel, Preferences } from '../shared/ipc'
import { DEFAULT_AGENT_BACKEND_ID, normalizeAgentBackend } from '../shared/agentBackends'

/** App preferences (Settings panel). Stored in forge-settings.json alongside
 *  providers/projects. */

export function currentBackend(s: ReturnType<typeof loadSettings> = loadSettings()): ClaudeExecutionBackend {
  const wslSupportEnabled = s.wslSupportEnabled ?? s.claudeExecutionBackend === 'wsl'
  return process.platform === 'win32' && wslSupportEnabled && s.claudeExecutionBackend === 'wsl'
    ? 'wsl'
    : 'windows'
}

export function currentAgentBackend(
  s: ReturnType<typeof loadSettings> = loadSettings()
): ReturnType<typeof normalizeAgentBackend> {
  return normalizeAgentBackend(s.agentBackend ?? DEFAULT_AGENT_BACKEND_ID)
}

export function composerModelsForBackend(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend
): ComposerModel[] | undefined {
  return backend === 'wsl' ? s.wslComposerModels : s.composerModels
}

export function composerModelsForAgent(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend
): ComposerModel[] | undefined {
  const agentBackend = currentAgentBackend(s)
  if (agentBackend === 'codex') return s.codexComposerModels
  if (agentBackend === 'hermes') return s.hermesComposerModels
  return composerModelsForBackend(s, backend)
}

export function setComposerModelsForBackend(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend,
  models: ComposerModel[]
): void {
  if (backend === 'wsl') s.wslComposerModels = models
  else s.composerModels = models
}

function setComposerModelsForAgent(
  s: ReturnType<typeof loadSettings>,
  backend: ClaudeExecutionBackend,
  models: ComposerModel[]
): void {
  const agentBackend = currentAgentBackend(s)
  if (agentBackend === 'codex') s.codexComposerModels = models
  else if (agentBackend === 'hermes') s.hermesComposerModels = models
  else setComposerModelsForBackend(s, backend, models)
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
    agentBackend: currentAgentBackend(s),
    defaultEffort: s.defaultEffort,
    defaultPermissionMode: s.defaultPermissionMode,
    wslSupportEnabled: s.wslSupportEnabled ?? s.claudeExecutionBackend === 'wsl',
    claudeExecutionBackend: currentBackend(s),
    composerModels: composerModelsForAgent(s, backend),
    codexComposerModels: s.codexComposerModels,
    hermesComposerModels: s.hermesComposerModels,
    vulkanBackend: s.vulkanBackend,
    minimizeToTray: s.minimizeToTray,
    nativeNotifications: s.nativeNotifications,
    closePromptDismissed: s.closePromptDismissed
  }
}

/** Merge-apply the provided fields (only keys present in `prefs` are overwritten). */
export function savePreferences(prefs: Preferences): Preferences {
  const s = loadSettings()
  if (prefs.agentBackend !== undefined) s.agentBackend = normalizeAgentBackend(prefs.agentBackend)
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
    setComposerModelsForAgent(s, currentBackend(s), prefs.composerModels)
  }
  if (prefs.codexComposerModels !== undefined) {
    s.codexComposerModels = prefs.codexComposerModels
  }
  if (prefs.hermesComposerModels !== undefined) {
    s.hermesComposerModels = prefs.hermesComposerModels
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
