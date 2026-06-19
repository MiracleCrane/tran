import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import ProviderFormModal from './ProviderFormModal'
import { emitForgeEvent, onForgeEvent } from '../events'
import { RefreshIcon, ToolPanelAlert, ToolPanelButton, ToolPanelHeader } from './ToolPanelChrome'
import type {
  AgentBackendId,
  ClaudeExecutionBackend,
  ComposerModel,
  Provider,
  ProviderBackend,
  ProviderProfile,
  ProviderProfiles
} from '../../shared/ipc'

const AUTH_LABEL: Record<string, string> = {
  bearer: 'Bearer Token',
  apikey: 'API Key'
}

function notifyProviderChanged(): void {
  emitForgeEvent('providerChanged')
}

function notifyModelsChanged(): void {
  emitForgeEvent('modelOptionsChanged')
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

function backendName(backend: ProviderBackend): string {
  if (backend === 'hermes') return 'Hermes'
  return backend === 'wsl' ? 'WSL' : 'Windows'
}

function profileFrom(data: ProviderProfiles | null, backend: ProviderBackend): ProviderProfile {
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
  const sessionAgentBackend = useSessionStore((s) => s.meta?.agentBackend)

  const [profiles, setProfiles] = useState<ProviderProfiles | null>(null)
  const [editingBackend, setEditingBackend] = useState<ProviderBackend>('windows')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [savingModels, setSavingModels] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [agentBackend, setAgentBackend] = useState<AgentBackendId | null>(null)
  const [modelDrafts, setModelDrafts] = useState<Record<ProviderBackend, ComposerModel[]>>({
    windows: [],
    wsl: [],
    hermes: []
  })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [data, prefs] = await Promise.all([
        window.api.getProviderProfiles(),
        window.api.getPreferences()
      ])
      const supportEnabled = !!prefs.wslSupportEnabled
      const nextAgentBackend = prefs.agentBackend ?? 'claude-code'
      setProfiles(data)
      setWslSupportEnabled(supportEnabled)
      setAgentBackend(nextAgentBackend)
      setEditingBackend((current) => {
        if (nextAgentBackend === 'hermes') return 'hermes'
        if (current === 'hermes') return supportEnabled ? data.activeBackend : 'windows'
        return supportEnabled ? current || data.activeBackend : 'windows'
      })
      setModelDrafts({
        windows: profileFrom(data, 'windows').composerModels ?? [],
        wsl: supportEnabled ? profileFrom(data, 'wsl').composerModels ?? [] : [],
        hermes: profileFrom(data, 'hermes').composerModels ?? []
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offWslSupport = onForgeEvent('wslSupportChanged', refresh)
    const offProvider = onForgeEvent('providerChanged', refresh)
    return () => {
      offWslSupport()
      offProvider()
    }
  }, [refresh, starting])

  const profile = useMemo(
    () => profileFrom(profiles, editingBackend),
    [editingBackend, profiles]
  )
  const providers = profile.providers
  const activeId = profile.activeProviderId
  const effectiveAgentBackend = agentBackend ?? sessionAgentBackend ?? 'claude-code'
  const isHermesAgent = effectiveAgentBackend === 'hermes'
  const isHermesProfile = isHermesAgent || editingBackend === 'hermes'
  const isEditingActiveRuntime = editingBackend === (profiles?.activeBackend ?? 'windows')
  const settingsTarget = `${backendName(editingBackend)} 的 ~/.claude/settings.json`
  const models = modelDrafts[editingBackend] ?? []
  const displayBackendName = isHermesProfile ? 'Windows' : backendName(editingBackend)

  const doSwitch = async (id: string): Promise<void> => {
    if (id === activeId || starting || switching) return
    setError(null)
    setSwitching(true)
    try {
      if (isHermesProfile) await window.api.setActiveProviderForBackend('hermes', id)
      else if (isEditingActiveRuntime) await switchProvider(id)
      else await window.api.setActiveProviderForBackend(editingBackend, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
      void refresh().then(notifyProviderChanged)
    }
  }

  const doDelete = async (p: Provider): Promise<void> => {
    if (providers.length <= 1 || isHermesProfile) return
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
    if (isHermesProfile) return
    setEditing(blankProvider())
    setFormOpen(true)
  }

  const openEdit = (p: Provider): void => {
    if (isHermesProfile) return
    setEditing({ ...p })
    setFormOpen(true)
  }

  const manualRefresh = async (): Promise<void> => {
    setRefreshing(true)
    setError(null)
    try {
      await refresh()
      notifyProviderChanged()
      notifyModelsChanged()
    } finally {
      setRefreshing(false)
    }
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
        <ToolPanelHeader
          title="运营商"
          description={
            isHermesProfile
              ? '当前显示 Windows 本机 Hermes 运营商配置，来源于 Hermes config.yaml。'
              : wslSupportEnabled
              ? `Windows 和 WSL 完全独立。当前正在编辑 ${displayBackendName} 运营商配置。`
              : '当前仅显示 Windows 运营商。可在设置里开启 WSL 支持。'
          }
          actions={
            <>
              <ToolPanelButton
                onClick={() => void manualRefresh()}
                disabled={refreshing}
                title="刷新运营商"
              >
                <RefreshIcon spinning={refreshing} />
                <span>{refreshing ? '刷新中' : '刷新'}</span>
              </ToolPanelButton>
              {!isHermesProfile && (
                <ToolPanelButton variant="primary" onClick={openAdd}>
                  + 添加运营商
                </ToolPanelButton>
              )}
            </>
          }
        />

        <div className="mb-4 flex rounded-xl border border-white/[0.08] bg-white/[0.025] p-1">
          {isHermesAgent ? (
            <button
              type="button"
              onClick={() => setEditingBackend('hermes')}
              className="flex-1 rounded-lg bg-accent/20 px-3 py-2 text-xs text-accent transition"
            >
              Windows
            </button>
          ) : (
            <>
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
            </>
          )}
        </div>

        {!isHermesProfile && (
          <div className="mb-4 rounded-xl border border-amber-900/30 bg-amber-950/15 px-3 py-2 text-xs text-amber-200/90">
            你正在编辑 {displayBackendName} 运行环境配置。切换运营商会写入 {settingsTarget}。
          </div>
        )}

        {isHermesProfile && (
          <ToolPanelAlert tone="info">
            Windows Hermes 的运营商由 Hermes config.yaml 管理；如需切换服务商，请运行 <code className="font-mono">hermes model</code> 后点击刷新。
          </ToolPanelAlert>
        )}

        {(starting || switching) && (
          <ToolPanelAlert tone="warning">
            正在应用运营商切换...
          </ToolPanelAlert>
        )}

        {error && (
          <ToolPanelAlert tone="error">
            {error}
          </ToolPanelAlert>
        )}

        {providers.length === 0 && (
          <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center text-sm text-zinc-400">
            {isHermesProfile ? '没有读取到 Hermes 运营商配置。' : '还没有运营商配置。'}
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
                    {isHermesProfile ? (
                      <>
                        <span className="truncate font-mono">{p.baseUrl}</span>
                        <span className="text-zinc-700">/</span>
                        <span className="font-mono">{p.model}</span>
                      </>
                    ) : (
                      <>
                        <span className="truncate font-mono">{p.baseUrl}</span>
                        <span className="text-zinc-700">/</span>
                        <span>{AUTH_LABEL[p.authType]}</span>
                        <span className="text-zinc-700">/</span>
                        <span className="font-mono">{p.model}</span>
                      </>
                    )}
                  </div>
                </button>
                {!isHermesProfile && (
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
                )}
              </div>
            )
          })}
        </div>

        <section className="mt-5 rounded-xl border border-border-subtle bg-bg-panel p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-200">{displayBackendName} 模型列表</h2>
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
          <ToolPanelButton
            variant="primary"
            onClick={() => void saveModels()}
            disabled={savingModels}
            className="mt-3"
          >
            {savingModels ? '保存中...' : '保存模型列表'}
          </ToolPanelButton>
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
