import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ForgeApi,
  AgentEvent,
  PermissionRequestPayload,
  PermissionResponsePayload,
  GitBranchInfo,
  GitCommit,
  GitStatus,
  UpdateCheckResult,
  UpdateDownloadProgress
} from '../shared/ipc'

function getPathForFile(file: File): string {
  const legacyPath = (file as File & { path?: string }).path ?? ''
  try {
    return webUtils.getPathForFile(file) || legacyPath
  } catch {
    return legacyPath
  }
}

const api: ForgeApi = {
  startSession: (opts) => ipcRenderer.invoke('forge:startSession', opts),
  sendMessage: (sessionId, content) => ipcRenderer.invoke('forge:sendMessage', sessionId, content),
  interrupt: (sessionId) => ipcRenderer.invoke('forge:interrupt', sessionId),
  setModel: (sessionId, model) => ipcRenderer.invoke('forge:setModel', sessionId, model),
  setPermissionMode: (sessionId, mode) =>
    ipcRenderer.invoke('forge:setPermissionMode', sessionId, mode),
  closeSession: (sessionId) => ipcRenderer.invoke('forge:closeSession', sessionId),
  listSessions: (cwd, opts) => ipcRenderer.invoke('forge:listSessions', cwd, opts),
  getSessionMessages: (sessionId, cwd, backend) =>
    ipcRenderer.invoke('forge:getSessionMessages', sessionId, cwd, backend),
  renameSession: (sessionId, title, cwd, backend) =>
    ipcRenderer.invoke('forge:renameSession', sessionId, title, cwd, backend),
  deleteSession: (sessionId, cwd, backend) =>
    ipcRenderer.invoke('forge:deleteSession', sessionId, cwd, backend),
  getSubagentMessages: (sessionId, agentId, cwd) =>
    ipcRenderer.invoke('forge:getSubagentMessages', sessionId, agentId, cwd),
  listMcpServers: (sessionId) => ipcRenderer.invoke('forge:listMcpServers', sessionId),
  toggleMcpServer: (sessionId, name, enabled) =>
    ipcRenderer.invoke('forge:toggleMcpServer', sessionId, name, enabled),
  backgroundTask: (sessionId, toolUseId) =>
    ipcRenderer.invoke('forge:backgroundTask', sessionId, toolUseId),

  pickFiles: (cwd) => ipcRenderer.invoke('forge:pickFiles', cwd),
  readFiles: (cwd, paths) => ipcRenderer.invoke('forge:readFiles', cwd, paths),
  getPathForFile,
  revealInExplorer: (cwd, pathStr) => ipcRenderer.invoke('forge:revealInExplorer', cwd, pathStr),

  listSkills: (sessionId) => ipcRenderer.invoke('forge:listSkills', sessionId),
  listMarketplacePlugins: (agentBackend, cwd) =>
    ipcRenderer.invoke('forge:listMarketplacePlugins', agentBackend, cwd),
  translateTexts: (texts) => ipcRenderer.invoke('forge:translateTexts', texts),

  getTranslateConfig: () => ipcRenderer.invoke('forge:getTranslateConfig'),
  saveTranslateConfig: (cfg) => ipcRenderer.invoke('forge:saveTranslateConfig', cfg),
  testTranslate: (appId, secretKey) =>
    ipcRenderer.invoke('forge:testTranslate', appId, secretKey),

  getPreferences: () => ipcRenderer.invoke('forge:getPreferences'),
  savePreferences: (prefs) => ipcRenderer.invoke('forge:savePreferences', prefs),
  getRuntimeStatus: (cwd, model, options) =>
    ipcRenderer.invoke('forge:getRuntimeStatus', cwd, model, options),
  runWslHealthCheck: (cwd) => ipcRenderer.invoke('forge:runWslHealthCheck', cwd),
  repairWslEnvironment: (cwd) => ipcRenderer.invoke('forge:repairWslEnvironment', cwd),
  getDiagnosticLog: () => ipcRenderer.invoke('forge:getDiagnosticLog'),
  checkForUpdates: () => ipcRenderer.invoke('forge:checkForUpdates'),
  downloadAndInstallUpdate: (options) =>
    ipcRenderer.invoke('forge:downloadAndInstallUpdate', options),
  exportDiagnosticReport: (options) => ipcRenderer.invoke('forge:exportDiagnosticReport', options),
  exportSettings: (appearance) => ipcRenderer.invoke('forge:exportSettings', appearance),
  importSettings: (backup) => ipcRenderer.invoke('forge:importSettings', backup),
  listAgentBackends: () => ipcRenderer.invoke('forge:listAgentBackends'),
  listAgentModels: () => ipcRenderer.invoke('forge:listAgentModels'),

  minimizeWindow: () => ipcRenderer.invoke('forge:minimizeWindow'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('forge:toggleMaximizeWindow'),
  closeWindow: () => ipcRenderer.invoke('forge:closeWindow'),

  resolveClose: (decision) => ipcRenderer.invoke('forge:resolveClose', decision),
  showWindow: () => ipcRenderer.invoke('forge:showWindow'),
  onClosePrompt: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('forge:show-close-prompt', listener)
    return () => ipcRenderer.removeListener('forge:show-close-prompt', listener)
  },
  onUpdateAvailable: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateCheckResult): void =>
      cb(payload)
    ipcRenderer.on('forge:update-available', listener)
    return () => ipcRenderer.removeListener('forge:update-available', listener)
  },
  onUpdateDownloadProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: UpdateDownloadProgress): void =>
      cb(payload)
    ipcRenderer.on('forge:update-download-progress', listener)
    return () => ipcRenderer.removeListener('forge:update-download-progress', listener)
  },
  onProvidersChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('forge:providers-changed', listener)
    return () => ipcRenderer.removeListener('forge:providers-changed', listener)
  },

  saveMcpServer: (args) => ipcRenderer.invoke('forge:saveMcpServer', args),
  deleteMcpServer: (args) => ipcRenderer.invoke('forge:deleteMcpServer', args),

  listProviders: () => ipcRenderer.invoke('forge:listProviders'),
  getActiveProvider: () => ipcRenderer.invoke('forge:getActiveProvider'),
  getProviderProfiles: () => ipcRenderer.invoke('forge:getProviderProfiles'),
  saveProvider: (provider) => ipcRenderer.invoke('forge:saveProvider', provider),
  saveProviderForBackend: (backend, provider) =>
    ipcRenderer.invoke('forge:saveProviderForBackend', backend, provider),
  deleteProvider: (id) => ipcRenderer.invoke('forge:deleteProvider', id),
  deleteProviderForBackend: (backend, id) =>
    ipcRenderer.invoke('forge:deleteProviderForBackend', backend, id),
  setActiveProvider: (id) => ipcRenderer.invoke('forge:setActiveProvider', id),
  setActiveProviderForBackend: (backend, id) =>
    ipcRenderer.invoke('forge:setActiveProviderForBackend', backend, id),
  saveComposerModelsForBackend: (backend, models) =>
    ipcRenderer.invoke('forge:saveComposerModelsForBackend', backend, models),

  listProjects: () => ipcRenderer.invoke('forge:listProjects'),
  addProject: (path, name) => ipcRenderer.invoke('forge:addProject', path, name),
  removeProject: (path) => ipcRenderer.invoke('forge:removeProject', path),
  renameProject: (path, name) => ipcRenderer.invoke('forge:renameProject', path, name),
  setLastProject: (path) => ipcRenderer.invoke('forge:setLastProject', path),
  getStartupProject: () => ipcRenderer.invoke('forge:getStartupProject'),

  pickDirectory: (options) => ipcRenderer.invoke('forge:pickDirectory', options),
  getApiKey: () => ipcRenderer.invoke('forge:getApiKey'),
  setApiKey: (key) => ipcRenderer.invoke('forge:setApiKey', key),

  respondPermission: (resp) => ipcRenderer.invoke('forge:respondPermission', resp),

  // --- Git integration ---
  isGitRepo: (cwd) => ipcRenderer.invoke('forge:gitIsRepo', cwd),
  gitGetCurrentBranch: (cwd) => ipcRenderer.invoke('forge:gitGetCurrentBranch', cwd),
  gitListBranches: (cwd) => ipcRenderer.invoke('forge:gitListBranches', cwd),
  gitCheckoutBranch: (cwd, branch) => ipcRenderer.invoke('forge:gitCheckoutBranch', cwd, branch),
  gitCreateBranch: (cwd, name) => ipcRenderer.invoke('forge:gitCreateBranch', cwd, name),
  gitDeleteBranch: (cwd, name, force) => ipcRenderer.invoke('forge:gitDeleteBranch', cwd, name, force),
  gitPull: (cwd) => ipcRenderer.invoke('forge:gitPull', cwd),
  gitPush: (cwd) => ipcRenderer.invoke('forge:gitPush', cwd),
  gitStatus: (cwd) => ipcRenderer.invoke('forge:gitStatus', cwd),
  gitAdd: (cwd, paths) => ipcRenderer.invoke('forge:gitAdd', cwd, paths),
  gitCommit: (cwd, message) => ipcRenderer.invoke('forge:gitCommit', cwd, message),
  gitLog: (cwd, limit) => ipcRenderer.invoke('forge:gitLog', cwd, limit),
  gitStash: (cwd, action, message) => ipcRenderer.invoke('forge:gitStash', cwd, action, message),
  gitRevert: (cwd, commitHash) => ipcRenderer.invoke('forge:gitRevert', cwd, commitHash),
  gitDiff: (cwd, opts) => ipcRenderer.invoke('forge:gitDiff', cwd, opts),
  gitFetch: (cwd) => ipcRenderer.invoke('forge:gitFetch', cwd),
  gitReset: (cwd, paths) => ipcRenderer.invoke('forge:gitReset', cwd, paths),
  gitPushUpstream: (cwd) => ipcRenderer.invoke('forge:gitPushUpstream', cwd),

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
