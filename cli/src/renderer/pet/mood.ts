import type { PetMood, PetState } from '../../shared/ipc'
import type { useSessionStore } from '../store/sessionStore'

/**
 * 宠物情绪的推导（界面内 PetMascot 与桌面悬浮窗共用这一份）。
 *
 * 映射（优先级从高到低）：
 * - waiting：有权限确认（pendingPermissions）或提问（elicitationQueue）在等用户；
 * - working：turn 在跑（含压缩上下文）；
 * - error：上一轮出错；
 * - idle：其余时间（done 庆祝由 usePetReporter 在迁移边沿上叠加，见那里）。
 */

type StoreSnapshot = ReturnType<typeof useSessionStore.getState>

export function computePetState(s: StoreSnapshot): PetState {
  if (s.pendingPermissions.length > 0 || s.elicitationQueue.length > 0) {
    return {
      mood: 'waiting',
      label: s.pendingPermissions.length > 0 ? '等你确认权限' : '等你回话'
    }
  }
  if (s.status.running) {
    return { mood: 'working', label: s.status.compacting ? '正在压缩上下文…' : '正在干活…' }
  }
  if (s.status.error) return { mood: 'error', label: '出错了' }
  return { mood: 'idle' }
}

export type { PetMood, PetState }
