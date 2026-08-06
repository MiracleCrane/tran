import { app, safeStorage } from 'electron'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'
import type {
  Provider,
  Project,
  EffortLevel,
  PermissionMode,
  ComposerModel,
  ClaudeExecutionBackend,
  AgentBackendId,
  TranslateEngine,
  ThinkingTranslateEngine,
  SummaryProfile
} from '../shared/ipc'
import { AGENT_BACKEND_IDS } from '../shared/agentBackends'
import { normalizeCwdForCompare } from '../shared/paths'

const SETTINGS_SCHEMA_VERSION = 1
const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'high', 'max'])
const PERMISSION_MODES = new Set<PermissionMode>([
  'default',
  'plan',
  'auto',
  'yolo'
])
const CLAUDE_BACKENDS = new Set<ClaudeExecutionBackend>(['windows', 'wsl'])
const TRANSLATE_ENGINES = new Set<TranslateEngine>(['llm', 'baidu'])
const THINKING_TRANSLATE_ENGINES = new Set<ThinkingTranslateEngine>(['follow', 'auto', 'llm', 'baidu'])

/** 落盘形态：key 逐条加密，与顶层 apiKeyEnc/apiKeyPlain 同一套约定。 */
interface StoredSummaryProfile {
  id: string
  name: string
  baseUrl: string
  model?: string
  /** base64 of safeStorage-encrypted key */
  keyEnc?: string
  /** plaintext fallback when safeStorage is unavailable */
  keyPlain?: string
}

