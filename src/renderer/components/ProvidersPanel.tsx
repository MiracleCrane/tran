import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import ProviderFormModal from './ProviderFormModal'
import type {
  ClaudeExecutionBackend,
  ComposerModel,
  Provider,
  ProviderProfile,
  ProviderProfiles
} from '../../shared/ipc'

const AUTH_LABEL: Record<string, string> = {
  bearer: 'Bearer Token',
  apikey: 'API Key'
}

function notifyProviderChanged(): void {
  window.dispatchEvent(new Event('forge:provider-changed'))
}

function notifyModelsChanged(): void {
  window.dispatchEvent(new Event('forge:model-options-changed'))
}

function blankProvider(): Provider {
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: 'https://api.anthropic.com',
    token: '',
    authType: 'bearer',
    model: 'claude-opus-4-8'
  }
}

function backendName(backend: ClaudeExecutionBackend): string {
  return backend === 'wsl' ? 'WSL' : 'Windows'
}

function profileFrom(data: ProviderProfiles | null, backend: ClaudeExecutionBackend): ProviderProfile {
  return (
    data?.profiles.find((profile) => profile.backend === backend) ?? {
      backend,
      providers: [],
      activeProviderId: null,
      composerModels: []
    }
  )
}

export default function ProvidersPanel(): JSX.Element {
  const starting = useSessionStore((s) => s.starting)
  const switchProvider = useSessionStore((s) => s.switchProvider)

  const [profiles, setProfiles] = useState<ProviderProfiles | null>(null)
  const [editingBackend, setEditingBackend] = useState<ClaudeExecutionBackend>('windows')
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [savingModels, setSavingModels] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [modelDrafts, setModelDrafts] = useState<Record<ClaudeExecutionBackend, ComposerModel[]>>({
    windows: [],
    wsl: []
  })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [data, prefs] = await Promise.all([
        window.api.getProviderProfiles(),
        window.api.getPreferences()
      ])
      const supportEnabled = !!prefs.wslSupportEnabled
      setProfiles(data)
      setWslSupportEnabled(supportEnabled)
      setEditingBackend((current) => (supportEnabled ? current || data.activeBackend : 'windows'))
      setModelDrafts({
        windows: profileFrom(data, 'windows').composerModels ?? [],
        wsl: supportEnabled ? profileFrom(data, 'wsl').composerModels ?? [] : []
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    window.addEventListener('forge:wsl-support-changed', refresh)
    return () => window.removeEventListener('forge:wsl-support-changed', refresh)
  }, [refresh, starting])

  const profile = useMemo(
    () => profileFrom(profiles, editingBackend),
    [editingBackend, profiles]
  )
  const providers = profile.providers
  const activeId = profile.activeProviderId
  const isEditingActiveRuntime = editingBackend === (profiles?.activeBackend ?? 'windows')
  const settingsTarget = `${backendName(editingBackend)} 的 ~/.claude/settings.json`
  const models = modelDrafts[editingBackend] ?? []

  const doSwitch = async (id: string): Promise<void> => {
    if (id === activeId || starting || switching) return
    setError(null)
    setSwitching(true)
    try {
      if (isEditingActiveRuntime) await switchProvider(id)
      else await window.api.setActiveProviderForBackend(editingBackend, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
      void refresh().then(notifyProviderChanged)
    }
  }

  const doDelete = async (p: Provider): Promise<void> => {
    if (providers.length <= 1) return
    try {
      await window.api.deleteProviderForBackend(editingBackend, p.id)
      if (isEditingActiveRuntime && p.id === activeId) {
        const next = providers.find((provider) => provider.id !== p.id)
        if (next) await switchProvider(next.id)
      }
      await refresh()
      notifyProviderChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openAdd = (): void => {
    setEditing(blankProvider())
    setFormOpen(true)
  }

  const openEdit = (p: Provider): void => {
    setEditing({ ...p })
    setFormOpen(true)
  }

  const updateModel = (index: number, patch: Partial<ComposerModel>): void => {
    setModelDrafts((prev) => ({
      ...prev,
      [editingBackend]: (prev[editingBackend] ?? []).map((model, i) =>
        i === index ? { ...model, ...patch } : model
      )
    }))
  }

  const addModel = (): void => {
    setModelDrafts((prev) => ({
      ...prev,
      [editingBackend]: [...(prev[editingBackend] ?? []), { id: '', label: '' }]
    }))
  }

  const removeModel = (index: number): void => {
    setModelDrafts((prev) => ({
      ...prev,
      [editingBackend]: (prev[editingBackend] ?? []).filter((_, i) => i !== index)
    }))
  }

  const saveModels = async (): Promise<void> => {
    const clean = models
      .map((model) => ({ id: model.id.trim(), label: model.label.trim() }))
      .filter((model) => model.id)
    setSavingModels(true)
    try {
      await window.api.saveComposerModelsForBackend(editingBackend, clean)
      setModelDrafts((prev) => ({ ...prev, [editingBackend]: clean }))
      await refresh()
      notifyModelsChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingModels(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">Provider Profiles</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              {wslSupportEnabled
                ? `Windows 和 WSL 完全独立。当前正在编辑 ${backendName(editingBackend)} 配置。`
                : '当前仅显示 Windows Provider。可在设置里开启 WSL 支持。'}
            </p>
          </div>
          <button
            onClick={openAdd}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110"
          >
            + 添加 Provider
          </button>
        </div>

        <div className="mb-4 flex rounded-xl border border-white/[0.08] bg-white/[0.025] p-1">
          {(['windows'] as ClaudeExecutionBackend[]).map((backend) => (
            <button
              key={backend}
              type="button"
              onClick={() => setEditingBackend(backend)}
              className={`flex-1 rounded-lg px-3 py-2 text-xs transition ${
                editingBackend === backend
                  ? 'bg-accent/20 text-accent'
                  : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
              }`}
            >
              {backendName(backend)}
            </button>
          ))}
          <div className={`wsl-profile-tab-reveal ${wslSupportEnabled ? 'is-visible' : ''}`}>
            {(['wsl'] as ClaudeExecutionBackend[]).map((backend) => (
              <button
                key={backend}
                type="button"
                onClick={() => setEditingBackend(backend)}
                className={`w-full rounded-lg px-3 py-2 text-xs transition ${
                  editingBackend === backend
                    ? 'bg-accent/20 text-accent'
                    : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                }`}
                disabled={!wslSupportEnabled}
                tabIndex={wslSupportEnabled ? 0 : -1}
                aria-hidden={!wslSupportEnabled}
              >
                {backendName(backend)}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-amber-900/30 bg-amber-950/15 px-3 py-2 text-xs text-amber-200/90">
          你正在编辑 {backendName(editingBackend)} 运行环境配置。切换 Provider 会写入 {settingsTarget}。
        </div>

        {(starting || switching) && (
          <div className="mb-4 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm text-amber-300/90">
            正在应用 Provider 切换...
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {providers.length === 0 && (
          <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center text-sm text-zinc-400">
            还没有 Provider 配置。
          </div>
        )}

        <div className="space-y-2">
          {providers.map((p) => {
            const active = p.id === activeId
            return (
              <div
                key={p.id}
                className={`flex items-start gap-4 rounded-xl border px-4 py-3 transition ${
                  active ? 'border-accent/50 bg-bg-panel' : 'border-border-subtle bg-bg-panel'
                }`}
              >
                <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-zinc-700'}`} />
                <button
                  onClick={() => void doSwitch(p.id)}
                  disabled={active || starting || switching}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">{p.name || p.baseUrl}</span>
                    {active && (
                      <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                    <span className="truncate font-mono">{p.baseUrl}</span>
                    <span className="text-zinc-700">/</span>
                    <span>{AUTH_LABEL[p.authType]}</span>
                    <span className="text-zinc-700">/</span>
                    <span className="font-mono">{p.model}</span>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => openEdit(p)}
                    className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void doDelete(p)}
                    disabled={providers.length <= 1}
                    className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <section className="mt-5 rounded-xl border border-border-subtle bg-bg-panel p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-200">{backendName(editingBackend)} 模型列表</h2>
              <p className="mt-0.5 text-[11px] text-zinc-600">留空时 Composer 使用内置模型列表。</p>
            </div>
            <button onClick={addModel} className="text-xs text-accent hover:underline">
              + 添加
            </button>
          </div>
          <div className="space-y-2">
            {models.map((model, index) => (
              <div key={index} className="flex gap-2">
                <input
                  value={model.label}
                  onChange={(event) => updateModel(index, { label: event.target.value })}
                  placeholder="显示名"
                  className={`${inputCls} flex-1`}
                />
                <input
                  value={model.id}
                  onChange={(event) => updateModel(index, { id: event.target.value })}
                  placeholder="模型 id"
                  className={`${inputCls} flex-1 font-mono`}
                />
                <button
                  onClick={() => removeModel(index)}
                  className="shrink-0 rounded-lg border border-border-subtle bg-bg-elev px-3 text-xs text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                >
                  删除
                </button>
              </div>
            ))}
            {models.length === 0 && <div className="text-xs text-zinc-600">未配置自定义模型。</div>}
          </div>
          <button
            onClick={() => void saveModels()}
            disabled={savingModels}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-60"
          >
            {savingModels ? '保存中...' : '保存模型列表'}
          </button>
        </section>
      </div>

      {formOpen && editing && (
        <ProviderFormModal
          provider={editing}
          backend={editingBackend}
          isEdit={!!providers.find((p) => p.id === editing.id)}
          onClose={() => {
            setFormOpen(false)
            setEditing(null)
          }}
          onSaved={() => {
            setFormOpen(false)
            setEditing(null)
            void refresh().then(notifyProviderChanged)
          }}
        />
      )}
    </div>
  )
}
