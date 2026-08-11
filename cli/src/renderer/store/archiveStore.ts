import { create } from 'zustand'

/**
 * 会话归档的渲染层状态（2026-08 用户功能）。
 *
 * 归档 = Tran 侧的标记（主进程 archived-sessions.json），会话数据原地不动。
 * 侧栏列表把它过滤掉；归档页可以找回、恢复或真删。独立于 sessionStore 放：
 *  那文件已经够大，而且归档的生命周期与会话运行态无关。
 */

interface ArchiveStore {
  /** null = 还没加载过（首次读取前）。 */
  archivedIds: Record<string, number> | null
  loadArchived: () => Promise<void>
  archive: (sessionId: string) => Promise<void>
  unarchive: (sessionId: string) => Promise<void>
}

export const useArchiveStore = create<ArchiveStore>((set, get) => ({
  archivedIds: null,
  loadArchived: async () => {
    try {
      const ids = await window.api.getArchivedSessions()
      set({ archivedIds: ids })
    } catch {
      /* 读不到就当作没有归档——不阻塞侧栏 */
    }
  },
  archive: async (sessionId) => {
    // 乐观更新：归档是纯本地标记，失败代价为零。
    const prev = get().archivedIds ?? {}
    set({ archivedIds: { ...prev, [sessionId]: Date.now() } })
    try {
      await window.api.archiveSession(sessionId)
    } catch {
      set({ archivedIds: prev })
    }
  },
  unarchive: async (sessionId) => {
    const prev = get().archivedIds ?? {}
    const next = { ...prev }
    delete next[sessionId]
    set({ archivedIds: next })
    try {
      await window.api.unarchiveSession(sessionId)
    } catch {
      set({ archivedIds: prev })
    }
  }
}))
