import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync
} from 'node:crypto'
import { safeStorage } from 'electron'
import { getSettingsSnapshot, replaceSettingsSnapshot } from './settings'
import type {
  EncryptedSettingsSecrets,
  PortableUiSettings,
  SettingsBackup,
  SettingsExportOptions,
  SettingsImportRequest,
  SettingsImportResult,
  SettingsSecretCategory
} from '../shared/ipc'

interface PortableSecrets {
  providerTokens?: Record<string, Record<string, string>>
  summaryProfileKeys?: Record<string, string>
  legacySummaryKey?: string
  baiduSecret?: string
  deepseekApiKey?: string
}

const SECRET_FIELDS = [
  'apiKeyEnc',
  'apiKeyPlain',
  'baiduSecretEnc',
  'baiduSecretPlain',
  'deepseekApiKeyEnc',
  'deepseekApiKeyPlain'
] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function decryptStoredSecret(record: Record<string, unknown>, encKey: string, plainKey: string): string | null {
  const encrypted = typeof record[encKey] === 'string' ? record[encKey] : null
  if (encrypted && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      return null
    }
  }
  return typeof record[plainKey] === 'string' ? record[plainKey] : null
}

function encodeStoredSecret(value: string): { enc?: string; plain?: string } {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: safeStorage.encryptString(value).toString('base64') }
  }
  return { plain: value }
}

function sanitizeSettings(source: Record<string, unknown>): Record<string, unknown> {
  const settings = cloneRecord(source)
  for (const field of SECRET_FIELDS) delete settings[field]

  for (const field of ['providers', 'wslProviders']) {
    if (!Array.isArray(settings[field])) continue
    settings[field] = (settings[field] as unknown[]).map((item) => {
      const provider = asRecord(item)
      return provider ? { ...provider, token: '' } : item
    })
  }

  if (Array.isArray(settings.summaryProfiles)) {
    settings.summaryProfiles = settings.summaryProfiles.map((item) => {
      const profile = asRecord(item)
      if (!profile) return item
      const clean = { ...profile }
      delete clean.keyEnc
      delete clean.keyPlain
      return clean
    })
  }
  return settings
}

function collectProviderTokens(settings: Record<string, unknown>): Record<string, Record<string, string>> {
  const groups: Record<string, Record<string, string>> = {}
  for (const field of ['providers', 'wslProviders']) {
    if (!Array.isArray(settings[field])) continue
    const tokens: Record<string, string> = {}
    for (const item of settings[field] as unknown[]) {
      const provider = asRecord(item)
      if (!provider || typeof provider.id !== 'string' || typeof provider.token !== 'string' || !provider.token) continue
      tokens[provider.id] = provider.token
    }
    if (Object.keys(tokens).length) groups[field] = tokens
  }
  return groups
}

function collectSecrets(
  settings: Record<string, unknown>,
  categories: Set<SettingsSecretCategory>
): PortableSecrets {
  const secrets: PortableSecrets = {}
  if (categories.has('providers')) {
    const providerTokens = collectProviderTokens(settings)
    if (Object.keys(providerTokens).length) secrets.providerTokens = providerTokens
  }
  if (categories.has('summary')) {
    const keys: Record<string, string> = {}
    if (Array.isArray(settings.summaryProfiles)) {
      for (const item of settings.summaryProfiles as unknown[]) {
        const profile = asRecord(item)
        if (!profile || typeof profile.id !== 'string') continue
        const key = decryptStoredSecret(profile, 'keyEnc', 'keyPlain')
        if (key) keys[profile.id] = key
      }
    }
    if (Object.keys(keys).length) secrets.summaryProfileKeys = keys
    const legacy = decryptStoredSecret(settings, 'apiKeyEnc', 'apiKeyPlain')
    if (legacy) secrets.legacySummaryKey = legacy
  }
  if (categories.has('translation')) {
    const value = decryptStoredSecret(settings, 'baiduSecretEnc', 'baiduSecretPlain')
    if (value) secrets.baiduSecret = value
  }
  if (categories.has('usage')) {
    const value = decryptStoredSecret(settings, 'deepseekApiKeyEnc', 'deepseekApiKeyPlain')
    if (value) secrets.deepseekApiKey = value
  }
  return secrets
}

function encryptSecrets(
  secrets: PortableSecrets,
  categories: SettingsSecretCategory[],
  passphrase: string
): EncryptedSettingsSecrets {
  if (passphrase.length < 8) throw new Error('备份密码至少需要 8 个字符。')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final()
  ])
  return {
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    categories
  }
}

