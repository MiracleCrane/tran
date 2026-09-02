import { app, ipcMain, dialog, shell, clipboard, nativeImage, net, screen, Notification, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat as statAsync, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { AgentBridge } from './agent/AgentBridge'
import { AGENT_BACKENDS } from '../shared/agentBackends'
import {
  getApiKey,
  setApiKey,
  getDeepseekApiKey,
  setDeepseekApiKey,
  loadSettings,
  saveSettings,
  listSummaryProfiles,
  upsertSummaryProfile,
  deleteSummaryProfile,
  setActiveSummaryProfile
} from './settings'
import { saveMcpServer, deleteMcpServer } from './mcpConfig'
import {
  startBrowserBridge,
  stopBrowserBridge,
  getBrowserBridgeStatus,
  callBrowserTool,
  tokenFilePath
} from './browserBridge'
import {
  registerMcpBrowserServer,
  registerMcpDesktopServer,
  unregisterMcpServer
} from './mcpBrowserRegistration'
import { setOverlayTargetDisplay, stopControlOverlay } from './controlOverlay'
import { launchScreenAssist } from './screenAssist'
import { launchXhh } from './xhh'
import { launchXtw } from './xtw'
import { configureRpTavern, getRpTavernStatus, openRpTavern } from './rpTavern'
import {
  listProviders,
  getActiveProvider,
  saveProvider,
  deleteProvider,
  setActiveProvider,
  getProviderProfiles,
  saveProviderForBackend,
  deleteProviderForBackend,
  setActiveProviderForBackend,
  saveComposerModelsProfile,
  watchProviderConfigFiles
} from './providers'
import {
  listProjects,
  addProject,
  removeProject,
  renameProject,
  updateProject,
  reorderProjects,
  setLastProject,
  getStartupProject
} from './projects'
import { translateTexts } from './translate'
import { scanSkillsForCwd } from './skillsScan'
import { getTranslateConfig, saveTranslateConfig, testTranslate } from './translateConfig'
import { getPreferences, savePreferences } from './preferences'
import { applyPetWindowPrefs } from './petWindow'
import { DEFAULT_AGENT_BACKEND_ID, normalizeAgentBackend } from '../shared/agentBackends'
import {
  getDiagnosticLog,
  getRuntimeStatus,
  buildDiagnosticReport,
  repairWslEnvironment,
  runWslHealthCheck
} from './runtimeDiagnostics'
import { applyPortableSettingsBackup, createPortableSettingsBackup } from './portableSettingsBackup'
import { checkForUpdates, downloadAndInstallUpdate } from './updater'
import { checkKimiVersion, upgradeKimi } from './kimiVersion'
import { probeCheapModels, diagnoseSummaryPrompt, onSummaryIssue } from './cheapModel'
import { explainCommand, explainEdit, summarizeActivityGroup, summarizeThinking, translateThinking } from './cheapNotes'
import { fetchSessionTodos } from './kimiTodos'
import { getPlanUsageCached } from './usageService'
import { getDeepseekBalanceCached, invalidateDeepseekBalanceCache } from './deepseekService'
import { disposeKimiHistoryClient, listKimiSessions } from './kimiHistory'
import { matchProjectByCwd } from '../shared/projectMatch'
import { deleteClaudeSession, listClaudeSessions, readClaudeSessionMessages } from './claudeHistory'
import { deleteKimiSession } from './sessionDelete'
import { markSessionDeleted } from './deletedSessions'
import { removeSessionTitle, recordManualTitle } from './sessionTitles'
import {
  archiveSession,
  dropArchivedSession,
  getArchivedSessions,
  unarchiveSession
} from './archivedSessions'
import {
  clearSessionProjectAssignment,
  dropSessionProjectAssignment,
  getSessionProjectAssignments,
  setSessionProjectAssignment
} from './sessionProjects'
import { allAiTitles, generateAiTitlesBatch, getSessionPreview } from './aiTitles'
import { ensureScratchDir, getScratchRoots } from './scratchDirs'
import {
  bindWorktreeSession,
  createWorktreeRecord,
  listWorktreeRecords,
  removeWorktreeRecord
} from './worktreeStore'
import { getSessionTasks } from './kimiServerApi'
import type { GoalControlAction, GoalStartOptions } from './goalStore'
import * as gitModule from './git'
import { log } from './logger'
import type {
  StartSessionOptions,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SessionListItem,
  SessionListOptions,
  SessionRunningChangedPayload,
  StartSessionResult,
  HistoryMessage,
  SaveMcpServerArgs,
  DeleteMcpServerArgs,
  Provider,
  Project,
  ProjectPatch,
  SkillInfo,
  MarketplacePlugin,
  Preferences,
  PickedFile,
  PickedDirectoryEntry,
  TranslateConfig,
  TranslateTestResult,
  ClaudeExecutionBackend,
  ProviderBackend,
  ProviderProfile,
  ProviderProfiles,
  RuntimeStatus,
  SettingsBackup,
  SettingsExportOptions,
  SettingsImportRequest,
  SettingsImportResult,
  WslHealthReport,
  ComposerModel,
  PickDirectoryOptions,
  UpdateCheckResult,
  UpdateDownloadOptions,
  UpdateDownloadProgress,
  UpdateInstallResult,
  AgentBackendInfo,
  AgentBackendId,
  DiagnosticReportOptions,
  DiagnosticReportResult,
  SessionUsageInfo,
  AiTitlesBatchResult,
  SessionPreview,
  SaveImageResult,
  KimiVersionInfo,
  KimiUpgradeResult,
  SummaryModelProbe,
  PromptDiagnosis,
  SessionTodosResult,
  SessionTodosFetch,
  PlanUsageResult,
  BrowserBridgeStatus,
  BrowserToolResult,
  ControlPluginsState,
  DisplayInfo,
  DeepseekBalanceResult,
  SummaryProfile
} from '../shared/ipc'

/** DeepSeek key 状态回传：完整明文不出主进程，只给掩码（对齐 forge:getApiKey）。 */
function deepseekKeyStatus(): { configured: boolean; masked: string | null } {
  const key = getDeepseekApiKey()
  if (!key) return { configured: false, masked: null }
  const masked = key.length >= 12 ? `${key.slice(0, 4)}***${key.slice(-4)}` : '***'
  return { configured: true, masked }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'yml', 'yaml', 'csv', 'py',
  'java', 'c', 'cpp', 'cc', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'sh', 'bash',
  'sql', 'ini', 'toml', 'env', 'log', 'vue', 'svelte'
])
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
}
const MAX_TEXT_INLINE = 512 * 1024 // inline at most 512KB of a text file
/** 图片附件上限：整读进内存再 base64（膨胀 ~1.33 倍）且经 IPC 复制多份，
 *  不设上限一张巨图就能把主进程顶爆。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 300
/** 待办自动催更的最小间隔（同一会话）。见 forge:nudgeTodos。 */
const NUDGE_COOLDOWN_MS = 5 * 60_000
const lastNudgeAt = new Map<string, number>()
const PATH_PREVIEW_READ_TIMEOUT_MS = 4500

function withPathReadTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = PATH_PREVIEW_READ_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId)
  })
}

/** 校验来自渲染层的字符串入参。IPC 载荷不可全信（渲染层出 bug 或被注入时
 *  可能传 undefined/数字），直接 .trim() 会抛 TypeError。 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`invalid ${field}: expected string, got ${typeof value}`)
  }
  return value
}

function isNativeAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[/\\]{2}/.test(path)
}

function resolveNativePath(cwd: string, pathStr: string): string {
  if (isNativeAbsolutePath(pathStr)) return pathStr
  return resolve(cwd, pathStr)
}

async function readDirectoryEntries(path: string): Promise<{ entries: PickedDirectoryEntry[]; truncated: boolean }> {
  const dirents = await withPathReadTimeout(
    readdir(path, { withFileTypes: true }),
    `read directory ${path}`
  )
  const entries = (
    await Promise.all(
      dirents.map(async (dirent): Promise<PickedDirectoryEntry | null> => {
        const childPath = resolve(path, dirent.name)
        try {
          const entryStat = await withPathReadTimeout(
            statAsync(childPath),
            `stat directory entry ${childPath}`,
            1500
          )
          const isDirectory = entryStat.isDirectory()
          return {
            name: dirent.name,
            path: childPath,
            kind: isDirectory ? 'directory' : 'file',
            size: isDirectory ? 0 : entryStat.size,
            modifiedAt: entryStat.mtimeMs
          }
        } catch {
          return null
        }
      })
    )
  ).filter((entry): entry is PickedDirectoryEntry => entry !== null)
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return {
    entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES
  }
}

/** 读不进来的文件（超限/读失败/不是常规文件）回一个带 error 的失败占位条目，
 *  而不是从结果数组里悄悄消失——渲染层据此提示用户（PickedFile.error）。 */
