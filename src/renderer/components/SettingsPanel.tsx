import { useEffect, useState } from 'react'
import type { Preferences, ComposerModel, EffortLevel, PermissionMode } from '../../shared/ipc'
import { useAppearanceStore } from '../store/appearanceStore'
import DisclosureSelect from './DisclosureSelect'

const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '很高' },
  { id: 'max', label: '最大' }
]

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: '默认(每次询问)' },
  { id: 'acceptEdits', label: '自动接受编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'bypassPermissions', label: '跳过权限(慎用)' },
  { id: 'auto', label: '自动' }
]

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className="block">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-zinc-500">{label}</span>
        <span className="font-mono text-xs text-zinc-400">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer accent-[#df765f]"
      />
    </label>
  )
}

export default function SettingsPanel(): JSX.Element {
  const [effort, setEffort] = useState<EffortLevel>('high')
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [models, setModels] = useState<ComposerModel[]>([])
  const [vulkan, setVulkan] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const appearance = useAppearanceStore((s) => s.settings)
  const updateAppearance = useAppearanceStore((s) => s.updateSetting)
  const resetAppearance = useAppearanceStore((s) => s.reset)

  useEffect(() => {
    void window.api.getPreferences().then((p) => {
      setEffort(p.defaultEffort ?? 'high')
      setPermMode(p.defaultPermissionMode ?? 'default')
      setModels(p.composerModels ?? [])
      setVulkan(!!p.vulkanBackend)
      setLoaded(true)
    })
  }, [])

  /** Vulkan toggle applies immediately (it only takes effect after restart, so
   *  no point waiting for the Save button). Persists just this field. */
  const toggleVulkan = async (next: boolean): Promise<void> => {
    setVulkan(next)
    try {
      await window.api.savePreferences({ vulkanBackend: next })
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setVulkan(!next) // revert on failure
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const cleanModels = models
        .map((m) => ({ id: m.id.trim(), label: m.label.trim() }))
        .filter((m) => m.id)
      await window.api.savePreferences({
        defaultEffort: effort,
        defaultPermissionMode: permMode,
        composerModels: cleanModels
      })
      setModels(cleanModels)
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const addModel = (): void => setModels((m) => [...m, { id: '', label: '' }])
  const updateModel = (i: number, patch: Partial<ComposerModel>): void =>
    setModels((m) => m.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  const removeModel = (i: number): void => setModels((m) => m.filter((_, idx) => idx !== i))

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'
  const labelCls = 'mb-1.5 block text-xs text-zinc-500'

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">加载中…</div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        <h1 className="text-lg font-semibold text-zinc-100">设置</h1>

        <section className="glass-panel-soft rounded-2xl p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-200">个性化</h2>
            <button
              type="button"
              onClick={resetAppearance}
              className="rounded-lg px-2 py-1 text-xs text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
            >
              重置
            </button>
          </div>
          <div className="space-y-4">
            <RangeControl
              label="动画速度"
              value={appearance.motionSpeed}
              min={70}
              max={150}
              step={5}
              display={`${appearance.motionSpeed}%`}
              onChange={(value) => updateAppearance('motionSpeed', value)}
            />
          </div>
        </section>

        <section>
          <label className={labelCls}>默认思考强度(effort)</label>
          <DisclosureSelect
            value={effort}
            options={EFFORTS.map((e) => ({ value: e.id, label: `${e.label}(${e.id})` }))}
            onChange={(v) => setEffort(v as EffortLevel)}
            className="w-full"
          />
        </section>

        <section>
          <label className={labelCls}>默认权限模式</label>
          <DisclosureSelect
            value={permMode}
            options={PERMISSION_MODES.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(v) => setPermMode(v as PermissionMode)}
            className="w-full"
          />
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs text-zinc-500">Composer 模型列表(留空用内置)</label>
            <button onClick={addModel} className="text-xs text-accent hover:underline">
              + 添加
            </button>
          </div>
          <div className="space-y-2">
            {models.map((m, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={m.label}
                  onChange={(e) => updateModel(i, { label: e.target.value })}
                  placeholder="显示名"
                  className={`${inputCls} flex-1`}
                />
                <input
                  value={m.id}
                  onChange={(e) => updateModel(i, { id: e.target.value })}
                  placeholder="模型 id"
                  className={`${inputCls} flex-1 font-mono`}
                />
                <button
                  onClick={() => removeModel(i)}
                  className="shrink-0 rounded-lg border border-border-subtle bg-bg-elev px-3 text-xs text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                >
                  删除
                </button>
              </div>
            ))}
            {models.length === 0 && (
              <div className="text-xs text-zinc-600">未配置,使用内置列表(Opus/Sonnet/Haiku)。</div>
            )}
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          {savedAt && <span className="text-xs text-emerald-400">已保存</span>}
        </div>

        <section className="glass-panel-soft rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <label className="text-xs text-zinc-500">Vulkan GPU 合成后端(实验)</label>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                让 Chromium 的合成走 ANGLE Vulkan 后端(默认 D3D11)。某些显卡上更流畅,某些驱动上可能闪烁或不稳。更改需重启生效,默认关闭。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void toggleVulkan(!vulkan)}
              aria-pressed={vulkan}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${vulkan ? 'bg-accent' : 'bg-zinc-700'}`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  vulkan ? 'left-[22px]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </section>

        <p className="text-[11px] leading-relaxed text-zinc-600">
          effort 与权限模式对**新建对话**生效(当前会话不变);模型列表保存后立即更新 Composer 下拉。
        </p>
      </div>
    </div>
  )
}
