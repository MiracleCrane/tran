import { useCallback, useEffect, useState } from 'react'
import {
  conflictingActions,
  isShortcutOverridden,
  normalizeKeyEvent,
  resetShortcutBinding,
  resolvedShortcuts,
  setShortcutBinding,
  type ShortcutAction
} from '../shortcuts'
import SettingText from './SettingText'
import HoverTip from './HoverTip'

/**
 * 快捷键设置：列出全部动作、就地录制新键位、冲突检测、恢复默认。
 *
 * 录制过程刻意接管整个键盘（capture 阶段 + preventDefault）：不然按下 Ctrl+N
 * 会先被全局监听吃掉、真去新建一个对话，用户想改键反而触发了动作。
 */

/** 录制时忽略的裸修饰键——它们只是组合键的一半，不能单独成为绑定。 */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta'])

function KeyCap({ combo }: { combo: string }): JSX.Element {
  return (
    <kbd className="rounded border border-white/[0.12] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
      {combo}
    </kbd>
  )
}

export default function ShortcutSettings(): JSX.Element {
  const [actions, setActions] = useState<ShortcutAction[]>(() => resolvedShortcuts())
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ id: string; withLabels: string[] } | null>(null)

  const refresh = useCallback(() => setActions(resolvedShortcuts()), [])

  useEffect(() => {
    if (!recordingId) return
    const onKeyDown = (e: KeyboardEvent): void => {
      // 录制期间任何按键都归我：不拦的话组合键会先去触发它原本的动作。
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecordingId(null)
        setConflict(null)
        return
      }
      if (MODIFIER_KEYS.has(e.key)) return
      const combo = normalizeKeyEvent(e)
      const clash = conflictingActions(recordingId, [combo])
      if (clash.length > 0) {
        // 撞车不静默覆盖：两个动作绑同一个键时，全局监听只会命中先注册的那个，
        // 后者永远不触发，而设置页看起来"两个都绑好了"。
        const all = resolvedShortcuts()
        setConflict({
          id: recordingId,
          withLabels: clash.map((id) => all.find((a) => a.id === id)?.label ?? id)
        })
        return
      }
      setShortcutBinding(recordingId, [combo])
      setRecordingId(null)
      setConflict(null)
      refresh()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [recordingId, refresh])

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-semibold text-zinc-200">快捷键</div>
        <SettingText className="mt-1">
          选择右侧键位后，按下新的组合键即可完成绑定。录制过程中按 `Esc` 取消；更改会立即生效并在重启后保留。
        </SettingText>
      </div>

      <div className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-border-subtle bg-bg-panel">
        {actions.map((action) => {
          const recording = recordingId === action.id
          const overridden = isShortcutOverridden(action.id)
          return (
            <div key={action.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{action.label}</span>
              {overridden && (
                <button
                  type="button"
                  onClick={() => {
                    resetShortcutBinding(action.id)
                    refresh()
                  }}
                  className="shrink-0 text-[10px] text-zinc-600 transition hover:text-zinc-400"
                >
                  恢复默认
                </button>
              )}
              <HoverTip
                tip={recording ? '按下新的组合键，Esc 取消' : '点击重新绑定'}
                className="inline-flex shrink-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    setConflict(null)
                    setRecordingId(recording ? null : action.id)
                  }}
                  className={`rounded-lg px-2 py-1 transition ${
                    recording ? 'bg-accent/20 text-accent' : 'hover:bg-white/[0.06]'
                  }`}
                >
                  {recording ? (
                    <span className="text-[10px]">按下组合键…</span>
                  ) : (
                    <span className="flex items-center gap-1">
                      {action.keys.map((k) => (
                        <KeyCap key={k} combo={k} />
                      ))}
                    </span>
                  )}
                </button>
              </HoverTip>
            </div>
          )
        })}
      </div>

      {conflict && (
        <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-300/90">
          该组合键已分配给“{conflict.withLabels.join('、')}”。请选择其他组合键。
        </div>
      )}
    </div>
  )
}
