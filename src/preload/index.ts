import { contextBridge, ipcRenderer } from 'electron'
import type {
  ForgeApi,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload
} from '../shared/ipc'

const api: ForgeApi = {
  startSession: (opts) => ipcRenderer.invoke('forge:startSession', opts),
  sendMessage: (sessionId, text) => ipcRenderer.invoke('forge:sendMessage', sessionId, text),
  interrupt: (sessionId) => ipcRenderer.invoke('forge:interrupt', sessionId),
  setModel: (sessionId, model) => ipcRenderer.invoke('forge:setModel', sessionId, model),
  setPermissionMode: (sessionId, mode) =>
    ipcRenderer.invoke('forge:setPermissionMode', sessionId, mode),
  closeSession: (sessionId) => ipcRenderer.invoke('forge:closeSession', sessionId),
  listSessions: (cwd) => ipcRenderer.invoke('forge:listSessions', cwd),
  getSessionMessages: (sessionId, cwd) =>
    ipcRenderer.invoke('forge:getSessionMessages', sessionId, cwd),

  pickDirectory: () => ipcRenderer.invoke('forge:pickDirectory'),
  getApiKey: () => ipcRenderer.invoke('forge:getApiKey'),
  setApiKey: (key) => ipcRenderer.invoke('forge:setApiKey', key),

  respondPermission: (resp) => ipcRenderer.invoke('forge:respondPermission', resp),

  onAgentEvent: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => cb(payload)
    ipcRenderer.on('forge:agent-event', listener)
    return () => ipcRenderer.removeListener('forge:agent-event', listener)
  },
  onPermissionRequest: (cb) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: PermissionRequestPayload
    ): void => cb(payload)
    ipcRenderer.on('forge:permission-request', listener)
    return () => ipcRenderer.removeListener('forge:permission-request', listener)
  }
}

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (err) {
  console.error('[forge:preload] failed to expose api', err)
}

export type ApiContract = typeof api
