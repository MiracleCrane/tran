import { useEffect } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { usePetStore } from '../store/petStore'
import { computePetState } from '../pet/mood'
import type { PetMood, PetState } from '../../shared/ipc'

/**
 * 宠物状态的唯一计算点：订阅 sessionStore，推导情绪（含 done 的 4s 庆祝时序），
 * 同时分发给两个消费者——
 * - 渲染层 petStore（界面内 PetMascot 订阅，零 IPC）；
 * - 主进程 pet:set-state（转发给桌面悬浮窗，关着时只缓存不渲染，零成本）。
 *
 * store 每次流式更新都会触发订阅，但 compute 是纯字段读取、分发按 key 去重，
 * 实际写入只在情绪真正变化时发生。
 */

const DONE_BUBBLE_MS = 4000

type StoreSnapshot = ReturnType<typeof useSessionStore.getState>

export function usePetReporter(): void {
  useEffect(() => {
    const setMood = usePetStore.getState().setMood
    const canReport = typeof window.api?.petSetState === 'function'
    let lastKey = ''
    let prevMood: PetMood = 'idle'
    let doneTimer: number | null = null

    const publish = (state: PetState): void => {
      const key = `${state.mood}|${state.label ?? ''}`
      if (key === lastKey) return
      lastKey = key
      setMood(state.mood, state.label ?? null)
      if (canReport) window.api.petSetState(state)
    }

    const evaluate = (s: StoreSnapshot): void => {
      const next = computePetState(s)
      if (next.mood === 'idle' && prevMood === 'working') {
        // 收工庆祝：先 done 4 秒再回 idle；期间若又开跑/出错则打断庆祝。
        prevMood = 'done'
        publish({ mood: 'done', label: '搞定了' })
        doneTimer = window.setTimeout(() => {
          doneTimer = null
          const cur = computePetState(useSessionStore.getState())
          prevMood = cur.mood
          publish(cur)
        }, DONE_BUBBLE_MS)
        return
      }
      if (doneTimer !== null) {
        if (next.mood === 'idle') return // 庆祝期间保持 done
        window.clearTimeout(doneTimer)
        doneTimer = null
      }
      prevMood = next.mood
      publish(next)
    }

    evaluate(useSessionStore.getState())
    const unsubscribe = useSessionStore.subscribe(evaluate)
    return () => {
      unsubscribe()
      if (doneTimer !== null) window.clearTimeout(doneTimer)
    }
  }, [])
}
