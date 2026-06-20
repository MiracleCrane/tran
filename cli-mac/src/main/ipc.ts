import { app, ipcMain, dialog, shell, Notification, type BrowserWindow } from 'electron'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat as statAsync } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
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
import { currentAgentBackend, getPreferences, savePreferences } from './preferences'
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
import { fromWslPath, getDefaultWslDistro, getWslHome, toWslPath, toWslUncPath } from './wslClaude'
import {
  deleteWslSession,
  getWslSessionMessages,
  getWslSubagentMessages,
  listWslSessions,
  renameWslSession
} from './wslHistory'
import {
  deleteCodexSession,
  getCodexSessionMessages,
  listCodexSessions,
  renameCodexSession
} from './codexHistory'
import {
  deleteHermesSession,
  getHermesSessionMessages,
  listHermesSessions,
  renameHermesSession
} from './hermesHistory'
import * as gitModule from './git'
import { log } from './logger'
import type {
  StartSessionOptions,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SessionListItem,
  SessionListOptions,
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
  DiagnosticReportResult
} from '../shared/ipc'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { isWslProjectPath } from '../shared/paths'

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

function currentClaudeBackend(): ClaudeExecutionBackend {
  return process.platform === 'win32' && getPreferences().claudeExecutionBackend === 'wsl'
    ? 'wsl'
    : 'windows'
}

function useWslClaudeBackend(backend: ClaudeExecutionBackend = currentClaudeBackend()): boolean {
  return process.platform === 'win32' && backend === 'wsl'
}

function isNativeAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[/\\]{2}/.test(path)
}

function normalizeProjectPathForBackend(
  path: string,
  backend: ClaudeExecutionBackend = currentClaudeBackend()
): string {
  const trimmed = path.trim()
  if (!trimmed) return trimmed
  if (!useWslClaudeBackend(backend)) return trimmed
  return fromWslPath(trimmed) ?? trimmed
}

function projectBackendFromPath(
  path: string,
  fallback: ClaudeExecutionBackend = currentClaudeBackend()
): ClaudeExecutionBackend {
  return process.platform === 'win32' &&
    isWslProjectPath(path, { includePosixAbsolute: true })
    ? 'wsl'
    : fallback
}

function enableWslPreferencesForProjectBackend(backend: ClaudeExecutionBackend): void {
  if (backend !== 'wsl') return
  savePreferences({ wslSupportEnabled: true, claudeExecutionBackend: 'wsl' })
}

function resolveNativePath(cwd: string, pathStr: string): string {
  const nativePath = fromWslPath(pathStr) ?? pathStr
  if (isNativeAbsolutePath(nativePath)) return nativePath
  const nativeCwd = fromWslPath(cwd) ?? cwd
  return resolve(nativeCwd, pathStr)
}

function rendererPathFromNativePath(path: string): string {
  return useWslClaudeBackend() ? (toWslPath(path) ?? path) : path
}

function toWslPickerPath(path: string | undefined): string | undefined {
  return path?.replace(/^\\\\wsl\.localhost\\/i, '\\\\wsl$\\')
}

function wslDirectoryDefaultPath(): string | undefined {
  const distro = getDefaultWslDistro()
  const home = getWslHome()
  if (home) return toWslPickerPath(toWslUncPath(home, distro))
  if (distro) return `\\\\wsl$\\${distro}`
  return '\\\\wsl$'
}

async function pickWslDirectory(): Promise<string | null> {
  const defaultPath = wslDirectoryDefaultPath()
  let res: Electron.OpenDialogReturnValue
  try {
    res = await dialog.showOpenDialog({
      title: 'Select WSL project directory',
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory']
    })
  } catch (err) {
    log('ipc', `WSL directory picker fallback: ${err instanceof Error ? err.message : String(err)}`)
    res = await dialog.showOpenDialog({
      title: 'Select WSL project directory',
      properties: ['openDirectory']
    })
  }
  if (res.canceled || !res.filePaths.length) return null
  return normalizeProjectPathForBackend(res.filePaths[0], 'wsl')
}

