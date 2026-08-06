import { useEffect, useState } from 'react'

/**
 * 思考翻译当前实际落在哪条通道，以及是不是「auto 回落」。
 *
 * 存在的理由：`auto` 在没配百度密钥时会回落到摘要 API（DeepSeek 等）——那是**要
 * 花钱的**。悄悄回落就是悄悄花钱，用户看到的只是"翻译好了"，不知道钱从哪出。
 * 所以凡是回落生效，界面上必须说一句。
 *
 * 不新增 IPC：getTranslateConfig 本来就把 thinkingEngine 和 baidu.appId 一起
 * 回来了，判断条件在渲染层就能算。
 *
 * 结果按模块级缓存 + 订阅：每个思考块都独立拉一次配置的话，一屏几十个块就是
 * 几十次 IPC。设置页改完引擎后调用 refreshThinkingTranslateStatus() 即可刷新。
 */

export interface ThinkingTranslateStatus {
  /** 实际生效的通道。null = 还没拉到配置。 */
  engine: 'baidu' | 'llm' | null
  /** 选的是 auto、但因为没配百度密钥而回落到了付费模型。 */
  autoFellBack: boolean
}

const UNKNOWN: ThinkingTranslateStatus = { engine: null, autoFellBack: false }

let cached: ThinkingTranslateStatus = UNKNOWN
let inflight: Promise<void> | null = null
const listeners = new Set<(s: ThinkingTranslateStatus) => void>()

function emit(next: ThinkingTranslateStatus): void {
  cached = next
  for (const fn of listeners) fn(next)
}

function load(): Promise<void> {
  if (inflight) return inflight
  inflight = window.api
    .getTranslateConfig()
    .then((cfg) => {
      const hasBaidu = !!cfg.baidu.appId.trim()
      const engine: 'baidu' | 'llm' =
        cfg.thinkingEngine === 'auto' ? (hasBaidu ? 'baidu' : 'llm') : cfg.thinkingEngine
      emit({ engine, autoFellBack: cfg.thinkingEngine === 'auto' && !hasBaidu })
    })
    .catch(() => {
      // 拉不到配置就当"未知"：宁可不提示，也不要瞎报一个通道误导用户。
      emit(UNKNOWN)
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 设置页保存翻译配置后调用，让已挂载的思考块立刻跟上。 */
export function refreshThinkingTranslateStatus(): void {
  inflight = null
  void load()
}

export function useThinkingTranslateStatus(enabled: boolean): ThinkingTranslateStatus {
  const [status, setStatus] = useState<ThinkingTranslateStatus>(cached)

  useEffect(() => {
    if (!enabled) return
    listeners.add(setStatus)
    if (cached.engine === null) void load()
    else setStatus(cached)
    return () => {
      listeners.delete(setStatus)
    }
  }, [enabled])

  return status
}