interface PersistedSettings {
  /** Settings schema version for migrations/normalization. */
  schemaVersion?: number
  /** base64 of safeStorage-encrypted bytes */
  apiKeyEnc?: string
  /** plaintext fallback when safeStorage is unavailable */
  apiKeyPlain?: string
  /** Saved API providers (client-side only). The active one is applied at spawn. */
  providers?: Provider[]
  /** id of the active provider; null/undefined = none active. */
  activeProviderId?: string | null
  /** Saved API providers used when the Claude runtime backend is WSL. */
  wslProviders?: Provider[]
  /** id of the active WSL provider; null/undefined = none active. */
  wslActiveProviderId?: string | null
  /** Saved working directories shown in the sidebar project switcher. */
  projects?: Project[]
  /** Last-used project path (auto-entered on app start). */
  lastProjectPath?: string
  /** Preferences managed by the Settings panel. */
  agentBackend?: AgentBackendId
  defaultEffort?: EffortLevel
  defaultPermissionMode?: PermissionMode
  /** Gate for all WSL-facing UI and WSL backend features. */
  wslSupportEnabled?: boolean
  claudeExecutionBackend?: ClaudeExecutionBackend
  /** Composer model list used by the Windows Claude backend. */
  composerModels?: ComposerModel[]
  /** Composer model list used by the WSL Claude backend. */
  wslComposerModels?: ComposerModel[]
  /** Composer model list used by the Codex app-server backend. */
  codexComposerModels?: ComposerModel[]
  /** Composer model list used by the Hermes ACP backend. */
  hermesComposerModels?: ComposerModel[]
  /** Experimental Windows-only GPU toggle (ANGLE Vulkan backend). */
  vulkanBackend?: boolean
  /** Close window → hide to system tray instead of quitting (persisted after
   *  the user picks once on first close). */
  minimizeToTray?: boolean
  /** 启动时最大化主窗口（默认关）。 */
  startMaximized?: boolean
  /** User has already answered the first-close prompt (don't ask again). */
  closePromptDismissed?: boolean
  /** AI 自动命名（会话短标题，云端生成；默认开，关闭后任何路径不调 API）。 */
  aiNamingEnabled?: boolean
  /** 云端套餐额度查询（默认开）。走 api.kimi.com 私有接口 + CLI OAuth 凭证，
   *  关闭后 usageService 不再发任何云端请求（含 token 刷新）。 */
  cloudUsageEnabled?: boolean
  /** 后台任务收尾后自动催模型更新待办（**默认关**）。这会发一次完整的 turn，
   *  要把整个会话上下文重新过一遍——实测约 88k token，是命名那类小请求的七百倍。
   *  而且下一条真实消息本来就会让 AI 收到完成通知，所以它买到的只是「提前」。 */
  autoTodoNudge?: boolean
  /** 总结类杂活（会话命名、命令说明、思考摘要…）用的型号。空 = 用
   *  cheapModel.DEFAULT_CHEAP_MODEL。别写死猜测的型号——设置页有探测按钮。 */
  summaryModel?: string
  /** 摘要类请求是否**开启**模型思考（默认关）。
   *
   *  这些任务是 12/16 字的短摘要，推理帮不上忙却极烧额度——实测火山方舟上的
   *  GLM-5.2 回一条 12 字命令说明，开思考要多花 762 个推理 token，关掉是 0，
   *  而两边答案质量一样。免费额度是按 token 算的（推理 token 也算），差 700 倍。
   *  留成开关是因为将来某些模型可能确实需要推理才答得准。 */
  summaryThinkingEnabled?: boolean
  /** 总结类请求使用的 OpenAI 兼容 API 根地址。
   *  **旧字段**：已被 summaryProfiles 取代，仅用于首次启动时迁移出第一条配置。 */
  summaryApiBaseUrl?: string
  /** 多套摘要 API 配置（见 shared/ipc 的 SummaryProfile）。换服务商不再覆盖旧的。 */
  summaryProfiles?: StoredSummaryProfile[]
  /** 当前激活的那套；指向不存在的 id 时回落到第一条。 */
  activeSummaryProfileId?: string
  /** Show OS native notifications when a session ends while window is inactive
   *  (default true). */
  nativeNotifications?: boolean
  /** --- Translate engine config (Translate panel) --- */
  /** 翻译引擎（技能/插件描述；思考块默认也跟随它）。
   *
   *  思考块可以单独指定（见下面的 thinkingTranslateEngine），但**默认跟随这一个**。
   *  曾经强制拆成两个开关，理由是取舍相反——描述是短句机翻够用，思考满篇路径/
   *  变量名/命令/报错原文会被机翻译坏。接入 GLM-4.7-Flash 之后这个矛盾消失了：
   *  它免费且两类都做得好，多数人不需要配两套。所以改成"默认合并、需要时可拆"。 */
  translateEngine?: TranslateEngine
  /** 思考块全文翻译的引擎。缺省 'follow' = 跟随上面的 translateEngine，不单独配置。 */
  thinkingTranslateEngine?: ThinkingTranslateEngine
  /** Baidu app id (non-secret). */
  baiduAppId?: string
  /** base64 of safeStorage-encrypted Baidu secret key. */
  baiduSecretEnc?: string
  /** plaintext fallback when safeStorage is unavailable. */
  baiduSecretPlain?: string
  /** base64 of safeStorage-encrypted DeepSeek API key（用量卡查余额用）。 */
  deepseekApiKeyEnc?: string
  /** plaintext fallback when safeStorage is unavailable. */
  deepseekApiKeyPlain?: string
}

let cache: PersistedSettings | null = null
let cacheMtimeMs: number | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'tran-settings.json')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeProvider(value: unknown): Provider | null {
  const provider = asRecord(value)
  if (!provider) return null
  const id = optionalString(provider.id)?.trim()
  if (!id) return null
  const authType = provider.authType === 'apikey' ? 'apikey' : 'bearer'
  return {
    id,
    name: optionalString(provider.name) ?? '',
    baseUrl: optionalString(provider.baseUrl) ?? 'https://api.anthropic.com',
    token: optionalString(provider.token) ?? '',
    authType,
    model: optionalString(provider.model) ?? 'kimi-default'
  }
}

function normalizeProviders(value: unknown): Provider[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const providers: Provider[] = []
  for (const item of value) {
    const provider = normalizeProvider(item)
    if (!provider || seen.has(provider.id)) continue
    seen.add(provider.id)
    providers.push(provider)
  }
  return providers
}

function normalizeActiveProviderId(value: unknown, providers?: Provider[]): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  if (!providers || providers.some((provider) => provider.id === value)) return value
  return providers[0]?.id ?? null
}

