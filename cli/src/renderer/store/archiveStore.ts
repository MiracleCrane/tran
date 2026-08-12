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
  /** 最近一次归档/恢复失败的原因（存档文件损坏等），供归档页横幅展示。 */
  lastError: string | null
  loadArchived: () => Promise<void>
  archive: (sessionId: string) => Promise<void>
  unarchive: (sessionId: string) => Promise<void>
}

/** 乐观更新的代数：load 慢返回不得覆盖其后发生的 archive/unarchive。 */
let mutationSeq = 0

export const useArchiveStore = create<ArchiveStore>((set, get) => ({
  archivedIds: null,
  lastError: null,
  loadArchived: async () => {
    const seqAtStart = mutationSeq
    try {
      const ids = await window.api.getArchivedSessions()
      // 加载期间用户点过归档/恢复：旧快照作废，以乐观状态为准（下次 load 纠偏）。
      if (mutationSeq !== seqAtStart) return
      set({ archivedIds: ids })
    } catch {
      /* 读不到就当作没有归档——不阻塞侧栏 */
    }
  },
  archive: async (sessionId) => {
    // 乐观更新：归档是纯本地标记，失败即回滚。
    mutationSeq += 1
    const prev = get().archivedIds ?? {}
    set({ archivedIds: { ...prev, [sessionId]: Date.now() }, lastError: null })
    try {
      await window.api.archiveSession(sessionId)
    } catch (e) {
      set({ archivedIds: prev, lastError: e instanceof Error ? e.message : String(e) })
    }
  },
  unarchive: async (sessionId) => {
    mutationSeq += 1
    const prev = get().archivedIds ?? {}
    const next = { ...prev }
    delete next[sessionId]
    set({ archivedIds: next, lastError: null })
    try {
      await window.api.unarchiveSession(sessionId)
    } catch (e) {
      set({ archivedIds: prev, lastError: e instanceof Error ? e.message : String(e) })
    }
  }
}))