function normalizeAgentMessageForRenderer(message: SDKMessage): SDKMessage {
  if (!useWslClaudeBackend() || message.type !== 'system') return message
  const cwd = (message as { cwd?: unknown }).cwd
  if (typeof cwd !== 'string') return message
  const normalized = fromWslPath(cwd)
  if (!normalized || normalized === cwd) return message
  return { ...(message as unknown as Record<string, unknown>), cwd: normalized } as SDKMessage
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
            path: rendererPathFromNativePath(childPath),
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
          path: rendererPathFromNativePath(p),
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
        path: rendererPathFromNativePath(p),
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
        message: normalizeAgentMessageForRenderer(message)
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
            title: error ? 'Forge · 会话出错' : 'Forge · 会话完成',
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
      getForgeTray()?.setTooltip?.('Forge')
    },
    onPermissionRequest: (req: PermissionRequestPayload) => {
      send('forge:permission-request', req)
    }
  })

  ipcMain.handle('forge:startSession', async (_e, opts: StartSessionOptions): Promise<StartSessionResult> => {
    log('ipc', `startSession agent=${opts.agentBackend ?? 'default'} cwd=${opts.cwd} model=${opts.model ?? 'default'}`)
    const sessionId = await bridge.start(opts)
    getForgeTray()?.setTooltip?.('Forge · 运行中…')
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

  ipcMain.handle('forge:closeSession', async (_e, sessionId: string): Promise<void> => {
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
      defaultPath: fromWslPath(cwd) ?? cwd,
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

  ipcMain.handle('forge:listSkills', async (_e, sessionId: string): Promise<SkillInfo[]> => {
    try {
      return await bridge.listSkills(sessionId)
    } catch (err) {
      log('ipc', `listSkills failed: ${err instanceof Error ? err.message : String(err)}`)
      throw err
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
        title: 'Export Forge diagnostic report',
        defaultPath: `forge-diagnostic-${stamp}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (res.canceled || !res.filePath) return { canceled: true }
      const report = await buildDiagnosticReport(options)
      writeFileSync(res.filePath, report, 'utf8')
      return { path: res.filePath }
    }
  )
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
  ipcMain.handle('forge:toggleMaximizeWindow', async (): Promise<void> => {
    withWindow((win) => {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    })
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
        getForgeTray()?.setTooltip?.('Forge — 后台运行中')
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
  ipcMain.handle('forge:addProject', async (_e, path: string, name?: string): Promise<Project[]> => {
    const backend = projectBackendFromPath(path)
    enableWslPreferencesForProjectBackend(backend)
    return addProject(normalizeProjectPathForBackend(path, backend), name)
  })
  ipcMain.handle('forge:removeProject', async (_e, path: string): Promise<Project[]> =>
    removeProject(path)
  )
  ipcMain.handle('forge:renameProject', async (_e, path: string, name: string): Promise<Project[]> =>
    renameProject(path, name)
  )
  ipcMain.handle('forge:setLastProject', async (_e, path: string): Promise<void> => {
    const backend = projectBackendFromPath(path)
    enableWslPreferencesForProjectBackend(backend)
    setLastProject(normalizeProjectPathForBackend(path, backend))
  })
  ipcMain.handle('forge:getStartupProject', async (): Promise<Project | null> => {
    const project = getStartupProject()
    if (project) enableWslPreferencesForProjectBackend(projectBackendFromPath(project.path))
    return project
  })

  ipcMain.handle('forge:listSessions', async (_e, cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]> => {
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50
    const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0
    if (currentAgentBackend() === 'codex') {
      return listCodexSessions(cwd, { limit, offset })
    }
    if (currentAgentBackend() === 'hermes') {
      return listHermesSessions(cwd, { limit, offset })
    }
    const wslSupportEnabled = getPreferences().wslSupportEnabled === true
    const requestedBackend =
      !wslSupportEnabled && (opts?.backend === 'wsl' || opts?.backend === 'all')
        ? 'windows'
        : opts?.backend ?? currentClaudeBackend()

    const readWindowsSessions = async (readLimit: number, readOffset: number): Promise<SessionListItem[]> => {
      const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
      const sessions = await listSessions({ dir: cwd, limit: readLimit, offset: readOffset })
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        agentBackend: 'claude-code' as const,
        summary: s.summary,
        lastModified: s.lastModified,
        cwd: s.cwd ?? undefined,
        gitBranch: s.gitBranch ?? undefined,
        runtimeBackend: 'windows' as const
      }))
    }

    const readWslSessions = async (readLimit: number, readOffset: number): Promise<SessionListItem[]> => {
      if (process.platform !== 'win32') return []
      const sessions = await listWslSessions(cwd, { limit: readLimit, offset: readOffset })
      return sessions.map((session) => ({
        ...session,
        agentBackend: 'claude-code' as const,
        runtimeBackend: 'wsl' as const
      }))
    }

    try {
      if (requestedBackend === 'all') {
        const readLimit = offset + limit
        const [windowsSessions, wslSessions] = await Promise.all([
          readWindowsSessions(readLimit, 0).catch((err) => {
            log('ipc', `list Windows sessions failed: ${err instanceof Error ? err.message : String(err)}`)
            return [] as SessionListItem[]
          }),
          readWslSessions(readLimit, 0).catch((err) => {
            log('ipc', `list WSL sessions failed: ${err instanceof Error ? err.message : String(err)}`)
            return [] as SessionListItem[]
          })
        ])
        return [...windowsSessions, ...wslSessions]
          .sort((a, b) => b.lastModified - a.lastModified)
          .slice(offset, offset + limit)
      }

      if (useWslClaudeBackend(requestedBackend)) return await readWslSessions(limit, offset)
      return await readWindowsSessions(limit, offset)
    } catch (err) {
      console.error('[forge] listSessions failed:', err)
      return []
    }
  })

  ipcMain.handle('forge:getSessionMessages', async (
    _e,
    sessionId: string,
    cwd: string,
    backend?: ClaudeExecutionBackend
  ): Promise<HistoryMessage[]> => {
    try {
      if (currentAgentBackend() === 'codex') {
        return getCodexSessionMessages(sessionId)
      }
      if (currentAgentBackend() === 'hermes') {
        return getHermesSessionMessages(sessionId)
      }
      if (useWslClaudeBackend(backend ?? currentClaudeBackend())) {
        return await getWslSessionMessages(sessionId, cwd)
      }
      const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
      const msgs = await getSessionMessages(sessionId, { dir: cwd, limit: 500 })
      return msgs as unknown as HistoryMessage[]
    } catch (err) {
      log('ipc', `getSessionMessages failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
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
      if (currentAgentBackend() === 'codex') {
        renameCodexSession(sessionId, title)
        return
      }
      if (currentAgentBackend() === 'hermes') {
        renameHermesSession(sessionId, title)
        return
      }
      if (useWslClaudeBackend(backend ?? currentClaudeBackend())) {
        await renameWslSession(sessionId, title, cwd)
        return
      }
      const { renameSession } = await import('@anthropic-ai/claude-agent-sdk')
      await renameSession(sessionId, title, { dir: cwd })
    }
  )

  ipcMain.handle(
    'forge:deleteSession',
    async (
      _e,
      sessionId: string,
      cwd: string,
      backend?: ClaudeExecutionBackend
    ): Promise<void> => {
      if (currentAgentBackend() === 'codex') {
        deleteCodexSession(sessionId)
        return
      }
      if (currentAgentBackend() === 'hermes') {
        deleteHermesSession(sessionId)
        return
      }
      if (useWslClaudeBackend(backend ?? currentClaudeBackend())) {
        await deleteWslSession(sessionId, cwd)
        return
      }
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk')
      await deleteSession(sessionId, { dir: cwd })
    }
  )

  ipcMain.handle(
    'forge:getSubagentMessages',
    async (_e, sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]> => {
      try {
        if (currentAgentBackend() === 'codex') return []
        if (currentAgentBackend() === 'hermes') return []
        if (useWslClaudeBackend()) return await getWslSubagentMessages(sessionId, agentId, cwd)
        const { getSubagentMessages } = await import('@anthropic-ai/claude-agent-sdk')
        const msgs = await getSubagentMessages(sessionId, agentId, { dir: cwd, limit: 500 })
        return msgs as unknown as HistoryMessage[]
      } catch (err) {
        log('ipc', `getSubagentMessages failed: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    }
  )

  ipcMain.handle(
    'forge:pickDirectory',
    async (_e, options?: PickDirectoryOptions): Promise<string | null> => {
      const backend = options?.backend ?? currentClaudeBackend()
      if (useWslClaudeBackend(backend)) return pickWslDirectory()

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
