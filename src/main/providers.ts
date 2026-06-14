import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { log } from './logger'
import type { Provider, ProviderAuthType } from '../shared/ipc'

/**
 * Multi-provider API switching.
 *
 * Claude natively reads one API config from ~/.claude/settings.json's `env`
 * (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY). We keep many
 * providers client-side (forge-settings.json) and, on switch, write the chosen
 * one back into that native env — so it becomes "the one" Claude uses. Forge
 * also injects the active provider at every claude.exe spawn (AgentBridge), so
 * switching always takes effect regardless of stray shell env.
 */

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function readClaudeSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(claudeSettingsPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeClaudeSettings(data: Record<string, unknown>): void {
  const p = claudeSettingsPath()
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    log('providers', `failed to write ${p}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function listProviders(): Provider[] {
  return loadSettings().providers ?? []
}

export function getActiveProvider(): Provider | null {
  const s = loadSettings()
  if (!s.providers?.length) return null
  return s.providers.find((p) => p.id === s.activeProviderId) ?? null
}

export function saveProvider(p: Provider): Provider[] {
  const s = loadSettings()
  const list = s.providers ? [...s.providers] : []
  const idx = list.findIndex((x) => x.id === p.id)
  if (idx >= 0) list[idx] = p
  else list.push(p)
  s.providers = list
  saveSettings(s)
  return list
}

export function deleteProvider(id: string): Provider[] {
  const s = loadSettings()
  const list = (s.providers ?? []).filter((p) => p.id !== id)
  if (s.activeProviderId === id) {
    s.activeProviderId = list[0]?.id ?? null
  }
  s.providers = list
  saveSettings(s)
  return list
}

/** Write a provider's connection params into Claude's native settings.json env.
 *  Only ANTHROPIC_BASE_URL + the one auth key are touched; everything else
 *  (includeCoAuthoredBy, model mappings, …) is preserved. */
function applyToClaudeConfig(p: Provider): void {
  const root = readClaudeSettings()
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
  writeClaudeSettings(root)
}

export function setActiveProvider(id: string): void {
  const s = loadSettings()
  const p = (s.providers ?? []).find((x) => x.id === id)
  if (!p) throw new Error('运营商不存在')
  s.activeProviderId = id
  saveSettings(s)
  applyToClaudeConfig(p)
  log('providers', `active provider → "${p.name}" (${p.baseUrl}, ${p.authType})`)
}

/** On first run, seed a "默认" provider from whatever Claude is currently
 *  configured with (settings.json env, falling back to process.env). */
export function seedDefaultIfNeeded(): void {
  const s = loadSettings()
  if (s.providers && s.providers.length) return

  const env = (readClaudeSettings()['env'] ?? {}) as Record<string, string>
  const pe = process.env as Record<string, string | undefined>
  const baseUrl = env['ANTHROPIC_BASE_URL'] || pe['ANTHROPIC_BASE_URL'] || ''
  const token =
    env['ANTHROPIC_AUTH_TOKEN'] ||
    env['ANTHROPIC_API_KEY'] ||
    pe['ANTHROPIC_AUTH_TOKEN'] ||
    pe['ANTHROPIC_API_KEY'] ||
    ''
  const authType: ProviderAuthType =
    env['ANTHROPIC_API_KEY'] || pe['ANTHROPIC_API_KEY'] ? 'apikey' : 'bearer'

  const provider: Provider = {
    id: randomUUID(),
    name: '默认',
    baseUrl: baseUrl || 'https://api.anthropic.com',
    token: token || '',
    authType,
    model: 'claude-opus-4-8'
  }
  s.providers = [provider]
  s.activeProviderId = provider.id
  saveSettings(s)
  log('providers', `seeded default provider: ${provider.baseUrl} (${authType})`)
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