function normalizeSummaryProfile(value: unknown): StoredSummaryProfile | null {
  const raw = asRecord(value)
  if (!raw) return null
  const id = optionalString(raw.id)?.trim()
  const baseUrl = optionalString(raw.baseUrl)?.trim()
  if (!id || !baseUrl) return null
  const out: StoredSummaryProfile = {
    id,
    name: optionalString(raw.name)?.trim() || baseUrl,
    baseUrl
  }
  const model = optionalString(raw.model)?.trim()
  if (model) out.model = model
  const keyEnc = optionalString(raw.keyEnc)
  const keyPlain = optionalString(raw.keyPlain)
  if (keyEnc) out.keyEnc = keyEnc
  else if (keyPlain) out.keyPlain = keyPlain
  return out
}

function normalizeSummaryProfiles(value: unknown): StoredSummaryProfile[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const out: StoredSummaryProfile[] = []
  for (const item of value) {
    const p = normalizeSummaryProfile(item)
    if (!p || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

function normalizeProject(value: unknown): Project | null {
  const project = asRecord(value)
  if (!project) return null
  const path = optionalString(project.path)?.trim()
  if (!path) return null
  return {
    path,
    name: optionalString(project.name) ?? path,
    addedAt: typeof project.addedAt === 'number' && Number.isFinite(project.addedAt)
      ? project.addedAt
      : Date.now()
  }
}

function normalizeProjects(value: unknown): Project[] | undefined {
  if (!Array.isArray(value)) return undefined
  // #42 去重键用归一化形式：历史设置里同一目录可能同时存在正/反斜杠两条。
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const item of value) {
    const project = normalizeProject(item)
    if (!project) continue
    const key = normalizeCwdForCompare(project.path)
    if (seen.has(key)) continue
    seen.add(key)
    projects.push(project)
  }
  return projects
}

function normalizeComposerModel(value: unknown): ComposerModel | null {
  const model = asRecord(value)
  if (!model) return null
  const id = optionalString(model.id)?.trim()
  if (!id) return null
  return {
    id,
    label: optionalString(model.label)?.trim() || id
  }
}

function normalizeComposerModels(value: unknown): ComposerModel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const models: ComposerModel[] = []
  for (const item of value) {
    const model = normalizeComposerModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

function normalizeSettings(raw: unknown): PersistedSettings {
  const source = asRecord(raw) ?? {}
  const settings: PersistedSettings = {
    ...(source as PersistedSettings),
    schemaVersion: SETTINGS_SCHEMA_VERSION
  }

  settings.apiKeyEnc = optionalString(source.apiKeyEnc)
  settings.apiKeyPlain = optionalString(source.apiKeyPlain)
  settings.baiduAppId = optionalString(source.baiduAppId)
  settings.baiduSecretEnc = optionalString(source.baiduSecretEnc)
  settings.baiduSecretPlain = optionalString(source.baiduSecretPlain)
  settings.deepseekApiKeyEnc = optionalString(source.deepseekApiKeyEnc)
  settings.deepseekApiKeyPlain = optionalString(source.deepseekApiKeyPlain)
  settings.lastProjectPath = optionalString(source.lastProjectPath)

  settings.providers = normalizeProviders(source.providers)
  settings.activeProviderId = normalizeActiveProviderId(source.activeProviderId, settings.providers)
  settings.wslProviders = normalizeProviders(source.wslProviders)
  settings.wslActiveProviderId = normalizeActiveProviderId(source.wslActiveProviderId, settings.wslProviders)
  settings.projects = normalizeProjects(source.projects)

  settings.agentBackend = AGENT_BACKEND_IDS.includes(source.agentBackend as AgentBackendId)
    ? source.agentBackend as AgentBackendId
    : undefined
  settings.defaultEffort = EFFORT_LEVELS.has(source.defaultEffort as EffortLevel)
    ? source.defaultEffort as EffortLevel
    : undefined
  settings.defaultPermissionMode = PERMISSION_MODES.has(source.defaultPermissionMode as PermissionMode)
    ? source.defaultPermissionMode as PermissionMode
    : undefined
  settings.claudeExecutionBackend = CLAUDE_BACKENDS.has(source.claudeExecutionBackend as ClaudeExecutionBackend)
    ? source.claudeExecutionBackend as ClaudeExecutionBackend
    : undefined
  settings.translateEngine = TRANSLATE_ENGINES.has(source.translateEngine as TranslateEngine)
    ? source.translateEngine as TranslateEngine
    : undefined
  settings.thinkingTranslateEngine = THINKING_TRANSLATE_ENGINES.has(
    source.thinkingTranslateEngine as ThinkingTranslateEngine
  )
    ? (source.thinkingTranslateEngine as ThinkingTranslateEngine)
    : undefined

  settings.wslSupportEnabled = optionalBoolean(source.wslSupportEnabled)
  settings.vulkanBackend = optionalBoolean(source.vulkanBackend)
  settings.minimizeToTray = optionalBoolean(source.minimizeToTray)
  settings.startMaximized = optionalBoolean(source.startMaximized)
  settings.closePromptDismissed = optionalBoolean(source.closePromptDismissed)
  settings.aiNamingEnabled = optionalBoolean(source.aiNamingEnabled)
  settings.cloudUsageEnabled = optionalBoolean(source.cloudUsageEnabled)
  settings.autoTodoNudge = optionalBoolean(source.autoTodoNudge)
  settings.summaryModel = optionalString(source.summaryModel)
  settings.summaryApiBaseUrl = optionalString(source.summaryApiBaseUrl)
  settings.summaryThinkingEnabled = optionalBoolean(source.summaryThinkingEnabled)
  settings.summaryProfiles = normalizeSummaryProfiles(source.summaryProfiles)
  settings.activeSummaryProfileId = optionalString(source.activeSummaryProfileId)
  settings.nativeNotifications = optionalBoolean(source.nativeNotifications)

  settings.composerModels = normalizeComposerModels(source.composerModels)
  settings.wslComposerModels = normalizeComposerModels(source.wslComposerModels)
  settings.codexComposerModels = normalizeComposerModels(source.codexComposerModels)
  settings.hermesComposerModels = normalizeComposerModels(source.hermesComposerModels)

  return settings
}

function settingsChanged(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) !== JSON.stringify(b)
  } catch {
    return true
  }
}

function writeSettingsFile(path: string, settings: PersistedSettings): void {
  writeJsonAtomic(path, settings)
}

/**
 * 读取失败时禁止落盘：底下压着的可能是完好的设置（providers / projects /
 * apiKey / 百度密钥）。读失败在 Windows 上很常见——杀软、备份、索引程序会
 * 临时占用文件（EBUSY/EPERM）。此前这里不区分「读不到」和「文件损坏」，
 * 一律退回空默认值并写进 cache，用户随后改任意一项设置就会把空 cache
 * 覆写回真实文件，导致永久丢失。
 */
let loadFailed = false

function load(): PersistedSettings {
  const path = settingsPath()
  const mtimeMs = readMtimeMs(path)
  if (cache && cacheMtimeMs === mtimeMs && !loadFailed) return cache

  const result = readJsonSafe(path)
  if (result.status === 'failed') {
    // 内存里给出可用的默认值，但打上标记：save() 不会落盘，避免覆写。
    log('settings', `读取失败，本次不落盘以免覆写：${result.error.message}`)
    loadFailed = true
    cache = normalizeSettings({})
    cacheMtimeMs = mtimeMs
    return cache
  }

  loadFailed = false
  const raw: unknown = result.status === 'ok' ? result.value : {}
  cache = normalizeSettings(raw)
  if (result.status === 'ok' && settingsChanged(raw, cache)) {
    try {
      writeSettingsFile(path, cache)
    } catch {
      /* 规范化回写是尽力而为 */
    }
  }
  cacheMtimeMs = readMtimeMs(path)
  return cache
}

function save(s: PersistedSettings): void {
  const path = settingsPath()
  if (loadFailed) {
    // 上次读取失败，当前 cache 是空默认值而非真实设置——落盘会抹掉磁盘上的
    // 真数据。先重试读取，恢复成功再写，否则放弃本次持久化。
    const retry = readJsonSafe(path)
    if (retry.status === 'failed') {
      log('settings', '设置读取仍失败，跳过本次保存以保护磁盘上的数据')
      cache = normalizeSettings(s)
      return
    }
    loadFailed = false
    // 把本次改动合并到磁盘上的真实设置之上，而不是空默认值之上。
    const disk = normalizeSettings(retry.status === 'ok' ? retry.value : {})
    s = { ...disk, ...s }
  }
  cache = normalizeSettings(s)
  try {
    writeSettingsFile(path, cache)
    cacheMtimeMs = readMtimeMs(path)
  } catch {
    /* best-effort persistence */
  }
}

export function getSettingsFilePath(): string {
  return settingsPath()
}

/** Read the full persisted settings (cached). Used by providers.ts. */
export function loadSettings(): PersistedSettings {
  return load()
}

/** Write the full persisted settings (updates the cache). Used by providers.ts. */
export function saveSettings(s: PersistedSettings): void {
  save(s)
}

export function getSettingsSnapshot(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(load())) as Record<string, unknown>
}

