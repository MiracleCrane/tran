import { app, ipcMain, dialog, shell, clipboard, nativeImage, net, Notification, type BrowserWindow } from 'electron'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat as statAsync } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBridge } from './agent/AgentBridge'
import { AGENT_BACKENDS } from '../shared/agentBackends'
import { getApiKey, setApiKey, loadSettings, saveSettings } from './settings'
import { saveMcpServer, deleteMcpServer } from './mcpConfig'
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
  setLastProject,
  getStartupProject
} from './projects'
import { translateTexts } from './translate'
import { getTranslateConfig, saveTranslateConfig, testTranslate } from './translateConfig'
import { getPreferences, savePreferences } from './preferences'
import {
  exportSettings,
  getDiagnosticLog,
  getRuntimeStatus,
  importSettings,
  buildDiagnosticReport,
  repairWslEnvironment,
  runWslHealthCheck
} from './runtimeDiagnostics'
import { checkForUpdates, downloadAndInstallUpdate } from './updater'
import { checkKimiVersion, upgradeKimi } from './kimiVersion'
import { probeCheapModels } from './cheapModel'
import { listKimiSessions } from './kimiHistory'
import { listClaudeSessions } from './claudeHistory'
import { getPlanUsageCached } from './usageService'
import { getQuotaOverviewCached, fetchQuotaActions, runQuotaLogin } from './quotaService'
import { deleteKimiSession } from './sessionDelete'
import { removeSessionTitle, recordManualTitle } from './sessionTitles'
import { allAiTitles, generateAiTitlesBatch, getSessionPreview } from './aiTitles'
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
  PlanUsageResult,
  QuotaOverviewResult,
  QuotaActionsResult,
  AiTitlesBatchResult,
  SessionPreview,
  SaveImageResult,
  KimiVersionInfo,
  KimiUpgradeResult,
  SummaryModelProbe
} from '../shared/ipc'

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
const MAX_DIRECTORY_ENTRIES = 300
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
        data = (await withPathReadTimeout(readFile(p), `read image ${p}`)).toString('base64')
      } else if (kind === 'text') {
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
      log('ipc', `${source} skip ${rawPath}: ${e instanceof Error ? e.message : String(e)}`)
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

  ipcMain.handle('forge:sendMessage', async (_e, sessionId: string, content: string | unknown[]): Promise<void> => {
    log('ipc', `sendMessage session=${sessionId}`)
    bridge.send(sessionId, content)
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

  // --- 图片右键菜单（#22）：复制到剪贴板 / 另存为。src 支持 data:/file:/http(s):
  //  URL 与绝对路径；blob: 由渲染进程先转成 data: 再传入。 ---
  const loadNativeImage = async (src: string): Promise<Electron.NativeImage> => {
    const value = src.trim()
    if (value.startsWith('data:')) return nativeImage.createFromDataURL(value)
    if (/^https?:\/\//i.test(value)) {
      const res = await net.fetch(value)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
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
        writeFileSync(res.filePath, image.toPNG())
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
      log('ipc', `listSkills failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  })

  ipcMain.handle('forge:getSessionUsage', async (_e, sessionId: string): Promise<SessionUsageInfo> => {
    try {
      return await bridge.getSessionUsage(sessionId)
    } catch (err) {
      log('ipc', `getSessionUsage failed: ${err instanceof Error ? err.message : String(err)}`)
      return { contextSize: 1_048_576 }
    }
  })

  ipcMain.handle('forge:getPlanUsage', async (): Promise<PlanUsageResult> => {
    // Claude 后端有活跃会话且收到过 rate_limit_event 时用它的额度；
    // 否则回落到 kimi 的 /usages 源。两者数据源完全不同，不能混算。
    const claudeUsage = bridge.claudePlanUsage()
    if (claudeUsage) return { ok: true, data: claudeUsage }
    return getPlanUsageCached()
  })

  // --- 额度总览/明细（MembershipService RPC；登录态取 kimi-desktop / 网页登录兜底）。
  // 总览走 60s 缓存（悬停卡/明细面板共用，悬停秒开）；明细翻页每次实时。 ---
  ipcMain.handle('forge:getQuotaOverview', async (): Promise<QuotaOverviewResult> => getQuotaOverviewCached())
  ipcMain.handle(
    'forge:listQuotaActions',
    async (_e, pageToken?: string): Promise<QuotaActionsResult> => fetchQuotaActions(pageToken)
  )
  ipcMain.handle('forge:quotaLogin', async (): Promise<{ ok: boolean; error?: string }> => runQuotaLogin())

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
  ipcMain.handle('forge:savePreferences', async (_e, prefs: Preferences): Promise<Preferences> =>
    savePreferences(prefs)
  )
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
        writeFileSync(res.filePath, report, 'utf8')
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
    async (_e, appearance?: Record<string, unknown>): Promise<SettingsBackup> =>
      exportSettings(appearance)
  )
  ipcMain.handle(
    'forge:importSettings',
    async (_e, backup: SettingsBackup): Promise<void> => importSettings(backup)
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
  ipcMain.handle('forge:addProject', async (_e, path: string, name?: string): Promise<Project[]> =>
    addProject(requireString(path, 'path').trim(), name)
  )
  ipcMain.handle('forge:removeProject', async (_e, path: string): Promise<Project[]> =>
    removeProject(path)
  )
  ipcMain.handle('forge:renameProject', async (_e, path: string, name: string): Promise<Project[]> =>
    renameProject(path, name)
  )
  ipcMain.handle('forge:setLastProject', async (_e, path: string): Promise<void> => {
    setLastProject(requireString(path, 'path').trim())
  })
  ipcMain.handle('forge:getStartupProject', async (): Promise<Project | null> => getStartupProject())

  ipcMain.handle('forge:listSessions', async (_e, cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]> => {
    // 「全部」视图：跨项目返回，limit 放大到 200；「当前项目」行为不变。
    const all = opts?.scope === 'all'
    const limit = all ? 200 : opts?.limit && opts.limit > 0 ? opts.limit : 50
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0
    // 两个后端的历史各自落盘、互不相通：kimi 在 ~/.kimi-code/sessions，
    // Claude Code 在 ~/.claude/projects。合并后按时间统一排序，条目自带
    // agentBackend 供打开时路由到正确的后端。
    const [kimiItems, claudeItems] = await Promise.all([
      listKimiSessions(cwd, { limit, offset, scope: all ? 'all' : 'project' }),
      Promise.resolve(listClaudeSessions(cwd, { limit, offset, scope: all ? 'all' : 'project' }))
    ])
    const items = [...kimiItems, ...claudeItems]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, limit)
    // 合并主进程内存中的运行状态（SessionListItem.sessionId 即 ACP 会话 id）。
    const running = bridge.runningAcpSessionIds()
    if (running.size) {
      for (const item of items) item.running = running.has(item.sessionId)
    }
    return items
  })

  ipcMain.handle('forge:getSessionMessages', async (
    _e,
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<HistoryMessage[]> => {
    // TODO(kimi-history): ACP 没有逐条读取历史消息的方法；恢复会话时由
    // session/load 在 agent 侧回放（见 KimiBackend / kimiHistory 的 TODO）。
    void sessionId
    void cwd
    void backend
    return []
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
      const result = await generateAiTitlesBatch(Array.isArray(sessionIds) ? sessionIds : [])
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

  ipcMain.handle('forge:subscribeSwarmTasks', async (_e, sessionId: string): Promise<void> => {
    const id = requireString(sessionId, 'sessionId')
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
      const result = deleteKimiSession(sessionId)
      if (result.ok) removeSessionTitle(sessionId)
      return result
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

  ipcMain.handle('forge:getApiKey', async (): Promise<string | null> => {
    return getApiKey()
  })

  ipcMain.handle('forge:setApiKey', async (_e, key: string): Promise<void> => {
    setApiKey(key)
  })

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

  return bridge
}
