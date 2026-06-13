import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface PersistedSettings {
  /** base64 of safeStorage-encrypted bytes */
  apiKeyEnc?: string
  /** plaintext fallback when safeStorage is unavailable */
  apiKeyPlain?: string
}

let cache: PersistedSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'forge-settings.json')
}

function load(): PersistedSettings {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(settingsPath(), 'utf8')) as PersistedSettings
  } catch {
    cache = {}
  }
  return cache
}

function save(s: PersistedSettings): void {
  cache = s
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2))
  } catch {
    /* best-effort persistence */
  }
}

export function getApiKey(): string | null {
  const s = load()
  if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.apiKeyPlain ?? null
}

export function setApiKey(key: string | null): void {
  const s = load()
  if (key && safeStorage.isEncryptionAvailable()) {
    s.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
    delete s.apiKeyPlain
  } else if (key) {
    s.apiKeyPlain = key
    delete s.apiKeyEnc
  } else {
    delete s.apiKeyEnc
    delete s.apiKeyPlain
  }
  save(s)
}
