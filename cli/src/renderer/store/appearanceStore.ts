import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * 界面风格。
 * - glass：现有的玻璃拟态（面板带描边 + 渐变 + 内高光 + 投影 + 两层透镜伪元素）
 * - flat：极简。容器让位给内容——分区靠背景台阶而不是描边，去投影，
 *   统一一个发丝色和一个圆角，强调色只留给「进行中」状态和发送键。
 * 两套都保留，因为这是审美取舍不是对错，切换成本也低。
 */
export type UiStyle = 'glass' | 'flat'

/**
 * 主题底色。
 * - onyx：一直以来的深黑（壳底近 #05060A）
 * - charcoal：Codex 风炭灰，整体抬亮一档（壳 #1b1d21、面板 #23262b）。
 *   只换"底"，accent 紫色系不动。
 */
export type ThemeName = 'onyx' | 'charcoal'

export interface AppearanceSettings {
  motionSpeed: number
  glassGlow: boolean
  uiStyle: UiStyle
  theme: ThemeName
}

export const MOTION_SPEED_MIN = 25
export const MOTION_SPEED_MAX = 200
export const MOTION_SPEED_STEP = 5

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  motionSpeed: 50,
  glassGlow: false,
  // 默认简约。玻璃那套仍然保留在设置里，只是不再是新装机看到的第一眼。
  uiStyle: 'flat',
  theme: 'onyx'
}

const LEGACY_STORAGE_KEY = 'forge.appearance.v1'
const STORAGE_KEY = 'forge.appearance.v2'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function cssNumber(value: number): string {
  return value.toFixed(3)
}

function normalizeMotionSpeed(value: unknown): number {
  const speed = Number(value ?? DEFAULT_APPEARANCE_SETTINGS.motionSpeed)
  return clamp(
    Number.isFinite(speed) ? speed : DEFAULT_APPEARANCE_SETTINGS.motionSpeed,
    MOTION_SPEED_MIN,
    MOTION_SPEED_MAX
  )
}

function normalizeSettings(value: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  return {
    motionSpeed: normalizeMotionSpeed(value?.motionSpeed),
    glassGlow: value?.glassGlow ?? DEFAULT_APPEARANCE_SETTINGS.glassGlow,
    // 两个值都要显式认。原先只认 'flat'、其余一律回落到默认——默认改成
    // flat 之后，那样写会把「用户明确选了玻璃」也吞掉，设置里点不动。
    uiStyle:
      value?.uiStyle === 'flat' || value?.uiStyle === 'glass'
        ? value.uiStyle
        : DEFAULT_APPEARANCE_SETTINGS.uiStyle,
    theme:
      value?.theme === 'onyx' || value?.theme === 'charcoal'
        ? value.theme
        : DEFAULT_APPEARANCE_SETTINGS.theme
  }
}

function migrateLegacySettings(value: Partial<AppearanceSettings> | null | undefined): AppearanceSettings {
  const legacySpeed = Number(value?.motionSpeed ?? 100)
  return normalizeSettings({
    ...value,
    motionSpeed: Number.isFinite(legacySpeed) ? legacySpeed / 2 : DEFAULT_APPEARANCE_SETTINGS.motionSpeed
  })
}

function readSettings(): AppearanceSettings {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE_SETTINGS

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return normalizeSettings(JSON.parse(raw) as Partial<AppearanceSettings>)
  } catch {
    // Fall through to the legacy key before using defaults.
  }

  try {
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacyRaw) {
      const migrated = migrateLegacySettings(JSON.parse(legacyRaw) as Partial<AppearanceSettings>)
      saveSettings(migrated)
      return migrated
    }
  } catch {
    // Ignore corrupt persisted settings.
  }

  return DEFAULT_APPEARANCE_SETTINGS
}

function saveSettings(settings: AppearanceSettings): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function applyAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  const normalized = normalizeSettings(settings)
  const durationFactor = 50 / normalized.motionSpeed

  // 简约模式下泛光一律按 off 生效（设置里的开关值保留，切回玻璃风时恢复）。
  // 否则 .accent-soft-button / .glass-active 这类不在简约覆盖清单里的元素
  // 仍会随开关变化——简约风下切「玻璃泛光」能看出区别就是这么来的。
  const effectiveGlow = normalized.uiStyle === 'flat' ? false : normalized.glassGlow
  root.dataset.glassGlow = effectiveGlow ? 'on' : 'off'
  // 扁平化规则必须写在 styles.css 的 @layer components 里才生效：级联层对
  // !important 的优先级是反的（层内赢过层外），层外样式压不住既有的层内规则。
  root.dataset.ui = normalized.uiStyle
  root.dataset.theme = normalized.theme

  root.style.setProperty('--motion-collapse-open', `${Math.round(180 * durationFactor)}ms`)
  root.style.setProperty('--motion-collapse-close', `${Math.round(150 * durationFactor)}ms`)
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
  // 环境泛光层（.app-shell::before）同样跟随生效值，而不是原始开关值。
  root.style.setProperty('--glass-ambient-opacity', effectiveGlow ? '0.48' : '0.18')
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
  }, [settings.motionSpeed, settings.glassGlow, settings.uiStyle, settings.theme])
}
