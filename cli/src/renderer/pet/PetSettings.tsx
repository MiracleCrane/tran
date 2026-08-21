import { useEffect, useRef, useState } from 'react'
import SettingText from '../components/SettingText'
import { usePetStore } from '../store/petStore'
import { resetInAppPetPosition } from './useDraggablePetPosition'

interface PetToggleProps {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

function PetToggle({ label, description, checked, disabled = false, onChange }: PetToggleProps): JSX.Element {
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? 'opacity-55' : ''}`}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-zinc-200">{label}</div>
        <SettingText className="mt-1">{description}</SettingText>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-accent' : 'bg-zinc-700'
        } ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-150 ease-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

type SaveStatus = 'saved' | 'error' | null

export default function PetSettings(): JSX.Element {
  const [desktopPet, setDesktopPet] = useState(true)
  const [petOutside, setPetOutside] = useState(true)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SaveStatus>(null)
  const clearStatusTimer = useRef<number | null>(null)

  const flashStatus = (next: Exclude<SaveStatus, null>): void => {
    setStatus(next)
    if (clearStatusTimer.current !== null) window.clearTimeout(clearStatusTimer.current)
    clearStatusTimer.current = window.setTimeout(() => setStatus(null), 1600)
  }

  useEffect(() => {
    let active = true
    void window.api.getPreferences().then((preferences) => {
      if (!active) return
      setDesktopPet(preferences.desktopPetEnabled !== false)
      setPetOutside(preferences.petOutsideEnabled !== false)
      setLoading(false)
    })
    return () => {
      active = false
      if (clearStatusTimer.current !== null) window.clearTimeout(clearStatusTimer.current)
    }
  }, [])

  const toggleDesktopPet = async (next: boolean): Promise<void> => {
    setDesktopPet(next)
    try {
      await window.api.savePreferences({ desktopPetEnabled: next })
      usePetStore.getState().setMasterEnabled(next)
      flashStatus('saved')
    } catch {
      setDesktopPet(!next)
      flashStatus('error')
    }
  }

  const togglePetOutside = async (next: boolean): Promise<void> => {
    setPetOutside(next)
    try {
      await window.api.savePreferences({ petOutsideEnabled: next })
      flashStatus('saved')
    } catch {
      setPetOutside(!next)
      flashStatus('error')
    }
  }

  const resetPosition = async (): Promise<void> => {
    try {
      await resetInAppPetPosition()
      flashStatus('saved')
    } catch {
      flashStatus('error')
    }
  }

  return (
    <section className="glass-panel-soft rounded-2xl p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">宠物</h2>
          <SettingText className="mt-1">
            管理 Tran 内的动态宠物和窗口外悬浮宠物；Tran 内宠物可直接拖动，位置会自动保存。
          </SettingText>
        </div>
        <span className={`text-[11px] ${status === 'error' ? 'text-red-400' : 'text-zinc-500'}`}>
          {status === 'saved' ? '已保存' : status === 'error' ? '保存失败' : ''}
        </span>
      </div>

      <div className="space-y-5">
        <PetToggle
          label="显示宠物"
          description="在 Tran 界面内显示动态宠物，并根据 Agent 状态切换干活、等待、完成和错误动画。"
          checked={desktopPet}
          disabled={loading}
          onChange={(checked) => void toggleDesktopPet(checked)}
        />
        <PetToggle
          label="在 Tran 窗口外显示"
          description="额外创建透明置顶的桌面悬浮宠物；可以拖动、右键隐藏，并在 Tran 最小化后继续显示。"
          checked={petOutside}
          disabled={loading || !desktopPet}
          onChange={(checked) => void togglePetOutside(checked)}
        />

        <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-zinc-200">Tran 窗口内位置</div>
            <SettingText className="mt-1">
              按住宠物并拖动即可调整位置。如果宠物被移动到不方便的位置，可恢复到默认右下角。
            </SettingText>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void resetPosition()}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            恢复默认位置
          </button>
        </div>
      </div>
    </section>
  )
}