function skippedPickedFile(path: string, reason: string): PickedFile {
  const name = basename(path)
  return {
    path,
    name,
    kind: 'other',
    mimeType: 'application/octet-stream',
    data: '',
    size: 0,
    error: `无法附加 ${name}：${reason}`
  }
}

async function readPickedFiles(cwd: string, paths: string[], source: string): Promise<PickedFile[]> {
  const out: PickedFile[] = []
  for (const rawPath of paths) {
    try {
      const p = resolveNativePath(cwd, rawPath)
      const stat = await withPathReadTimeout(statAsync(p), `stat ${p}`)
      if (stat.isDirectory()) {
        const { entries, truncated } = await readDirectoryEntries(p)
        out.push({
          path: p,
          name: basename(p),
          kind: 'directory',
          mimeType: 'application/x-directory',
          data: '',
          size: 0,
          entries,
          entriesTruncated: truncated
        })
        continue
      }
      if (!stat.isFile()) {
        log('ipc', `${source} skip ${p}: not a file or directory`)
        out.push(skippedPickedFile(p, '不是文件或目录'))
        continue
      }
      const ext = extname(p).slice(1).toLowerCase()
      const kind: PickedFile['kind'] = IMAGE_EXTS.has(ext)
        ? 'image'
        : TEXT_EXTS.has(ext)
          ? 'text'
          : 'other'
      let data = ''
      if (kind === 'image') {
        // 超限图片拒绝读取：走本函数统一的错误形态（记日志 + 回一个带 error
        // 的占位条目），错误消息为用户可读中文，会显示在输入区。
        if (stat.size > MAX_IMAGE_BYTES) {
          throw new Error(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
        }
        data = (await withPathReadTimeout(readFile(p), `read image ${p}`)).toString('base64')
      } else if (kind === 'text') {
        // 体积上限前置守卫：直接 readFile 会把整文件读进内存后才 slice，
        // 拖入几百 MB 的 .log/.csv 会造成内存尖峰甚至 OOM。超过内联上限的
        // 若干倍就拒读（正常文本附件远小于此；确需大文件另走文件引用）。
        const MAX_TEXT_FILE_BYTES = MAX_TEXT_INLINE * 8
        if (stat.size > MAX_TEXT_FILE_BYTES) {
          throw new Error(
            `文本文件超过 ${Math.floor(MAX_TEXT_FILE_BYTES / 1024 / 1024)}MB 上限（仅内联前 ${Math.floor(MAX_TEXT_INLINE / 1024)}KB 的小文件）`
          )
        }
        data = (await withPathReadTimeout(readFile(p, 'utf-8'), `read text ${p}`)).slice(0, MAX_TEXT_INLINE)
      }
      out.push({
        path: p,
        name: basename(p),
        kind,
        mimeType: MIME[ext] ?? 'application/octet-stream',
        data,
        size: stat.size
      })
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      log('ipc', `${source} skip ${rawPath}: ${reason}`)
      out.push(skippedPickedFile(rawPath, reason))
    }
  }
  return out
}

export function registerIpc(
  getMainWindow: () => BrowserWindow | null,
  getIsQuitting: () => boolean = () => false,
  setIsQuitting: (v: boolean) => void = () => undefined,
  getForgeTray: () => { setTooltip?: (text: string) => void } | null = () => null,
  armSkipNextCloseIntercept: () => void = () => undefined
): AgentBridge {
  const withWindow = (action: (win: BrowserWindow) => void): void => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    action(win)
  }

  const send = <T>(channel: string, payload: T): void => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      log('ipc', `send ${channel} SKIP (no window)`)
      return
    }
    try {
      win.webContents.send(channel, payload)
    } catch (e) {
      // Never let a forwarding failure propagate into the AgentBridge drain loop,
      // or it would terminate the session. Log and swallow.
      log('ipc', `send ${channel} THREW: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const stopProviderConfigWatch = watchProviderConfigFiles((reason) => {
    log('providers', `config changed: ${reason}`)
    send('forge:providers-changed', { reason })
  })
  app.once('before-quit', stopProviderConfigWatch)

  // 控制类插件按设置开关启用（开关本体 = mcp.json 注册/反注册 + 桥启停）：
  // - 浏览器控制默认开：起桥 + 注册 tran-browser；
  // - 桌面控制默认关：仅显式开启时注册 tran-desktop。
  // 关闭态在启动时也执行一次反注册（清理旧版本/上次开启留下的条目）。
  const notifyBridgeStatus = (status: BrowserBridgeStatus): void =>
    send('forge:browser-bridge-status', status)
  const applyBrowserControl = async (enabled: boolean): Promise<void> => {
    if (enabled) {
      await startBrowserBridge(notifyBridgeStatus)
      registerMcpBrowserServer(tokenFilePath())
    } else {
      stopBrowserBridge()
      unregisterMcpServer('tran-browser')
      notifyBridgeStatus(getBrowserBridgeStatus())
    }
  }
  const desktopDisplayIndex = (): number | null => {
    const s = loadSettings()
    return typeof s.desktopDisplayIndex === 'number' && s.desktopDisplayIndex >= 0
      ? s.desktopDisplayIndex
      : null
  }
  const applyDesktopControl = (enabled: boolean): void => {
    const displayIndex = desktopDisplayIndex()
    // 分屏控制：光晕也只打在划给 AI 的那块屏上——用户那块屏不该有任何干扰。
    // 桌面控制关掉时不限制：那块屏的选择只对桌面控制生效，浏览器控制的光晕
    // 不该跟着被关进一块屏里。
    setOverlayTargetDisplay(
      !enabled || displayIndex === null
        ? null
        : (screen.getAllDisplays()[displayIndex]?.id ?? null)
    )
    if (enabled) registerMcpDesktopServer(displayIndex, tokenFilePath())
    else unregisterMcpServer('tran-desktop')
  }
  {
    const s = loadSettings()
    void applyBrowserControl(s.browserControlEnabled !== false)
    applyDesktopControl(s.desktopControlEnabled === true)
  }
  app.once('before-quit', () => {
    stopBrowserBridge()
    stopControlOverlay()
  })

  ipcMain.handle('forge:listDisplays', async (): Promise<DisplayInfo[]> =>
    screen.getAllDisplays().map((d, index) => ({
      index,
      label: `显示器 ${index + 1}`,
      // 报物理分辨率而不是 Electron 的 DIP：设置里选屏时用户看的是"我那块
      // 3120x2080 的笔电屏"，报 1560x1040 会让人以为认错了屏。桌面控制进程
      // 也是按物理像素工作（PMv2），两边口径这样才一致。
      width: Math.round(d.bounds.width * d.scaleFactor),
      height: Math.round(d.bounds.height * d.scaleFactor),
      x: d.bounds.x,
      y: d.bounds.y,
      primary: d.id === screen.getPrimaryDisplay().id,
      scalePercent: Math.round(d.scaleFactor * 100)
    }))
  )
  ipcMain.handle(
    'forge:setDesktopDisplay',
    async (_e, displayIndex: number | null): Promise<void> => {
      const s = loadSettings()
      s.desktopDisplayIndex = displayIndex === null ? -1 : displayIndex
      saveSettings(s)
      applyDesktopControl(s.desktopControlEnabled === true)
    }
  )

  ipcMain.handle('forge:getControlPlugins', async (): Promise<ControlPluginsState> => {
    const s = loadSettings()
    return {
      browserEnabled: s.browserControlEnabled !== false,
      desktopEnabled: s.desktopControlEnabled === true,
      // 必须回传：不回的话设置页每次打开都把「分屏控制」画成「不限制」，
      // 而后台其实还锁在上次选的那块屏上，界面与实际状态对不上。
      desktopDisplayIndex: desktopDisplayIndex()
    }
  })
  ipcMain.handle(
    'forge:setControlPlugin',
    async (_e, plugin: 'browser' | 'desktop', enabled: boolean): Promise<ControlPluginsState> => {
      const s = loadSettings()
      if (plugin === 'browser') {
        s.browserControlEnabled = enabled !== false
        saveSettings(s)
        await applyBrowserControl(enabled !== false)
      } else if (plugin === 'desktop') {
        s.desktopControlEnabled = enabled === true
        saveSettings(s)
        applyDesktopControl(enabled === true)
      }
      const now = loadSettings()
      return {
        browserEnabled: now.browserControlEnabled !== false,
        desktopEnabled: now.desktopControlEnabled === true,
        desktopDisplayIndex: desktopDisplayIndex()
      }
    }
  )

  const bridge = new AgentBridge({
    onMessage: (sessionId, message) => {
      const event: AgentEvent = {
        type: 'agent:message',
        sessionId,
        message
      }
      send('forge:agent-event', event)
    },
    onEnded: (sessionId, error) => {
      const event: AgentEvent = { type: 'agent:ended', sessionId, error }
      send('forge:agent-event', event)

      // Native notification when a session ends and the window isn't focused,
      // so the user is alerted to long-running tasks completing in the background.
      const s = loadSettings()
      const notify = s.nativeNotifications !== false // default on
      if (notify && Notification.isSupported()) {
        const win = getMainWindow()
        const inactive = !win || win.isDestroyed() || !win.isFocused()
        if (inactive) {
          const n = new Notification({
            title: error ? 'Tran · 会话出错' : 'Tran · 会话完成',
            body: error ? `任务异常结束：${error}` : 'Agent 已完成当前任务',
            silent: false
          })
          n.on('click', () => {
            const w = getMainWindow()
            if (!w || w.isDestroyed()) return
            if (!w.isVisible()) w.show()
            if (w.isMinimized()) w.restore()
            w.focus()
          })
          n.show()
        }
      }
      getForgeTray()?.setTooltip?.('Tran')
    },
    onPermissionRequest: (req: PermissionRequestPayload) => {
      send('forge:permission-request', req)
    },
    onSessionsChanged: () => {
      send('forge:sessions-changed', {})
    },
    onSessionRunning: (sessionId, running, acpSessionId, startedAt) => {
      const payload: SessionRunningChangedPayload = {
        sessionId,
        running,
        ...(acpSessionId ? { acpSessionId } : {}),
        ...(startedAt ? { startedAt } : {})
      }
      send('forge:session-running-changed', payload)
    }
  })

  ipcMain.handle('forge:startSession', async (_e, opts: StartSessionOptions): Promise<StartSessionResult> => {
    log('ipc', `startSession agent=${opts.agentBackend ?? 'default'} cwd=${opts.cwd} model=${opts.model ?? 'default'}`)
    const sessionId = await bridge.start(opts)
    getForgeTray()?.setTooltip?.('Tran · 运行中…')
    return { sessionId }
  })

  ipcMain.handle('forge:sendMessage', async (_e, sessionId: string, content: string | unknown[], queueId?: string): Promise<void> => {
    log('ipc', `sendMessage session=${sessionId}`)
    bridge.send(sessionId, content, queueId)
  })

  ipcMain.handle('forge:discardQueued', async (_e, sessionId: string, queueId?: string): Promise<void> => {
    log('ipc', `discardQueued session=${sessionId} queueId=${queueId ?? 'all'}`)
    bridge.discardQueued(sessionId, queueId)
  })

  ipcMain.handle('forge:interrupt', async (_e, sessionId: string): Promise<void> => {
    await bridge.interrupt(sessionId)
  })

  ipcMain.handle('forge:setModel', async (_e, sessionId: string, model: string): Promise<void> => {
    await bridge.setModel(sessionId, model)
  })

  ipcMain.handle('forge:setPermissionMode', async (_e, sessionId: string, mode: string): Promise<void> => {
    await bridge.setPermissionMode(sessionId, mode)
  })

  ipcMain.handle('forge:goalStart', async (_e, sessionId: string, opts: GoalStartOptions) =>
    bridge.goalStart(sessionId, opts)
  )
  ipcMain.handle('forge:goalControl', async (_e, sessionId: string, action: GoalControlAction) =>
    bridge.goalControl(sessionId, action)
  )
  ipcMain.handle('forge:goalGet', async (_e, sessionId: string) => bridge.goalGet(sessionId))
  ipcMain.handle('forge:refreshSessionUsage', async (_e, sessionId: string): Promise<void> => {
    await bridge.requestUsageRefresh(sessionId)
  })
  // 套餐额度：官方 API + CLI 自己的 OAuth 凭证，不碰浏览器 Cookie（见 usageService.ts）。
  ipcMain.handle('forge:getPlanUsage', async (): Promise<PlanUsageResult> => getPlanUsageCached())
  // DeepSeek 余额：官方公开接口 + 设置页保存的 API key（见 deepseekService.ts）。
  ipcMain.handle('forge:getDeepseekBalance', async (): Promise<DeepseekBalanceResult> =>
    getDeepseekBalanceCached()
  )
  ipcMain.handle(
    'forge:getDeepseekApiKeyStatus',
    async (): Promise<{ configured: boolean; masked: string | null }> => deepseekKeyStatus()
  )
  ipcMain.handle(
    'forge:saveDeepseekApiKey',
    async (_e, key: string): Promise<{ configured: boolean; masked: string | null }> => {
      const trimmed = typeof key === 'string' ? key.trim() : ''
      setDeepseekApiKey(trimmed || null)
      // key 变了余额必须立即重拉，不能拿旧 key 的 60s 缓存顶事。
      invalidateDeepseekBalanceCache()
      return deepseekKeyStatus()
    }
  )
  ipcMain.handle('forge:nudgeTodos', async (_e, sessionId: unknown): Promise<boolean> => {
    // 开关在主进程再校验一次：渲染层已经判过，但这一轮**会真的花额度**，
    // 不能只靠调用方自觉。
    if (loadSettings().autoTodoNudge !== true) return false
    const id = requireString(sessionId, 'sessionId')
    // 冷却闸。渲染层那边已经按"每个任务只催一次"把关了，但那层判断依赖
    // 后台任务列表的稳定性——列表一抖动就会重新触发，用户看到的就是 Tran
    // 自己在跟 AI 连着聊。这里是最后一道：同一会话两次催更之间至少隔
    // NUDGE_COOLDOWN_MS，无论上游怎么判。
    const last = lastNudgeAt.get(id) ?? 0
    if (Date.now() - last < NUDGE_COOLDOWN_MS) {
      log('ipc', `todo-nudge 冷却中，跳过 ${id}`)
      return false
    }
    lastNudgeAt.set(id, Date.now())
    return bridge.requestTodoNudge(id)
  })

  // 渲染层在“切走会话”时调用本通道：后台化语义——不 cancel turn、不删会话，
  // 后台 turn 继续跑、事件继续经 forge:agent-event 推送。
  ipcMain.handle('forge:closeSession', async (_e, sessionId: string): Promise<void> => {
    bridge.background(sessionId)
  })

  // 显式关闭/删除会话：cancel 当前 turn 并销毁本地会话状态。
  ipcMain.handle('forge:destroySession', async (_e, sessionId: string): Promise<void> => {
    await bridge.close(sessionId)
  })

  ipcMain.handle('forge:listMcpServers', async (_e, sessionId: string) => {
    try {
      return await bridge.listMcpServers(sessionId)
    } catch (err) {
      log('ipc', `listMcpServers failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  })

  ipcMain.handle('forge:refreshMcpServers', async (_e, sessionId: string) => {
    try {
      return await bridge.refreshMcpServers(sessionId)
    } catch (err) {
      log('ipc', `refreshMcpServers failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  })

  ipcMain.handle('forge:toggleMcpServer',
    async (_e, sessionId: string, name: string, enabled: boolean): Promise<void> => {
      log('ipc', `toggleMcpServer session=${sessionId} name=${name} enabled=${enabled}`)
      await bridge.toggleMcpServer(sessionId, name, enabled)
    }
  )

  ipcMain.handle('forge:backgroundTask',
    async (_e, sessionId: string, toolUseId?: string): Promise<boolean> => {
      log('ipc', `backgroundTask session=${sessionId} toolUseId=${toolUseId ?? '(all)'}`)
      return await bridge.backgroundTask(sessionId, toolUseId)
    }
  )

  ipcMain.handle('forge:pickFiles', async (_e, cwd: string): Promise<PickedFile[]> => {
    const res = await dialog.showOpenDialog({
      title: '选择文件附件',
      defaultPath: cwd,
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || !res.filePaths.length) return []
    return await readPickedFiles(cwd, res.filePaths, 'pickFiles')
  })

  ipcMain.handle('forge:readFiles', async (_e, cwd: string, paths: string[]): Promise<PickedFile[]> => {
    const filePaths = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : []
    return await readPickedFiles(cwd, filePaths, 'readFiles')
  })

  ipcMain.handle('forge:revealInExplorer', async (_e, cwd: string, pathStr: string): Promise<boolean> => {
    const resolved = resolveNativePath(cwd, pathStr)
    let stat
    try {
      stat = await withPathReadTimeout(statAsync(resolved), `reveal stat ${resolved}`)
    } catch {
      return false
    }
    if (stat.isDirectory()) {
      await withPathReadTimeout(shell.openPath(resolved), `open path ${resolved}`)
      return true
    }
    shell.showItemInFolder(resolved)
    return true
  })

  // 图片附件独立窗口预览（2026-08-14 用户：「不要在右边展示详情，直接打开一个
  // 额外的窗口」）。大图别走 data: URL 整页注入——base64 过长 loadURL 直接拒载
  // （2026-08-17 实测"预览加载不出来"）。落成临时文件再 loadFile；窗口关闭即删。
  ipcMain.handle('forge:openImageWindow', async (_e, dataUrl: unknown, name: unknown): Promise<void> => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return
    const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s)
    if (!m) return
    const ext = (m[1].split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
    const buf = Buffer.from(m[2], 'base64')
    if (!buf.length) return
    const dir = join(app.getPath('temp'), 'tran-img-preview')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    writeFileSync(file, buf)
    const title = typeof name === 'string' && name.trim() ? name.trim() : '图片预览'
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      minWidth: 320,
      minHeight: 240,
      autoHideMenuBar: true,
      title,
      backgroundColor: '#0b0c10',
      webPreferences: { sandbox: true }
    })
    win.on('closed', () => {
      try { unlinkSync(file) } catch { /* 尽力删 */ }
    })
    await win.loadFile(file)
  })

  // 任务栏 overlay 角标（2026-08-18 用户：「每轮回答完像 Codex 一样有个小标」）。
  // 渲染层在轮结束且窗口无焦点时用 canvas 画好数字徽章（PNG dataURL）传上来；
  // 窗口重新聚焦即清（index.ts 的 focus 监听）。setOverlayIcon 仅 Windows 支持。
  ipcMain.handle('forge:setOverlayBadge', (_e, dataUrl: unknown, description: unknown) => {
    if (process.platform !== 'win32') return
    withWindow((win) => {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png')) {
        win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), typeof description === 'string' ? description : '')
      } else {
        win.setOverlayIcon(null, '')
      }
    })
  })

  // 任务栏闪烁（2026-09-01：agent 提问/待授权且窗口无焦点时渲染层开闪；
  // 回答完渲染层停，聚焦由 index.ts 的 focus 监听兜底停——渲染层忙也能停）。
  ipcMain.handle('forge:flashFrame', (_e, flag: unknown) => {
    if (process.platform !== 'win32') return
    withWindow((win) => win.flashFrame(flag === true))
  })

  // --- 图片右键菜单（#22）：复制到剪贴板 / 另存为。src 支持 data:/file:/http(s):
  //  URL 与绝对路径；blob: 由渲染进程先转成 data: 再传入。 ---
  const loadNativeImage = async (src: string): Promise<Electron.NativeImage> => {
    const value = src.trim()
    if (value.startsWith('data:')) return nativeImage.createFromDataURL(value)
    if (/^https?:\/\//i.test(value)) {
      // 超时 + 大小上限：src 来自渲染层（不可信），慢速响应会把
      // copyImage/saveImageAs 永久挂起，巨图会把主进程内存打爆——本地图片
      // 那条路有 MAX_IMAGE_BYTES 上限，这条网络路此前没有。
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      try {
        const res = await net.fetch(value, { signal: controller.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const length = Number(res.headers.get('content-length') ?? 0)
        if (length > MAX_IMAGE_BYTES) {
          throw new Error(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
        }
        // 流式读取边下边计数：arrayBuffer() 会先把整个 body 缓冲进内存，
        // 对端不报/谎报 content-length 时上限形同虚设。超限立即 abort。
        const chunks: Buffer[] = []
        let received = 0
        const reader = res.body?.getReader()
        if (!reader) throw new Error('响应无内容')
        for (;;) {
          const { done, value: chunk } = await reader.read()
          if (done) break
          received += chunk.byteLength
          if (received > MAX_IMAGE_BYTES) {
            controller.abort()
            throw new Error(`图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
          }
          chunks.push(Buffer.from(chunk))
        }
        return nativeImage.createFromBuffer(Buffer.concat(chunks))
      } finally {
        clearTimeout(timer)
      }
    }
    const path = value.toLowerCase().startsWith('file:') ? fileURLToPath(value) : value
    return nativeImage.createFromPath(path)
  }

  ipcMain.handle('forge:copyImage', async (_e, src: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const image = await loadNativeImage(src)
      if (image.isEmpty()) return { ok: false, error: '无法解析图片内容' }
      clipboard.writeImage(image)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'forge:saveImageAs',
    async (_e, src: string, suggestedName?: string): Promise<SaveImageResult> => {
      try {
        const image = await loadNativeImage(src)
        if (image.isEmpty()) return { ok: false, error: '无法解析图片内容' }
        const res = await dialog.showSaveDialog({
          title: '另存图片',
          defaultPath: suggestedName?.trim() || 'image.png',
          filters: [{ name: 'PNG 图片', extensions: ['png'] }]
        })
        if (res.canceled || !res.filePath) return { ok: false, canceled: true }
        // 异步写：大图 PNG 编码 + 写慢盘/网络盘的同步写会冻住主进程。
        await writeFile(res.filePath, image.toPNG())
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle('forge:listSkills', async (_e, sessionId: string): Promise<SkillInfo[]> => {
    try {
      return await bridge.listSkills(sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 会话懒创建：新会话的 sessionId 只是渲染层生成的本地 uid，ACP 后端要等
      // 用户发出第一条消息才真正启动（见 sessionStore 的 pendingSessionStart）。
      // 这期间点开技能页，requireSession 必然抛 "session not found"——那不是
      // 错误，是"后端还没起"。原先直接抛给渲染层，用户看到的是一句
      // `Error invoking remote method 'forge:listSkills'` 的原始报错。
      // 返回空列表，由渲染层给一句人话。
      if (/session not found/i.test(message)) {
        log('ipc', `listSkills: 会话尚未启动，返回空列表 (${sessionId})`)
        return []
      }
      log('ipc', `listSkills failed: ${message}`)
      throw err
    }
  })

  ipcMain.handle('forge:listSkillsForCwd', async (_e, cwd: string): Promise<SkillInfo[]> =>
    // 扫描自身已对所有 fs 错误静默降级（见 skillsScan.ts），这里只做入参校验。
    scanSkillsForCwd(requireString(cwd, 'cwd'))
  )

  ipcMain.handle('forge:getSessionUsage', async (_e, sessionId: string): Promise<SessionUsageInfo> => {
    try {
      return await bridge.getSessionUsage(sessionId)
    } catch (err) {
      log('ipc', `getSessionUsage failed: ${err instanceof Error ? err.message : String(err)}`)
      return { contextSize: 1_048_576 }
    }
  })

  ipcMain.handle(
    'forge:listMarketplacePlugins',
    async (_e, agentBackend?: AgentBackendId, cwd?: string): Promise<MarketplacePlugin[]> =>
      bridge.listMarketplacePlugins(agentBackend, cwd)
  )

  ipcMain.handle('forge:translateTexts', async (_e, texts: string[]): Promise<string[]> =>
    translateTexts(texts)
  )

  ipcMain.handle('forge:getTranslateConfig', async (): Promise<TranslateConfig> =>
    getTranslateConfig()
  )
  ipcMain.handle(
    'forge:saveTranslateConfig',
    async (_e, cfg: TranslateConfig): Promise<TranslateConfig> => saveTranslateConfig(cfg)
  )
  ipcMain.handle(
    'forge:testTranslate',
    async (_e, appId: string, secretKey: string): Promise<TranslateTestResult> =>
      testTranslate(appId, secretKey)
  )

  ipcMain.handle('forge:listAgentBackends', async (): Promise<AgentBackendInfo[]> =>
    AGENT_BACKENDS.map((backend) => ({ ...backend, capabilities: { ...backend.capabilities } }))
  )
  ipcMain.handle('forge:listAgentModels', async (): Promise<ComposerModel[]> =>
    bridge.listModels()
  )
  ipcMain.handle('forge:getPreferences', async (): Promise<Preferences> => getPreferences())
  ipcMain.handle('forge:savePreferences', async (_e, prefs: Preferences): Promise<Preferences> => {
    const next = savePreferences(prefs)
    // 宠物开关立即生效（其余偏好项都是渲染层自己消费，主进程不用管）。
    // 悬浮窗的存在与否 = 总开关 && 外部展示开关，任一变动都重新评估。
    if (prefs.desktopPetEnabled !== undefined || prefs.petOutsideEnabled !== undefined) {
      applyPetWindowPrefs()
    }
    // 渲染层镜像状态（petStore.masterEnabled 等）靠推送同步——直接拨
    // savePreferences 或宠物右键菜单改开关时，界面内的形象也要跟着显隐。
    withWindow((win) => win.webContents.send('forge:preferences-changed', next))
    return next
  })
  ipcMain.handle(
    'forge:getRuntimeStatus',
    async (_e, cwd?: string, model?: string, options?: { refreshProbe?: boolean }): Promise<RuntimeStatus> =>
      getRuntimeStatus(cwd, model, options)
  )
  ipcMain.handle(
    'forge:runWslHealthCheck',
    async (_e, cwd: string): Promise<WslHealthReport> => runWslHealthCheck(cwd)
  )
  ipcMain.handle(
    'forge:repairWslEnvironment',
    async (_e, cwd: string): Promise<WslHealthReport> => repairWslEnvironment(cwd)
  )
  ipcMain.handle('forge:getDiagnosticLog', async (): Promise<string> => getDiagnosticLog())
  ipcMain.handle('forge:getAppVersion', async (): Promise<string> => app.getVersion())
  ipcMain.handle('forge:getBrowserBridgeStatus', async (): Promise<BrowserBridgeStatus> =>
    getBrowserBridgeStatus())
  // 浏览器工具直调（第 2 步验证用；第 3 步 MCP server 走 WS 不经这里）。
  // 错误以 {ok:false} 返回而不是抛出：渲染层拿到的 invoke 异常会丢失细节。
  ipcMain.handle(
    'forge:browserToolCall',
    async (_e, tool: string, args?: unknown): Promise<BrowserToolResult> => {
      try {
        return { ok: true, result: await callBrowserTool(requireString(tool, 'tool'), args) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  ipcMain.handle('forge:checkForUpdates', async (): Promise<UpdateCheckResult> => checkForUpdates())
  ipcMain.handle(
    'forge:downloadAndInstallUpdate',
    async (_e, options?: UpdateDownloadOptions | string): Promise<UpdateInstallResult> => {
      const normalized = typeof options === 'string' ? { assetUrl: options } : (options ?? {})
      let directory = normalized.directory?.trim()

      if (!directory) {
        const dialogOptions: Electron.OpenDialogOptions = {
          title: '选择更新安装包保存目录',
          defaultPath: app.getPath('downloads'),
          properties: ['openDirectory', 'createDirectory']
        }
        const win = getMainWindow()
        const res =
          win && !win.isDestroyed()
            ? await dialog.showOpenDialog(win, dialogOptions)
            : await dialog.showOpenDialog(dialogOptions)
        if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true }
        directory = res.filePaths[0]
      }

      const result = await downloadAndInstallUpdate({
        ...normalized,
        directory,
        onProgress: (progress: UpdateDownloadProgress) => {
          send('forge:update-download-progress', progress)
          withWindow((win) => {
            if (progress.done) {
              win.setProgressBar(-1)
              return
            }
            if (typeof progress.percent === 'number') {
              win.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)))
            } else {
              win.setProgressBar(2)
            }
          })
        }
      })
      withWindow((win) => win.setProgressBar(-1))
      return result
    }
  )
  ipcMain.handle(
    'forge:exportDiagnosticReport',
    async (_e, options?: DiagnosticReportOptions): Promise<DiagnosticReportResult> => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const res = await dialog.showSaveDialog({
        title: 'Export Tran diagnostic report',
        defaultPath: `tran-diagnostic-${stamp}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return { canceled: true }
      const report = await buildDiagnosticReport(options)
      try {
        await writeFile(res.filePath, report, 'utf8')
      } catch (error) {
        // 与同级 handler（saveImageAs）一致：把失败作为结构化结果返回，
        // 而不是抛成 promise 拒绝丢给渲染层。
        return { error: error instanceof Error ? error.message : String(error) }
      }
      return { path: res.filePath }
    }
  )
  ipcMain.handle(
    'forge:checkKimiVersion',
    async (_e, force?: boolean): Promise<KimiVersionInfo> => checkKimiVersion(force === true)
  )
  ipcMain.handle(
    'forge:diagnoseSummaryPrompt',
    async (): Promise<PromptDiagnosis[]> => diagnoseSummaryPrompt()
  )
  ipcMain.handle(
    'forge:getSessionTodos',
    async (_e, sessionId: unknown): Promise<SessionTodosFetch> =>
      fetchSessionTodos(requireString(sessionId, 'sessionId'))
  )
  ipcMain.handle(
    'forge:explainCommand',
    async (_e, command: unknown): Promise<string | null> =>
      explainCommand(requireString(command, 'command'))
  )
  ipcMain.handle(
    'forge:explainEdit',
    async (_e, sample: unknown): Promise<string | null> =>
      explainEdit(requireString(sample, 'sample'))
  )
  ipcMain.handle(
    'forge:summarizeActivityGroup',
    async (_e, sample: unknown): Promise<string | null> =>
      summarizeActivityGroup(requireString(sample, 'sample'))
  )
  ipcMain.handle(
    'forge:summarizeThinking',
    async (_e, text: unknown): Promise<string | null> =>
      summarizeThinking(requireString(text, 'text'))
  )
  ipcMain.handle(
    'forge:translateThinking',
    async (_e, text: unknown): Promise<string | null> =>
      translateThinking(requireString(text, 'text'))
  )
  ipcMain.handle(
    'forge:probeSummaryModels',
    async (_e, models?: string[]): Promise<SummaryModelProbe[]> =>
      probeCheapModels(Array.isArray(models) ? models.filter((m) => typeof m === 'string') : undefined)
  )
  ipcMain.handle('forge:upgradeKimi', async (): Promise<KimiUpgradeResult> => {
    // Windows 上正在运行的 kimi 会占用可执行文件，覆盖安装必然 EBUSY/EPERM；
    // 且升级后旧 ACP 连接指向的是已被替换的文件。所以先把会话全部收掉。
    await bridge.shutdown().catch(() => {})
    const result = await upgradeKimi()
    // 会话已断，通知渲染层刷新列表（侧栏 running 标记要清）。
    send('forge:sessions-changed', {})
    return result
  })
  ipcMain.handle(
    'forge:exportSettings',
    async (_e, options?: SettingsExportOptions): Promise<SettingsBackup> =>
      createPortableSettingsBackup(options)
  )
  ipcMain.handle(
    'forge:importSettings',
    async (_e, request: SettingsImportRequest): Promise<SettingsImportResult> =>
      applyPortableSettingsBackup(request)
  )

  ipcMain.handle('forge:minimizeWindow', async (): Promise<void> => {
    withWindow((win) => win.minimize())
  })
  ipcMain.handle('forge:toggleMaximizeWindow', async (): Promise<boolean> => {
    let maximized = false
    withWindow((win) => {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      maximized = win.isMaximized()
    })
    return maximized
  })
  ipcMain.handle('forge:isWindowMaximized', async (): Promise<boolean> => {
    const win = getMainWindow()
    return !!win && !win.isDestroyed() && win.isMaximized()
  })
  ipcMain.handle('forge:closeWindow', async (): Promise<void> => {
    withWindow((win) => win.close())
  })

  // --- System tray & native notifications ---
  ipcMain.handle(
    'forge:resolveClose',
    async (_e, decision: { minimize: boolean; remember: boolean }): Promise<void> => {
      if (decision.remember) {
        const s = loadSettings()
        s.minimizeToTray = decision.minimize
        s.closePromptDismissed = true
        saveSettings(s)
      }
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      if (decision.minimize) {
        win.hide()
        getForgeTray()?.setTooltip?.('Tran — 后台运行中')
      } else {
        // Bypass the close-intercept for THIS close only so the app actually
        // quits. Using a one-shot (not the sticky isQuitting flag) so a future
        // close after re-show still honors the prompt setting.
        armSkipNextCloseIntercept()
        win.close()
      }
    }
  )

  ipcMain.handle('forge:showWindow', async (): Promise<void> => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  ipcMain.handle('forge:saveMcpServer', async (_e, args: SaveMcpServerArgs): Promise<void> => {
    saveMcpServer(args)
  })

  ipcMain.handle('forge:deleteMcpServer', async (_e, args: DeleteMcpServerArgs): Promise<boolean> => {
    return deleteMcpServer(args)
  })

  ipcMain.handle('forge:listProviders', async (): Promise<Provider[]> => listProviders())
  ipcMain.handle('forge:getActiveProvider', async (): Promise<Provider | null> => getActiveProvider())
  ipcMain.handle('forge:getProviderProfiles', async (): Promise<ProviderProfiles> =>
    getProviderProfiles()
  )
  ipcMain.handle('forge:saveProvider', async (_e, p: Provider): Promise<Provider[]> => saveProvider(p))
  ipcMain.handle(
    'forge:saveProviderForBackend',
    async (_e, backend: ProviderBackend, p: Provider): Promise<ProviderProfile> =>
      saveProviderForBackend(backend, p)
  )
  ipcMain.handle('forge:deleteProvider', async (_e, id: string): Promise<Provider[]> =>
    deleteProvider(id)
  )
  ipcMain.handle(
    'forge:deleteProviderForBackend',
    async (_e, backend: ProviderBackend, id: string): Promise<ProviderProfile> =>
      deleteProviderForBackend(backend, id)
  )
  ipcMain.handle('forge:setActiveProvider', async (_e, id: string): Promise<void> => {
    log('ipc', `setActiveProvider id=${id}`)
    setActiveProvider(id)
  })
  ipcMain.handle(
    'forge:setActiveProviderForBackend',
    async (_e, backend: ProviderBackend, id: string): Promise<ProviderProfile> => {
      log('ipc', `setActiveProvider backend=${backend} id=${id}`)
      return setActiveProviderForBackend(backend, id)
    }
  )
  ipcMain.handle(
    'forge:saveComposerModelsForBackend',
    async (_e, backend: ProviderBackend, models: ComposerModel[]): Promise<ProviderProfile> =>
      saveComposerModelsProfile(backend, models)
  )

  ipcMain.handle('forge:listProjects', async (): Promise<Project[]> => listProjects())
  // 主目录仍下发：侧栏把 cwd=主目录的历史会话归并到「无项目」组（ProjectSwitcher/Sidebar 用）；
  // 2026-09-01 第 2 期起新的无项目会话改落 scratch 目录（forge:ensureScratchDir）。
  ipcMain.handle('forge:getHomeDir', async (): Promise<string> => homedir())
  // 无项目会话独立工作目录（2026-09-01 Codex 化第 2 期）：Documents/Tran/<日期>/session-…，
  // mkdir 失败回退 userData/scratch（见 scratchDirs.ts）。
  ipcMain.handle('forge:ensureScratchDir', async (): Promise<string> => ensureScratchDir())
  // 渲染层匹配层豁免用的 scratch 根列表（2026-09-01：主目录被注册为项目后前缀
  // 匹配会罩住 scratch 目录；见 scratchDirs.getScratchRoots / projectMatch.isScratchCwd）。
  ipcMain.handle('forge:getScratchRoots', async (): Promise<string[]> => getScratchRoots())
  ipcMain.handle('forge:addProject', async (_e, path: string, name?: string): Promise<Project[]> =>
    addProject(requireString(path, 'path').trim(), name)
  )
  ipcMain.handle('forge:removeProject', async (_e, id: string): Promise<Project[]> =>
    removeProject(requireString(id, 'id').trim())
  )
  ipcMain.handle('forge:renameProject', async (_e, id: string, name: string): Promise<Project[]> =>
    renameProject(requireString(id, 'id').trim(), name)
  )
  ipcMain.handle(
    'forge:updateProject',
    async (_e, id: string, patch: ProjectPatch): Promise<Project[]> =>
      updateProject(requireString(id, 'id').trim(), patch ?? {})
  )
  ipcMain.handle('forge:reorderProjects', async (_e, ids: string[]): Promise<Project[]> =>
    reorderProjects(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  )
  ipcMain.handle('forge:setLastProject', async (_e, id: string): Promise<void> => {
    setLastProject(requireString(id, 'id').trim())
  })
  ipcMain.handle('forge:getStartupProject', async (): Promise<Project | null> => getStartupProject())

  ipcMain.handle('forge:listSessions', async (_e, cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]> => {
    // 「全部」视图：跨项目返回，limit 放大到 200；「当前项目」行为不变。
    const all = opts?.scope === 'all'
    const limit = all ? 200 : opts?.limit && opts.limit > 0 ? opts.limit : 50
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0
    // 两个后端的历史各存各的（kimi 走 ACP 的 history，Claude Code 写自己的
    // projects/*.jsonl）。**只列当前后端的**：v1.0.88 把两家合并混排是个设计
    // 错误——用 Kimi 的时候冒出一堆 Claude Code 的对话（反之亦然），既看不懂
    // 也点不进去（点进去要换后端，等于莫名其妙切走了引擎）。
    const backend = normalizeAgentBackend(getPreferences().agentBackend ?? DEFAULT_AGENT_BACKEND_ID)
    // 2026-09-01 第 1.5 期：scope 'project' 先按 cwd 匹配已注册项目（rootPaths
    // 前缀、最长匹配），命中则按该项目 rootPaths 过滤（子目录里的会话也算本
    // 项目）；cwd 不属于任何项目时传 undefined，回退旧的精确 cwd 过滤。
    // 渲染层调用签名不变（仍只传 cwd），项目解析在主进程内完成。
    const projectRoots = all ? undefined : matchProjectByCwd(cwd, listProjects())?.rootPaths
    const items =
      backend === 'claude'
        ? await listClaudeSessions(cwd, { limit, offset, scope: all ? 'all' : 'project' }).catch(
            (error) => {
              log(
                'claude-history',
                `list failed: ${error instanceof Error ? error.message : String(error)}`
              )
              return []
            }
          )
        : await listKimiSessions(cwd, {
            limit,
            offset,
            scope: all ? 'all' : 'project',
            projectRoots,
            // 无标题会话只豁免"本进程还持有的"那些，见 listKimiSessions 注释。
            liveIds: bridge.liveAcpSessionIds()
          })
    items.sort((a, b) => b.lastModified - a.lastModified)
    // 合并主进程内存中的运行状态（SessionListItem.sessionId 即 ACP 会话 id）。
    const running = bridge.runningAcpSessionIds()
    if (running.size) {
      for (const item of items) item.running = running.has(item.sessionId)
    }
    return items
  })

  ipcMain.handle('forge:launchScreenAssist', async () => launchScreenAssist())

  ipcMain.handle('forge:launchXhh', async () => launchXhh())

  ipcMain.handle('forge:launchXtw', async () => launchXtw())

  ipcMain.handle('forge:getRpTavernStatus', async () => getRpTavernStatus())

  ipcMain.handle('forge:configureRpTavern', async (_event, installPath: unknown) =>
    configureRpTavern(requireString(installPath, 'installPath').trim())
  )

  ipcMain.handle('forge:openRpTavern', async () => openRpTavern())

  ipcMain.handle('forge:getSessionMessages', async (
    _e,
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<HistoryMessage[]> => {
    // TODO(kimi-history): ACP 没有逐条读取历史消息的方法；恢复会话时由
    // session/load 在 agent 侧回放（见 KimiBackend / kimiHistory 的 TODO）。
    //
    // Claude Code 不一样：`--resume` 只恢复上下文、不重放消息，但它把整段对话
    // 都写在 projects/<slug>/<id>.jsonl 里，自己读回来即可——否则点开一条历史
    // 会话是空白的。id 不属于 Claude 时返回 []，kimi 路径行为不变。
    void cwd
    void backend
    return await readClaudeSessionMessages(sessionId)
  })

  ipcMain.handle(
    'forge:renameSession',
    async (
      _e,
      sessionId: string,
      title: string,
      cwd: string,
      backend?: ClaudeExecutionBackend
    ): Promise<void> => {
      // 手动重命名：持久化到本地 manual titles（显示优先级最高，AI/兜底不覆盖）。
      void cwd
      void backend
      recordManualTitle(sessionId, title)
    }
  )

  ipcMain.handle('forge:getAiTitles', async (): Promise<Record<string, string>> => allAiTitles())

  ipcMain.handle(
    'forge:generateAiTitles',
    async (_e, sessionIds: string[]): Promise<AiTitlesBatchResult> => {
      // 进度逐条推渲染层：批量命名几十上百个会话要跑几分钟，按钮上没进度
      // 就是"卡住"（2026-08-19 用户：「AI会话命名一直卡住」）。
      const result = await generateAiTitlesBatch(
        Array.isArray(sessionIds) ? sessionIds : [],
        (done, total) => send('forge:aiNamingProgress', { done, total })
      )
      // 有新标题产生就通知渲染层刷新侧栏（复用 sessions-changed 通道）。
      if (result.generated > 0) send('forge:sessions-changed', {})
      return result
    }
  )

  ipcMain.handle(
    'forge:getSessionPreview',
    async (_e, sessionId: string): Promise<SessionPreview> => getSessionPreview(sessionId)
  )

  // --- Swarm tasks 轮询（kimi 本地 server；连接失败静默降级，绝不影响聊天） ---
  //
  // 每个被观察的会话各持一个 poller。**此前是单例**（一个 swarmSessionId +
  // 一个 timer），切会话就把上一个会话的轮询停掉——于是后台那个跑着 Bash/
  // 子代理的会话，任务状态从此不再更新：待办卡永远停在旧状态，"后台任务已
  // 结束"的提醒也永远不会触发。渲染层里 `foldBackgroundSwarmTasks`（处理
  // 非当前会话的推送）因此是条死路径，主进程根本不会给它推。
  //
  // 现在：前台会话 + 任何还有 running 任务的会话都各自轮询。后台会话一旦
  // 任务全部收尾就自动退休，避免"每个开过的会话永久占一个定时器"。
  interface SwarmPoller {
    timer: ReturnType<typeof setTimeout> | null
    failures: number
    /** 前台会话（渲染层正在看的那个）。后台会话任务收尾后会被回收。 */
    foreground: boolean
  }
  const swarmPollers = new Map<string, SwarmPoller>()
  /** 后台 poller 上限：正常最多一两个，设个上限防病态增长（比如脚本连开会话）。 */
  const MAX_SWARM_POLLERS = 8

  const stopSwarmPolling = (sessionId?: string): void => {
    const ids = sessionId === undefined ? [...swarmPollers.keys()] : [sessionId]
    for (const id of ids) {
      const poller = swarmPollers.get(id)
      if (!poller) continue
      if (poller.timer !== null) clearTimeout(poller.timer)
      swarmPollers.delete(id)
    }
  }

  const scheduleSwarmPoll = (sessionId: string, delayMs: number): void => {
    const poller = swarmPollers.get(sessionId)
    if (!poller) return
    poller.timer = setTimeout(() => void pollSwarmTasks(sessionId), delayMs)
    // 轮询不该拖住事件循环、阻止进程退出。
    poller.timer.unref?.()
  }

  // 失败重试退避：15s→60s→5min 封顶（成功后 failures 清零自动重置）。
  const swarmRetryDelay = (failures: number): number =>
    Math.min(15000 * 4 ** (failures - 1), 300000)

  const pollSwarmTasks = async (sessionId: string): Promise<void> => {
    const poller = swarmPollers.get(sessionId)
    if (!poller) return
    // 窗口没了就彻底停：渲染层重载/关窗时不会发退订，继续轮询是纯空转。
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      stopSwarmPolling()
      return
    }
    const tasks = await getSessionTasks(sessionId).catch(() => null)
    // 期间被退订/回收了就别再续期。
    if (swarmPollers.get(sessionId) !== poller) return
    if (tasks === null) {
      poller.failures += 1
      // server 持续不可用：推一次降级态，之后按指数退避继续重试（15s→60s→5min
      // 封顶），server 恢复后自动回到正常轮询。
      if (poller.failures === 3) {
        send('forge:swarm-tasks', { sessionId, tasks: null })
      }
      scheduleSwarmPoll(sessionId, swarmRetryDelay(poller.failures))
      return
    }
    poller.failures = 0
    send('forge:swarm-tasks', { sessionId, tasks })

    const active = tasks.some((t) => t.status === 'running')
    // 后台会话的任务已全部收尾：最后这一帧已经推给渲染层了（"已结束"的判断
    // 依赖它），此后没有新信息，回收定时器。
    if (!poller.foreground && !active) {
      stopSwarmPolling(sessionId)
      return
    }
    // 有 running 任务时 2s 高频；前台空闲 15s 降频；后台留着的一律 5s
    // （它之所以还留着就是因为有任务在跑）。
    scheduleSwarmPoll(sessionId, active ? (poller.foreground ? 2000 : 5000) : 15000)
  }

  /** 起一个 poller（已存在则只更新前台标记）。 */
  const ensureSwarmPoller = (sessionId: string, foreground: boolean): void => {
    const existing = swarmPollers.get(sessionId)
    if (existing) {
      existing.foreground = existing.foreground || foreground
      return
    }
    if (swarmPollers.size >= MAX_SWARM_POLLERS) {
      // 满了就挤掉一个后台的；前台的永不挤掉。
      const victim = [...swarmPollers.entries()].find(([, p]) => !p.foreground)?.[0]
      if (victim === undefined) return
      log('ipc', `swarm poller 上限已满，回收后台会话 ${victim}`)
      stopSwarmPolling(victim)
    }
    swarmPollers.set(sessionId, { timer: null, failures: 0, foreground })
    void pollSwarmTasks(sessionId)
  }

  // 渲染层 reload/跳转不会发退订：旧页面的前台 poller 没人收，会永远按 15s
  // 轮询并向无监听者推送。给 webContents 挂一次性守卫——主框架导航（含
  // reload）或销毁时全停；新页面加载后会重新 subscribe，从零起表。
  const swarmGuardedContents = new WeakSet<Electron.WebContents>()
  const ensureSwarmNavGuard = (): void => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (swarmGuardedContents.has(wc)) return
    swarmGuardedContents.add(wc)
    wc.on('did-navigate', () => stopSwarmPolling())
    wc.on('destroyed', () => stopSwarmPolling())
  }

  ipcMain.handle('forge:subscribeSwarmTasks', async (_e, sessionId: string): Promise<void> => {
    const id = requireString(sessionId, 'sessionId')
    ensureSwarmNavGuard()
    // 换前台：上一个前台**降级为后台**而不是停掉——它可能正跑着后台任务，
    // 停了就又回到"切走即失联"。它的任务收尾后 pollSwarmTasks 自己回收。
    for (const [other, poller] of swarmPollers) {
      if (other !== id) poller.foreground = false
    }
    ensureSwarmPoller(id, true)
  })

  ipcMain.handle('forge:unsubscribeSwarmTasks', async (_e, sessionId?: string): Promise<void> => {
    // 带 sessionId：只把它降级为后台（有任务在跑就继续轮，收尾后自动回收）。
    // 不带（老调用方/窗口卸载）：全停。
    if (typeof sessionId === 'string' && sessionId) {
      const poller = swarmPollers.get(sessionId)
      if (poller) poller.foreground = false
      return
    }
    stopSwarmPolling()
  })

  // 渲染层不一定会退订（重载、隐藏到托盘、直接关窗），不挂这个钩子的话
  // pollSwarmTasks 会一直自我续期地轮询下去。
  app.once('before-quit', () => stopSwarmPolling())

  ipcMain.handle(
    'forge:deleteSession',
    async (
      _e,
      sessionId: string,
      cwd: string,
      backend?: ClaudeExecutionBackend
    ): Promise<{ ok: boolean; error?: string }> => {
      // 永久删除：移除 session_index.jsonl 行 + 删 sessions/ 下会话目录（严格路径校验）。
      void cwd
      void backend
      // 两个后端的会话在侧栏混排，删除也得两边都试：先按 kimi 删，找不到再
      // 按 Claude Code 的 projects/*.jsonl 删。只走 kimi 那条的话，删 Claude
      // 会话表面成功、刷新那一行又回来了。
      let result = await deleteKimiSession(sessionId)
      if (!result.ok) {
        const claudeResult = await deleteClaudeSession(sessionId)
        if (claudeResult.ok) result = claudeResult
      }
      if (result.ok) {
        removeSessionTitle(sessionId)
        dropArchivedSession(sessionId)
        dropSessionProjectAssignment(sessionId)
        // 历史查询客户端缓存着 session/list 快照（实测列表冻结，见 kimiHistory
        // 的 TTL 注释）：不丢掉的话删除后第一次刷新会把已删会话带回来——
        // 「删当前会话删不掉、过会儿自己又消失」就是它（2026-08-14 实测复现）。
        disposeKimiHistoryClient()
        markSessionDeleted(sessionId)
      }
      return result
    }
  )

  // 会话归档：Tran 侧标记（数据不动），列表过滤掉；删除只在归档页发生。
  ipcMain.handle('forge:getArchivedSessions', async (): Promise<Record<string, number>> =>
    getArchivedSessions()
  )
  ipcMain.handle('forge:archiveSession', async (_e, sessionId: string): Promise<void> => {
    archiveSession(requireString(sessionId, 'sessionId'))
  })
  ipcMain.handle('forge:unarchiveSession', async (_e, sessionId: string): Promise<void> => {
    unarchiveSession(requireString(sessionId, 'sessionId'))
  })

  // 会话→项目归属（2026-08-27「移动到项目」）：Tran 侧元数据，cwd 不动。
  // 值 = projectId（2026-09-01 起）；undefined = 清除覆盖（回到跟随 cwd 默认）。
  ipcMain.handle(
    'forge:getSessionProjectAssignments',
    async (): Promise<Record<string, string | null>> => getSessionProjectAssignments()
  )
  ipcMain.handle(
    'forge:setSessionProjectAssignment',
    async (_e, sessionKey: string, projectId?: string | null): Promise<void> => {
      const key = requireString(sessionKey, 'sessionKey')
      if (projectId === undefined) clearSessionProjectAssignment(key)
      else if (projectId === null) setSessionProjectAssignment(key, null)
      else setSessionProjectAssignment(key, requireString(projectId, 'projectId').trim())
    }
  )

  ipcMain.handle(
    'forge:getSubagentMessages',
    async (_e, sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]> => {
      // Kimi ACP 不暴露 subagent 转录（subagents 能力未验证）。
      void sessionId
      void agentId
      void cwd
      return []
    }
  )

  ipcMain.handle(
    'forge:pickDirectory',
    async (_e, options?: PickDirectoryOptions): Promise<string | null> => {
      void options
      const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (res.canceled || !res.filePaths.length) return null
      return res.filePaths[0]
    }
  )

  ipcMain.handle(
    'forge:getApiKey',
    async (): Promise<{ configured: boolean; masked: string | null }> => {
      // 解密后的完整 Key 不回传渲染层（渲染层只拿它做设置页回显）：
      // 返回掩码形态，同时保留「是否已配置」的判断能力。
      const key = getApiKey()
      if (!key) return { configured: false, masked: null }
      // 短 Key 前后各留 4 位就等于全泄露，一律只给 ***。
      const masked = key.length >= 12 ? `${key.slice(0, 4)}***${key.slice(-4)}` : '***'
      return { configured: true, masked }
    }
  )

  ipcMain.handle('forge:setApiKey', async (_e, key: string): Promise<void> => {
    setApiKey(key)
  })

  // ---- 摘要 API 多套配置（换服务商不再覆盖旧的，见 settings.ts）----
  // 摘要 API 的不可自愈故障（额度耗尽/凭证失效）推给渲染层显示。
  // 静默回退是这条链路的常态设计，但那两类故障静默下去就是"功能悄悄不工作"。
  onSummaryIssue((kind, detail) => send('forge:summary-api-issue', { kind, detail }))

  ipcMain.handle('forge:listSummaryProfiles', async () => listSummaryProfiles())
  ipcMain.handle(
    'forge:upsertSummaryProfile',
    async (_e, profile: SummaryProfile, key?: string | null) => upsertSummaryProfile(profile, key)
  )
  ipcMain.handle('forge:deleteSummaryProfile', async (_e, id: string) => deleteSummaryProfile(id))
  ipcMain.handle('forge:setActiveSummaryProfile', async (_e, id: string) => setActiveSummaryProfile(id))

  ipcMain.handle(
    'forge:respondPermission',
    async (_e, resp: PermissionResponsePayload): Promise<void> => {
      bridge.respondPermission(resp)
    }
  )

  // --- Git integration handlers ---

  ipcMain.handle('forge:gitIsRepo', async (_e, cwd: string): Promise<boolean> =>
    gitModule.isGitRepo(cwd)
  )

  ipcMain.handle('forge:gitGetCurrentBranch', async (_e, cwd: string): Promise<string | null> =>
    gitModule.getCurrentBranch(cwd)
  )

  ipcMain.handle('forge:gitListBranches', async (_e, cwd: string) =>
    gitModule.listBranches(cwd)
  )

  ipcMain.handle('forge:gitCheckoutBranch', async (_e, cwd: string, branch: string): Promise<void> => {
    await gitModule.checkoutBranch(cwd, branch)
  })

  ipcMain.handle('forge:gitCreateBranch', async (_e, cwd: string, name: string): Promise<void> => {
    await gitModule.createBranch(cwd, name)
  })

  ipcMain.handle('forge:gitDeleteBranch', async (_e, cwd: string, name: string, force?: boolean): Promise<void> => {
    await gitModule.deleteBranch(cwd, name, force)
  })

  ipcMain.handle('forge:gitPull', async (_e, cwd: string) =>
    gitModule.pull(cwd)
  )

  ipcMain.handle('forge:gitPush', async (_e, cwd: string) =>
    gitModule.push(cwd)
  )

  ipcMain.handle('forge:gitStatus', async (_e, cwd: string) =>
    gitModule.getStatus(cwd)
  )

  ipcMain.handle('forge:gitAdd', async (_e, cwd: string, paths?: string[]): Promise<void> => {
    await gitModule.add(cwd, paths)
  })

  ipcMain.handle('forge:gitCommit', async (_e, cwd: string, message: string): Promise<void> => {
    await gitModule.commit(cwd, message)
  })

  ipcMain.handle('forge:gitLog', async (_e, cwd: string, limit?: number) =>
    gitModule.logCommits(cwd, limit)
  )

  ipcMain.handle('forge:gitStash', async (_e, cwd: string, action?: string, message?: string): Promise<string> =>
    gitModule.stash(cwd, action, message)
  )

  ipcMain.handle('forge:gitRevert', async (_e, cwd: string, commitHash: string): Promise<void> => {
    await gitModule.revert(cwd, commitHash)
  })

  ipcMain.handle('forge:gitDiff', async (_e, cwd: string, opts?: { staged?: boolean; paths?: string[] }) =>
    gitModule.diff(cwd, opts)
  )

  ipcMain.handle('forge:gitFetch', async (_e, cwd: string) =>
    gitModule.fetch(cwd)
  )

  ipcMain.handle('forge:gitReset', async (_e, cwd: string, paths?: string[]): Promise<void> => {
    await gitModule.reset(cwd, paths)
  })

  ipcMain.handle('forge:gitPushUpstream', async (_e, cwd: string) =>
    gitModule.pushUpstream(cwd)
  )

  ipcMain.handle('forge:gitWorkingChanges', async (_e, cwd: string) =>
    gitModule.getWorkingChanges(requireString(cwd, 'cwd'))
  )

  // 2026-09-02 「改动多数派仓库」推导：渲染层把会话改动文件的 dirname 批量传上来
  // 查各自所属 git 仓库根。入参只收字符串数组，逐元素过滤非法值（渲染层的数据
  // 源自 agent 工具输入，不做路径存在性校验——git 查不到自然回 null）。
  ipcMain.handle('forge:gitRepoRoots', async (_e, dirs: unknown): Promise<(string | null)[]> => {
    const list = Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d.length > 0) : []
    return gitModule.getRepoRootsForDirs(list)
  })

  ipcMain.handle(
    'forge:gitFileDiff',
    async (_e, cwd: string, path: string, opts?: { untracked?: boolean; oldPath?: string }) =>
      gitModule.getFileDiff(requireString(cwd, 'cwd'), requireString(path, 'path'), opts)
  )

  ipcMain.handle(
    'forge:gitRevertFile',
    async (
      _e,
      cwd: string,
      path: string,
      untracked: boolean,
      opts?: { status?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'; oldPath?: string }
    ): Promise<void> => {
      await gitModule.revertFile(
        requireString(cwd, 'cwd'),
        requireString(path, 'path'),
        !!untracked,
        opts
      )
    }
  )

  // --- git worktree 隔离（2026-09-01 Codex 化第 4 期，逐线程 opt-in） ---
  // 台账在 worktreeStore.ts；git 操作的失败原因（非 git 仓库/未提交改动等）
  // 以抛错形式回渲染层，由入口弹窗展示。
  ipcMain.handle(
    'forge:createWorktree',
    async (_e, repoRoot: string, projectId: string | null, name: string) =>
      createWorktreeRecord(
        requireString(repoRoot, 'repoRoot'),
        // 2026-09-02「改动迁移 worktree」：改动落在未注册仓库时无归属项目，允许 null
        projectId === null ? null : requireString(projectId, 'projectId').trim(),
        requireString(name, 'name').trim()
      )
  )
  ipcMain.handle('forge:removeWorktree', async (_e, path: string, opts?: { force?: boolean }): Promise<void> => {
    await removeWorktreeRecord(requireString(path, 'path'), { force: !!opts?.force })
  })
  ipcMain.handle('forge:listWorktrees', async () => listWorktreeRecords())
  ipcMain.handle('forge:worktreeBindSession', async (_e, path: string, sessionKey: string): Promise<void> => {
    bindWorktreeSession(requireString(path, 'path'), requireString(sessionKey, 'sessionKey'))
  })

  return bridge
}
