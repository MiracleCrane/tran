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
  renameSession: (sessionId, title, cwd) =>
    ipcRenderer.invoke('forge:renameSession', sessionId, title, cwd),
  deleteSession: (sessionId, cwd) => ipcRenderer.invoke('forge:deleteSession', sessionId, cwd),
  listMcpServers: (sessionId) => ipcRenderer.invoke('forge:listMcpServers', sessionId),
  toggleMcpServer: (sessionId, name, enabled) =>
    ipcRenderer.invoke('forge:toggleMcpServer', sessionId, name, enabled),

  listSkills: (sessionId) => ipcRenderer.invoke('forge:listSkills', sessionId),
  listMarketplacePlugins: () => ipcRenderer.invoke('forge:listMarketplacePlugins'),
  translateTexts: (texts) => ipcRenderer.invoke('forge:translateTexts', texts),
  saveMcpServer: (args) => ipcRenderer.invoke('forge:saveMcpServer', args),
  deleteMcpServer: (args) => ipcRenderer.invoke('forge:deleteMcpServer', args),

  listProviders: () => ipcRenderer.invoke('forge:listProviders'),
  getActiveProvider: () => ipcRenderer.invoke('forge:getActiveProvider'),
  saveProvider: (provider) => ipcRenderer.invoke('forge:saveProvider', provider),
  deleteProvider: (id) => ipcRenderer.invoke('forge:deleteProvider', id),
  setActiveProvider: (id) => ipcRenderer.invoke('forge:setActiveProvider', id),

  listProjects: () => ipcRenderer.invoke('forge:listProjects'),
  addProject: (path, name) => ipcRenderer.invoke('forge:addProject', path, name),
  removeProject: (path) => ipcRenderer.invoke('forge:removeProject', path),
  renameProject: (path, name) => ipcRenderer.invoke('forge:renameProject', path, name),
  setLastProject: (path) => ipcRenderer.invoke('forge:setLastProject', path),
  getStartupProject: () => ipcRenderer.invoke('forge:getStartupProject'),

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
