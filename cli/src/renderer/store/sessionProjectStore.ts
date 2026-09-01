import { create } from 'zustand'

/**
 * 会话→项目归属的渲染层镜像（2026-08-27「移动到项目」）。
 *
 * 归属 = Tran 侧元数据（主进程 session-projects.json），会话 cwd 原地不动。
 * 键 = Sidebar.sessionKey（`${runtimeBackend ?? 'windows'}:${sessionId}`）；
 * 值 = projectId（2026-09-01 项目一等实体化；旧数据可能是没换算成 id 的
 * 项目路径串，消费方按 id→路径两级解析），null = 显式「不在项目中工作」，
 * 无条目 = 跟随 cwd（默认）。
 * 独立于 sessionStore 放：同 archiveStore 的理由——那文件已经够大，且归属
 * 的生命周期与会话运行态无关。
 */

interface SessionProjectStore {
  /** null = 还没加载过（首次读取前按「无覆盖」渲染，IPC 回来再纠偏）。 */
  assignments: Record<string, string | null> | null
  /** 最近一次设置失败的原因（存档文件损坏等），供需要处展示。 */
  lastError: string | null
  loadAssignments: () => Promise<void>
  /** projectId undefined = 清除覆盖（回到跟随 cwd）。乐观更新，失败回滚。 */
  setAssignment: (sessionKey: string, projectId: string | null | undefined) => Promise<void>
}

/** 乐观更新的代数：load 慢返回不得覆盖其后发生的 setAssignment。 */
let mutationSeq = 0

export const useSessionProjectStore = create<SessionProjectStore>((set, get) => ({
  assignments: null,
  lastError: null,
  loadAssignments: async () => {
    const seqAtStart = mutationSeq
    try {
      const assignments = await window.api.getSessionProjectAssignments()
      // 加载期间用户改过归属：旧快照作废，以乐观状态为准（下次 load 纠偏）。
      if (mutationSeq !== seqAtStart) return
      set({ assignments })
    } catch {
      /* 读不到就当作没有覆盖——不阻塞侧栏 */
    }
  },
  setAssignment: async (sessionKey, projectId) => {
    // 乐观更新：归属是纯本地元数据，失败即回滚。
    mutationSeq += 1
    const prev = get().assignments ?? {}
    const next = { ...prev }
    if (projectId === undefined) delete next[sessionKey]
    else next[sessionKey] = projectId
    set({ assignments: next, lastError: null })
    try {
      await window.api.setSessionProjectAssignment(sessionKey, projectId)
    } catch (e) {
      set({ assignments: prev, lastError: e instanceof Error ? e.message : String(e) })
    }
  }
}))
