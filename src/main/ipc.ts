import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { AgentBridge } from './agent/AgentBridge'
import { getApiKey, setApiKey } from './settings'
import { saveMcpServer, deleteMcpServer } from './mcpConfig'
import {
  listProviders,
  getActiveProvider,
  saveProvider,
  deleteProvider,
  setActiveProvider
} from './providers'
import {
  listProjects,
  addProject,
  removeProject,
  renameProject,
  setLastProject,
  getStartupProject
} from './projects'
import { listMarketplacePlugins } from './marketplace'
import { translateTexts } from './translate'
import { getPreferences, savePreferences } from './preferences'
import { log } from './logger'
import type {
  StartSessionOptions,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SessionListItem,
  StartSessionResult,
  HistoryMessage,
  SaveMcpServerArgs,
  DeleteMcpServerArgs,
  Provider,
  Project,
  SkillInfo,
  MarketplacePlugin,
  Preferences,
  PickedFile
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

export function registerIpc(getMainWindow: () => BrowserWindow | null): AgentBridge {
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

  const bridge = new AgentBridge({
    onMessage: (sessionId, message) => {
      const event: AgentEvent = { type: 'agent:message', sessionId, message }
      send('forge:agent-event', event)
    },
    onEnded: (sessionId, error) => {
      const event: AgentEvent = { type: 'agent:ended', sessionId, error }
      send('forge:agent-event', event)
    },
    onPermissionRequest: (req: PermissionRequestPayload) => {
      send('forge:permission-request', req)
    }
  })

  ipcMain.handle('forge:startSession', async (_e, opts: StartSessionOptions): Promise<StartSessionResult> => {
    log('ipc', `startSession cwd=${opts.cwd} model=${opts.model ?? 'default'}`)
    const sessionId = await bridge.start(opts)
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
    const out: PickedFile[] = []
    for (const p of res.filePaths) {
      try {
        const stat = statSync(p)
        const ext = (p.split('.').pop() ?? '').toLowerCase()
        const kind: PickedFile['kind'] = IMAGE_EXTS.has(ext)
          ? 'image'
          : TEXT_EXTS.has(ext)
            ? 'text'
            : 'other'
        const buf = readFileSync(p)
        const data =
          kind === 'image'
            ? buf.toString('base64')
            : kind === 'text'
              ? buf.toString('utf-8').slice(0, MAX_TEXT_INLINE)
              : ''
        out.push({
          path: p,
          name: basename(p),
          kind,
          mimeType: MIME[ext] ?? 'application/octet-stream',
          data,
          size: stat.size
        })
      } catch (e) {
        log('ipc', `pickFiles skip ${p}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  })

  ipcMain.handle('forge:revealInExplorer', async (_e, cwd: string, pathStr: string): Promise<boolean> => {
    const { resolve } = await import('node:path')
    const resolved = resolve(cwd, pathStr)
    if (!existsSync(resolved)) return false
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

  ipcMain.handle('forge:listMarketplacePlugins', async (): Promise<MarketplacePlugin[]> =>
    listMarketplacePlugins()
  )

  ipcMain.handle('forge:translateTexts', async (_e, texts: string[]): Promise<string[]> =>
    translateTexts(texts)
  )

  ipcMain.handle('forge:getPreferences', async (): Promise<Preferences> => getPreferences())
  ipcMain.handle('forge:savePreferences', async (_e, prefs: Preferences): Promise<Preferences> =>
    savePreferences(prefs)
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

  ipcMain.handle('forge:saveMcpServer', async (_e, args: SaveMcpServerArgs): Promise<void> => {
    saveMcpServer(args)
  })

  ipcMain.handle('forge:deleteMcpServer', async (_e, args: DeleteMcpServerArgs): Promise<boolean> => {
    return deleteMcpServer(args)
  })

  ipcMain.handle('forge:listProviders', async (): Promise<Provider[]> => listProviders())
  ipcMain.handle('forge:getActiveProvider', async (): Promise<Provider | null> => getActiveProvider())
  ipcMain.handle('forge:saveProvider', async (_e, p: Provider): Promise<Provider[]> => saveProvider(p))
  ipcMain.handle('forge:deleteProvider', async (_e, id: string): Promise<Provider[]> =>
    deleteProvider(id)
  )
  ipcMain.handle('forge:setActiveProvider', async (_e, id: string): Promise<void> => {
    log('ipc', `setActiveProvider id=${id}`)
    setActiveProvider(id)
  })

  ipcMain.handle('forge:listProjects', async (): Promise<Project[]> => listProjects())
  ipcMain.handle('forge:addProject', async (_e, path: string, name?: string): Promise<Project[]> =>
    addProject(path, name)
  )
  ipcMain.handle('forge:removeProject', async (_e, path: string): Promise<Project[]> =>
    removeProject(path)
  )
  ipcMain.handle('forge:renameProject', async (_e, path: string, name: string): Promise<Project[]> =>
    renameProject(path, name)
  )
  ipcMain.handle('forge:setLastProject', async (_e, path: string): Promise<void> =>
    setLastProject(path)
  )
  ipcMain.handle('forge:getStartupProject', async (): Promise<Project | null> =>
    getStartupProject()
  )

  ipcMain.handle('forge:listSessions', async (_e, cwd: string): Promise<SessionListItem[]> => {
    try {
      const { listSessions } = await import('@anthropic-ai/claude-agent-sdk')
      const sessions = await listSessions({ dir: cwd, limit: 50 })
      return sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        lastModified: s.lastModified,
        cwd: s.cwd ?? undefined,
        gitBranch: s.gitBranch ?? undefined
      }))
    } catch (err) {
      console.error('[forge] listSessions failed:', err)
      return []
    }
  })

  ipcMain.handle('forge:getSessionMessages', async (_e, sessionId: string, cwd: string): Promise<HistoryMessage[]> => {
    try {
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
    async (_e, sessionId: string, title: string, cwd: string): Promise<void> => {
      const { renameSession } = await import('@anthropic-ai/claude-agent-sdk')
      await renameSession(sessionId, title, { dir: cwd })
    }
  )

  ipcMain.handle(
    'forge:deleteSession',
    async (_e, sessionId: string, cwd: string): Promise<void> => {
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk')
      await deleteSession(sessionId, { dir: cwd })
    }
  )

  ipcMain.handle(
    'forge:getSubagentMessages',
    async (_e, sessionId: string, agentId: string, cwd: string): Promise<HistoryMessage[]> => {
      try {
        const { getSubagentMessages } = await import('@anthropic-ai/claude-agent-sdk')
        const msgs = await getSubagentMessages(sessionId, agentId, { dir: cwd, limit: 500 })
        return msgs as unknown as HistoryMessage[]
      } catch (err) {
        log('ipc', `getSubagentMessages failed: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    }
  )

  ipcMain.handle('forge:pickDirectory', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths.length) return null
    return res.filePaths[0]
  })

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

  return bridge
}
