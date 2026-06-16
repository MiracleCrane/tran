import { loadSettings, saveSettings } from './settings'
import { armVulkanBackendPreference } from './gpuBackend'
import type { Preferences } from '../shared/ipc'

/** App preferences (Settings panel). Stored in forge-settings.json alongside
 *  providers/projects. */

export function getPreferences(): Preferences {
  const s = loadSettings()
  return {
    defaultEffort: s.defaultEffort,
    defaultPermissionMode: s.defaultPermissionMode,
    composerModels: s.composerModels,
    vulkanBackend: s.vulkanBackend
  }
}

/** Merge-apply the provided fields (only keys present in `prefs` are overwritten). */
export function savePreferences(prefs: Preferences): Preferences {
  const s = loadSettings()
  if (prefs.defaultEffort !== undefined) s.defaultEffort = prefs.defaultEffort
  if (prefs.defaultPermissionMode !== undefined) s.defaultPermissionMode = prefs.defaultPermissionMode
  if (prefs.composerModels !== undefined) s.composerModels = prefs.composerModels
  if (prefs.vulkanBackend !== undefined) {
    s.vulkanBackend = prefs.vulkanBackend
    armVulkanBackendPreference(prefs.vulkanBackend)
  }
  saveSettings(s)
  return getPreferences()
}