function decryptSecrets(envelope: EncryptedSettingsSecrets, passphrase: string): PortableSecrets {
  if (!passphrase) throw new Error('该备份包含敏感凭据，请输入备份密码。')
  if (envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') {
    throw new Error('不支持的凭据加密格式。')
  }
  try {
    const salt = Buffer.from(envelope.salt, 'base64')
    const iv = Buffer.from(envelope.iv, 'base64')
    const key = scryptSync(passphrase, salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8')
    const parsed: unknown = JSON.parse(plaintext)
    const record = asRecord(parsed)
    if (!record) throw new Error('invalid payload')
    return record as PortableSecrets
  } catch {
    throw new Error('备份密码错误，或敏感凭据数据已损坏。')
  }
}

function mergeProviderTokens(
  merged: Record<string, unknown>,
  current: Record<string, unknown>,
  secrets?: PortableSecrets
): void {
  for (const field of ['providers', 'wslProviders']) {
    if (!Array.isArray(merged[field])) continue
    const currentTokens = collectProviderTokens(current)[field] ?? {}
    const importedTokens = secrets?.providerTokens?.[field] ?? {}
    merged[field] = (merged[field] as unknown[]).map((item) => {
      const provider = asRecord(item)
      if (!provider || typeof provider.id !== 'string') return item
      return { ...provider, token: importedTokens[provider.id] ?? currentTokens[provider.id] ?? '' }
    })
  }
}

function mergeSummarySecrets(
  merged: Record<string, unknown>,
  current: Record<string, unknown>,
  secrets?: PortableSecrets
): void {
  const currentProfiles = new Map<string, Record<string, unknown>>()
  if (Array.isArray(current.summaryProfiles)) {
    for (const item of current.summaryProfiles as unknown[]) {
      const profile = asRecord(item)
      if (profile && typeof profile.id === 'string') currentProfiles.set(profile.id, profile)
    }
  }
  if (Array.isArray(merged.summaryProfiles)) {
    merged.summaryProfiles = merged.summaryProfiles.map((item) => {
      const profile = asRecord(item)
      if (!profile || typeof profile.id !== 'string') return item
      const next = { ...profile }
      const imported = secrets?.summaryProfileKeys?.[profile.id]
      if (imported) {
        const encoded = encodeStoredSecret(imported)
        if (encoded.enc) next.keyEnc = encoded.enc
        if (encoded.plain) next.keyPlain = encoded.plain
      } else {
        const previous = currentProfiles.get(profile.id)
        if (typeof previous?.keyEnc === 'string') next.keyEnc = previous.keyEnc
        else if (typeof previous?.keyPlain === 'string') next.keyPlain = previous.keyPlain
      }
      return next
    })
  }

  const applyTopLevel = (value: string | undefined, encKey: string, plainKey: string): void => {
    if (!value) return
    delete merged[encKey]
    delete merged[plainKey]
    const encoded = encodeStoredSecret(value)
    if (encoded.enc) merged[encKey] = encoded.enc
    if (encoded.plain) merged[plainKey] = encoded.plain
  }
  applyTopLevel(secrets?.legacySummaryKey, 'apiKeyEnc', 'apiKeyPlain')
  applyTopLevel(secrets?.baiduSecret, 'baiduSecretEnc', 'baiduSecretPlain')
  applyTopLevel(secrets?.deepseekApiKey, 'deepseekApiKeyEnc', 'deepseekApiKeyPlain')
}

export function createPortableSettingsBackup(options: SettingsExportOptions = {}): SettingsBackup {
  const current = getSettingsSnapshot()
  const categories = [...new Set(options.secretCategories ?? [])]
  const backup: SettingsBackup = {
    format: 'tran-portable-settings',
    version: 2,
    exportedAt: new Date().toISOString(),
    settings: sanitizeSettings(current),
    ...(options.ui ? { ui: options.ui } : {})
  }
  if (categories.length) {
    backup.encryptedSecrets = encryptSecrets(
      collectSecrets(current, new Set(categories)),
      categories,
      options.passphrase ?? ''
    )
  }
  return backup
}

export function applyPortableSettingsBackup(request: SettingsImportRequest): SettingsImportResult {
  const { backup } = request
  if (!backup || (backup.version !== 1 && backup.version !== 2)) {
    throw new Error('不是有效的 Tran 设置备份。')
  }
  if (backup.version === 1) {
    if (!backup.settings || typeof backup.settings !== 'object') throw new Error('不是有效的 Tran 设置备份。')
    replaceSettingsSnapshot(backup.settings)
    return {
      ui: backup.appearance ? { appearance: backup.appearance } : undefined,
      importedSecretCategories: [],
      legacy: true
    }
  }
  if (backup.format !== 'tran-portable-settings' || !asRecord(backup.settings)) {
    throw new Error('不是有效的 Tran 设置备份。')
  }
  const secrets = backup.encryptedSecrets
    ? decryptSecrets(backup.encryptedSecrets, request.passphrase ?? '')
    : undefined
  const current = getSettingsSnapshot()
  const merged = { ...current, ...sanitizeSettings(backup.settings) }
  mergeProviderTokens(merged, current, secrets)
  mergeSummarySecrets(merged, current, secrets)
  replaceSettingsSnapshot(merged)
  return {
    ui: backup.ui,
    importedSecretCategories: backup.encryptedSecrets?.categories ?? [],
    legacy: false
  }
}
