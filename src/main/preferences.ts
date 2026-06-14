import { loadSettings, saveSettings } from './settings'
import type { Preferences } from '../shared/ipc'

/** App preferences (Settings panel). Stored in forge-settings.json alongside
 *  providers/projects. */

export function getPreferences(): Preferences {
  const s = loadSettings()
  return {
    defaultEffort: s.defaultEffort,
    defaultPermissionMode: s.defaultPermissionMode,
    composerModels: s.composerModels
  }
}

/** Merge-apply the provided fields (only keys present in `prefs` are overwritten). */
export function savePreferences(prefs: Preferences): Preferences {
  const s = loadSettings()
  if (prefs.defaultEffort !== undefined) s.defaultEffort = prefs.defaultEffort
  if (prefs.defaultPermissionMode !== undefined) s.defaultPermissionMode = prefs.defaultPermissionMode
  if (prefs.composerModels !== undefined) s.composerModels = prefs.composerModels
  saveSettings(s)
  return getPreferences()
}
