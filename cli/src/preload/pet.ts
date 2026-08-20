import { contextBridge, ipcRenderer } from 'electron'
import type { PetApi, PetState } from '../shared/ipc'

/**
 * 桌面宠物窗口的 preload：只暴露一个极小的 petApi（状态订阅 + 拖拽 + 右键菜单），
 * 不带主窗口那套完整 ForgeApi——宠物窗口不接触会话/文件/设置任何能力。
 */
const petApi: PetApi = {
  onState: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PetState): void => cb(state)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  },
  openContextMenu: () => ipcRenderer.send('pet:context-menu')
}

try {
  contextBridge.exposeInMainWorld('petApi', petApi)
} catch (err) {
  console.error('[pet:preload] failed to expose petApi', err)
}
