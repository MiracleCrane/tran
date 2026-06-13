import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { AgentBridge } from './agent/AgentBridge'
import { getApiKey, setApiKey } from './settings'
import { log } from './logger'
import type {
  StartSessionOptions,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload,
  SessionListItem,
  StartSessionResult,
  HistoryMessage
} from '../shared/ipc'

export function registerIpc(getMainWindow: () => BrowserWindow | null): AgentBridge {
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

  ipcMain.handle('forge:sendMessage', async (_e, sessionId: string, text: string): Promise<void> => {
    log('ipc', `sendMessage session=${sessionId}`)
    bridge.send(sessionId, text)
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
