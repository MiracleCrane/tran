import { useEffect } from 'react'
import { create } from 'zustand'

export interface AppearanceSettings {
  motionSpeed: number
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  motionSpeed: 100
}

const STORAGE_KEY = 'forge.appearance.v1'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function cssNumber(value: number): string {
  return value.toFixed(3)
}

function normalizeSettings(value: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  return {
    motionSpeed: clamp(Number(value?.motionSpeed ?? DEFAULT_APPEARANCE_SETTINGS.motionSpeed), 70, 150)
  }
}

function readSettings(): AppearanceSettings {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE_SETTINGS

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return normalizeSettings(raw ? (JSON.parse(raw) as Partial<AppearanceSettings>) : null)
  } catch {
    return DEFAULT_APPEARANCE_SETTINGS
  }
}

function saveSettings(settings: AppearanceSettings): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function applyAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const normalized = normalizeSettings(settings)
  const durationFactor = 100 / normalized.motionSpeed

  root.style.setProperty('--motion-collapse-open', `${Math.round(550 * durationFactor)}ms`)
  root.style.setProperty('--motion-collapse-close', `${Math.round(480 * durationFactor)}ms`)
  root.style.setProperty('--motion-sidebar', `${Math.round(500 * durationFactor)}ms`)
  root.style.setProperty('--motion-sidebar-content-open', `${Math.round(410 * durationFactor)}ms`)
  root.style.setProperty('--motion-sidebar-content-close', `${Math.round(320 * durationFactor)}ms`)
  root.style.setProperty('--motion-sidebar-content-delay', `${Math.round(50 * durationFactor)}ms`)

  root.style.setProperty('--glass-shell-alpha', cssNumber(1))
  root.style.setProperty('--glass-sidebar-alpha', cssNumber(0.988))
  root.style.setProperty('--glass-main-alpha', cssNumber(0.992))
  root.style.setProperty('--glass-panel-alpha', cssNumber(0.94))
  root.style.setProperty('--glass-soft-alpha', cssNumber(0.885))
  root.style.setProperty('--glass-control-alpha', cssNumber(0.84))
  root.style.setProperty('--glass-active-alpha', cssNumber(0.88))
  root.style.setProperty('--glass-frost-strong-alpha', cssNumber(0.992))
  root.style.setProperty('--glass-frost-panel-alpha', cssNumber(0.972))
  root.style.setProperty('--glass-frost-soft-alpha', cssNumber(0.928))
  root.style.setProperty('--glass-frost-control-alpha', cssNumber(0.872))
  root.style.setProperty('--glass-lens-strong', cssNumber(0.997))
  root.style.setProperty('--glass-lens-panel', cssNumber(0.982))
  root.style.setProperty('--glass-lens-soft', cssNumber(0.948))
  root.style.setProperty('--glass-lens-control', cssNumber(0.91))
  root.style.setProperty('--glass-window-blur', '0px')
  root.style.setProperty('--glass-ambient-opacity', '0.48')
}

interface AppearanceStore {
  settings: AppearanceSettings
  updateSetting: <K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) => void
  reset: () => void
}

export const useAppearanceStore = create<AppearanceStore>((set) => {
  const initial = readSettings()
  applyAppearanceSettings(initial)

  return {
    settings: initial,
    updateSetting: (key, value) =>
      set((state) => {
        const settings = normalizeSettings({ ...state.settings, [key]: value })
        saveSettings(settings)
        applyAppearanceSettings(settings)
        return { settings }
      }),
    reset: () => {
      saveSettings(DEFAULT_APPEARANCE_SETTINGS)
      applyAppearanceSettings(DEFAULT_APPEARANCE_SETTINGS)
      set({ settings: DEFAULT_APPEARANCE_SETTINGS })
    }
  }
})

export function useApplyAppearanceSettings(): void {
  const settings = useAppearanceStore((state) => state.settings)

  useEffect(() => {
    applyAppearanceSettings(settings)
  }, [settings.motionSpeed])
}
