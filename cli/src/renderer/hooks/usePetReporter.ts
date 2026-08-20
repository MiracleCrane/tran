import { useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { PetMood, PetState } from '../../shared/ipc'

/**
 * 把 sessionStore 的原始状态推导成桌面宠物的情绪，上报给主进程（→ 宠物窗口）。
 *
 * 映射（优先级从高到低）：
 * - waiting：有权限确认（pendingPermissions）或提问（elicitationQueue）在等用户；
 * - working：turn 在跑（含压缩上下文）；
 * - error：上一轮出错；
 * - done：working 刚结束且没出错——庆祝 4s 再回 idle；
 * - idle：其余时间。
 *
 * store 每次流式更新都会触发订阅，但 compute 是纯字段读取、send 按 key 去重，
 * 实际 IPC 只在情绪真正变化时发生。宠物关着时主进程只缓存不转发，零成本。
 */

const DONE_BUBBLE_MS = 4000

type StoreSnapshot = ReturnType<typeof useSessionStore.getState>

function computeState(s: StoreSnapshot): PetState {
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

export function usePetReporter(): void {
  useEffect(() => {
    if (typeof window.api?.petSetState !== 'function') return
    let lastKey = ''
    let prevMood: PetMood = 'idle'
    let doneTimer: number | null = null

    const send = (state: PetState): void => {
      const key = `${state.mood}|${state.label ?? ''}`
      if (key === lastKey) return
      lastKey = key
      window.api.petSetState(state)
    }

    const evaluate = (s: StoreSnapshot): void => {
      const next = computeState(s)
      if (next.mood === 'idle' && prevMood === 'working') {
        // 收工庆祝：先 done 4 秒再回 idle；期间若又开跑/出错则打断庆祝。
        prevMood = 'done'
        send({ mood: 'done', label: '搞定了' })
        doneTimer = window.setTimeout(() => {
          doneTimer = null
          const cur = computeState(useSessionStore.getState())
          prevMood = cur.mood
          send(cur)
        }, DONE_BUBBLE_MS)
        return
      }
      if (doneTimer !== null) {
        if (next.mood === 'idle') return // 庆祝期间保持 done
        window.clearTimeout(doneTimer)
        doneTimer = null
      }
      prevMood = next.mood
      send(next)
    }

    evaluate(useSessionStore.getState())
    const unsubscribe = useSessionStore.subscribe(evaluate)
    return () => {
      unsubscribe()
      if (doneTimer !== null) window.clearTimeout(doneTimer)
    }
  }, [])
}
