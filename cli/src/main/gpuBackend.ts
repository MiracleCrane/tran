import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from './logger'

interface RawSettings {
  vulkanBackend?: boolean
  [key: string]: unknown
}

interface GpuBootState {
  allowNextVulkanAttempt?: boolean
  lastVulkanOk?: boolean
  pendingVulkanLaunch?: boolean
  pendingStartedAt?: number
  disabledAt?: number
  fallbackReason?: string
}

let currentLaunchUsesVulkan = false

export function isVulkanBackendActive(): boolean {
  return currentLaunchUsesVulkan
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'forge-settings.json')
}

function statePath(): string {
  return join(app.getPath('userData'), 'forge-gpu-state.json')
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    log('gpu', `failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function readSettings(): RawSettings {
  return readJson<RawSettings>(settingsPath(), {})
}

function writeSettings(settings: RawSettings): void {
  writeJson(settingsPath(), settings)
}

function readState(): GpuBootState {
  return readJson<GpuBootState>(statePath(), {})
}

function writeState(state: GpuBootState): void {
  writeJson(statePath(), state)
}

function disableVulkanPreference(reason: string, state = readState()): void {
  currentLaunchUsesVulkan = false
  const settings = readSettings()
  if (settings.vulkanBackend) {
    settings.vulkanBackend = false
    writeSettings(settings)
  }
  writeState({
    ...state,
    allowNextVulkanAttempt: false,
    lastVulkanOk: false,
    pendingVulkanLaunch: false,
    disabledAt: Date.now(),
    fallbackReason: reason
  })
  log('gpu', `Vulkan backend disabled: ${reason}`)
}

/** Called when the Settings panel changes the experimental Vulkan toggle. */
export function armVulkanBackendPreference(enabled: boolean): void {
  const state = readState()
  if (enabled) {
    writeState({
      ...state,
      allowNextVulkanAttempt: true,
      pendingVulkanLaunch: false,
      fallbackReason: undefined
    })
  } else {
    writeState({
      ...state,
      allowNextVulkanAttempt: false,
      lastVulkanOk: false,
      pendingVulkanLaunch: false,
      fallbackReason: undefined
    })
  }
}

/** Must run before Chromium's GPU process starts. */
export function configureWindowsGpuBackend(): void {
  if (process.platform !== 'win32') return

  const settings = readSettings()
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')

  if (!settings.vulkanBackend) {
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
    app.commandLine.appendSwitch('enable-zero-copy')
    return
  }

  const forcedSafe =
    process.env['FORGE_SAFE_GPU'] === '1' || process.argv.includes('--forge-safe-gpu')
  if (forcedSafe) {
    disableVulkanPreference('safe GPU mode requested')
    app.commandLine.appendSwitch('use-angle', 'd3d11')
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,Vulkan')
    return
  }

  const state = readState()
  if (state.pendingVulkanLaunch) {
    disableVulkanPreference('previous Vulkan launch did not reach ready-to-show', state)
    app.commandLine.appendSwitch('use-angle', 'd3d11')
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,Vulkan')
    return
  }

  const mayAttemptVulkan = state.allowNextVulkanAttempt || state.lastVulkanOk
  if (!mayAttemptVulkan) {
    disableVulkanPreference('Vulkan preference predates the startup guard', state)
    app.commandLine.appendSwitch('use-angle', 'd3d11')
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,Vulkan')
    return
  }

  currentLaunchUsesVulkan = true
  writeState({
    ...state,
    allowNextVulkanAttempt: false,
    pendingVulkanLaunch: true,
    pendingStartedAt: Date.now(),
    fallbackReason: undefined
  })

  app.commandLine.appendSwitch('use-angle', 'vulkan')
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('disable-direct-composition')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('enable-features', 'DefaultANGLEVulkan,VulkanFromANGLE')
  log('gpu', 'Vulkan backend enabled for this launch')
}

export function markGpuBackendWindowReady(): void {
  if (!currentLaunchUsesVulkan) return
  const state = readState()
  writeState({
    ...state,
    lastVulkanOk: true,
    pendingVulkanLaunch: false,
    pendingStartedAt: undefined,
    fallbackReason: undefined
  })
}
