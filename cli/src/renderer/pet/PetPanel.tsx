import { useCallback } from 'react'
import { useUiStore } from '../store/uiStore'
import PetSettings from './PetSettings'

/**
 * 侧栏「宠物」页（2026-08-27 用户改口：宠物设置从设置页搬回侧栏一级入口）。
 * 内容就是 PetSettings（自足组件：总开关 / 窗口外悬浮 / 位置重置，自己拉取
 * 保存偏好）；本组件只提供页面壳（吸顶标题 + 返回对话）。
 */
export default function PetPanel(): JSX.Element {
  const backToChat = useCallback((): void => {
    useUiStore.getState().setView('chat')
  }, [])

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        {/* 吸顶标题栏（与 AssistantPanel 同款）：下滚后"返回对话"仍可点。 */}
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={backToChat}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">宠物</h1>
        </div>
        <PetSettings />
      </div>
    </div>
  )
}