export function replaceSettingsSnapshot(snapshot: Record<string, unknown>): void {
  save({ ...snapshot } as PersistedSettings)
}

const DEFAULT_SUMMARY_BASE_URL = 'https://api.deepseek.com'

function decryptProfileKey(p: StoredSummaryProfile): string | null {
  if (p.keyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(p.keyEnc, 'base64'))
    } catch {
      return null
    }
  }
  return p.keyPlain ?? null
}

/**
 * 读出全部配置；首次运行时从**旧的单份配置**迁移出第一条。
 *
 * 迁移刻意不删旧字段：万一用户回退到旧版本，那边还得靠 summaryApiBaseUrl /
 * apiKeyEnc 工作。多留几个字节换一条退路。
 */
function loadSummaryProfiles(): StoredSummaryProfile[] {
  const s = load()
  if (s.summaryProfiles && s.summaryProfiles.length > 0) return s.summaryProfiles

  const legacyBase = s.summaryApiBaseUrl?.trim()
  // 连 baseUrl 和 key 都没有 = 从没配过，不必凭空造一条。
  if (!legacyBase && !s.apiKeyEnc && !s.apiKeyPlain) return []

  const migrated: StoredSummaryProfile = {
    id: 'legacy',
    name: legacyBase && !/deepseek\.com/i.test(legacyBase) ? legacyBase : 'DeepSeek',
    baseUrl: legacyBase || DEFAULT_SUMMARY_BASE_URL
  }
  if (s.summaryModel?.trim()) migrated.model = s.summaryModel.trim()
  if (s.apiKeyEnc) migrated.keyEnc = s.apiKeyEnc
  else if (s.apiKeyPlain) migrated.keyPlain = s.apiKeyPlain
  return [migrated]
}

