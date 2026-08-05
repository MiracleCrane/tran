import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 短暂提示标志（「已保存」「已复制」这类 1.5s 自动消失的反馈）。
 *
 * 之前各处手写 `setXxx(true); setTimeout(() => setXxx(false), 1500)` 有两个问题：
 * 1. 连续触发时旧定时器不清理，会把新一次提示提前关掉（定时器踩踏）；
 * 2. 组件卸载后定时器照跑，setState 打在已卸载组件上。
 * 这里统一：每次触发前先清旧定时器，卸载时也清理。
 */
export function useTransientFlag(durationMs = 1500): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timerRef = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const trigger = useCallback(() => {
    clear()
    setOn(true)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setOn(false)
    }, durationMs)
  }, [clear, durationMs])

  // 卸载时清理，避免对已卸载组件 setState。
  useEffect(() => clear, [clear])

  return [on, trigger]
}