function persistSummaryProfiles(profiles: StoredSummaryProfile[], activeId?: string): void {
  const s = load()
  s.summaryProfiles = profiles
  if (activeId !== undefined) s.activeSummaryProfileId = activeId
  save(s)
}

/** 当前激活的那套；id 失效时回落到第一条（而不是让整条链路失灵）。 */
export function getActiveSummaryProfile(): StoredSummaryProfile | null {
  const profiles = loadSummaryProfiles()
  if (profiles.length === 0) return null
  const id = load().activeSummaryProfileId
  return profiles.find((p) => p.id === id) ?? profiles[0]
}

function maskKey(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

/** 渲染层用的列表：key 只回掩码，明文绝不下发（与 getApiKey 的既有约定一致）。 */
export function listSummaryProfiles(): { profiles: SummaryProfile[]; activeId: string | null } {
  const stored = loadSummaryProfiles()
  return {
    profiles: stored.map((p) => {
      const key = decryptProfileKey(p)
      const out: SummaryProfile = { id: p.id, name: p.name, baseUrl: p.baseUrl, model: p.model ?? '' }
      if (key) out.keyMasked = maskKey(key)
      return out
    }),
    activeId: getActiveSummaryProfile()?.id ?? null
  }
}

/** 新增或更新一套配置。key 传 undefined/null = 保留原有，传空串 = 清除。 */
export function upsertSummaryProfile(
  profile: SummaryProfile,
  key?: string | null
): { profiles: SummaryProfile[]; activeId: string | null } {
  const profiles = loadSummaryProfiles()
  const idx = profiles.findIndex((p) => p.id === profile.id)
  const prev = idx >= 0 ? profiles[idx] : undefined
  const next: StoredSummaryProfile = {
    id: profile.id,
    name: profile.name.trim() || profile.baseUrl,
    baseUrl: profile.baseUrl.trim() || DEFAULT_SUMMARY_BASE_URL
  }
  if (profile.model?.trim()) next.model = profile.model.trim()

  // key 没传就沿用旧值——改个名字或型号不该把 Key 冲掉。
  if (key === undefined || key === null) {
    if (prev?.keyEnc) next.keyEnc = prev.keyEnc
    else if (prev?.keyPlain) next.keyPlain = prev.keyPlain
  } else if (key) {
    if (safeStorage.isEncryptionAvailable()) next.keyEnc = safeStorage.encryptString(key).toString('base64')
    else next.keyPlain = key
  }

  if (idx >= 0) profiles[idx] = next
  else profiles.push(next)
  // 第一条自动激活，否则用户新增完还得再点一下才生效。
  const activeId = load().activeSummaryProfileId ?? (profiles.length === 1 ? next.id : undefined)
  persistSummaryProfiles(profiles, activeId)
  return listSummaryProfiles()
}

export function deleteSummaryProfile(id: string): { profiles: SummaryProfile[]; activeId: string | null } {
  const profiles = loadSummaryProfiles().filter((p) => p.id !== id)
  const current = load().activeSummaryProfileId
  persistSummaryProfiles(profiles, current === id ? profiles[0]?.id : current)
  return listSummaryProfiles()
}

export function setActiveSummaryProfile(id: string): { profiles: SummaryProfile[]; activeId: string | null } {
  const profiles = loadSummaryProfiles()
  if (profiles.some((p) => p.id === id)) persistSummaryProfiles(profiles, id)
  return listSummaryProfiles()
}

export function getApiKey(): string | null {
  // 优先用激活的那套配置；没有配置时回落到旧的单份字段。
  const active = getActiveSummaryProfile()
  if (active) return decryptProfileKey(active)
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

/** Read the saved Baidu translate secret key (decrypted). Mirrors getApiKey. */
export function getBaiduSecret(): string | null {
  const s = load()
  if (s.baiduSecretEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.baiduSecretEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.baiduSecretPlain ?? null
}

/** Persist the Baidu translate secret key (encrypted when safeStorage is up).
 *  Pass null/empty to clear. Mirrors setApiKey. */
export function setBaiduSecret(key: string | null): void {
  const s = load()
  if (key && safeStorage.isEncryptionAvailable()) {
    s.baiduSecretEnc = safeStorage.encryptString(key).toString('base64')
    delete s.baiduSecretPlain
  } else if (key) {
    s.baiduSecretPlain = key
    delete s.baiduSecretEnc
  } else {
    delete s.baiduSecretEnc
    delete s.baiduSecretPlain
  }
  save(s)
}

/** Read the saved DeepSeek API key (decrypted). Mirrors getApiKey. */
export function getDeepseekApiKey(): string | null {
  const s = load()
  if (s.deepseekApiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.deepseekApiKeyEnc, 'base64'))
    } catch {
      return null
    }
  }
  return s.deepseekApiKeyPlain ?? null
}

/** Persist the DeepSeek API key (encrypted when safeStorage is up).
 *  Pass null/empty to clear. Mirrors setApiKey. */
export function setDeepseekApiKey(key: string | null): void {
  const s = load()
  if (key && safeStorage.isEncryptionAvailable()) {
    s.deepseekApiKeyEnc = safeStorage.encryptString(key).toString('base64')
    delete s.deepseekApiKeyPlain
  } else if (key) {
    s.deepseekApiKeyPlain = key
    delete s.deepseekApiKeyEnc
  } else {
    delete s.deepseekApiKeyEnc
    delete s.deepseekApiKeyPlain
  }
  save(s)
}
