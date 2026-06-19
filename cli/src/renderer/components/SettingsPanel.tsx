import { useEffect, useRef, useState } from 'react'
import type {
  ComposerModel,
  EffortLevel,
  PermissionMode,
  ClaudeExecutionBackend,
  AgentBackendId,
  AgentBackendInfo,
  SettingsBackup,
  UpdateCheckResult,
  UpdateDownloadProgress
} from '../../shared/ipc'
import {
  MOTION_SPEED_MAX,
  MOTION_SPEED_MIN,
  MOTION_SPEED_STEP,
  useAppearanceStore
} from '../store/appearanceStore'
import DisclosureSelect from './DisclosureSelect'
import { useSessionStore } from '../store/sessionStore'
import {
  createDownloadRequestId,
  formatProgressText,
  formatSpeed,
  progressPercent
} from '../utils/downloadFormat'
import { defaultModelsForAgent } from '../../shared/models'
import { emitForgeEvent, onForgeEvent } from '../events'

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

function ToggleControl({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-xs text-zinc-500">{label}</div>
        {description && <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-zinc-700'}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
}

export default function SettingsPanel(): JSX.Element {
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>('claude-code')
  const [agentBackends, setAgentBackends] = useState<AgentBackendInfo[]>([])
  const [effort, setEffort] = useState<EffortLevel>('high')
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [models, setModels] = useState<ComposerModel[]>([])
  const [vulkan, setVulkan] = useState(false)
  const [claudeBackend, setClaudeBackend] = useState<ClaudeExecutionBackend>('windows')
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [nativeNotifications, setNativeNotifications] = useState(true)
  const [askOnClose, setAskOnClose] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [exportingDiagnostic, setExportingDiagnostic] = useState(false)
  const [diagnosticMessage, setDiagnosticMessage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const updateDownloadIdRef = useRef<string | null>(null)
  const appearance = useAppearanceStore((s) => s.settings)
  const updateAppearance = useAppearanceStore((s) => s.updateSetting)
  const resetAppearance = useAppearanceStore((s) => s.reset)
  const currentCwd = useSessionStore((s) => s.meta?.cwd)
  const reloadForBackendSwitch = useSessionStore((s) => s.reloadForBackendSwitch)

  useEffect(() => {
    void Promise.all([
      window.api.getPreferences(),
      window.api.listAgentBackends().catch(() => [] as AgentBackendInfo[])
    ]).then(([p, backends]) => {
      setAgentBackend(p.agentBackend ?? 'claude-code')
      setAgentBackends(backends)
      setEffort(p.defaultEffort ?? 'high')
      setPermMode(p.defaultPermissionMode ?? 'default')
      setModels(p.composerModels ?? [])
      setVulkan(!!p.vulkanBackend)
      setClaudeBackend(p.claudeExecutionBackend ?? 'windows')
      setWslSupportEnabled(!!p.wslSupportEnabled)
      setMinimizeToTray(!!p.minimizeToTray)
      setNativeNotifications(p.nativeNotifications !== false)
      setAskOnClose(!p.closePromptDismissed)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    return window.api.onUpdateDownloadProgress((next) => {
      if (next.requestId && next.requestId !== updateDownloadIdRef.current) return
      setUpdateProgress(next)
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

  /** Minimize-to-tray applies immediately (controls the window-close behavior). */
  const toggleMinimizeToTray = async (next: boolean): Promise<void> => {
    setMinimizeToTray(next)
    try {
      await window.api.savePreferences({ minimizeToTray: next })
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setMinimizeToTray(!next)
    }
  }

  /** Native notification toggle applies immediately. */
  const toggleNativeNotifications = async (next: boolean): Promise<void> => {
    setNativeNotifications(next)
    try {
      await window.api.savePreferences({ nativeNotifications: next })
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setNativeNotifications(!next)
    }
  }

  /** "每次关闭都询问" toggle. askOnClose=true (default) re-shows the close
   *  prompt on every close; askOnClose=false dismisses it permanently and the
   *  app follows the minimizeToTray setting instead. */
  const toggleAskOnClose = async (next: boolean): Promise<void> => {
    setAskOnClose(next)
    try {
      await window.api.savePreferences({ closePromptDismissed: !next })
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setAskOnClose(!next)
    }
  }

  const checkUpdates = async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateMessage(null)
    try {
      const info = await window.api.checkForUpdates()
      setUpdateInfo(info)
      if (info.error) setUpdateMessage(`检查失败：${info.error}`)
      else if (info.updateAvailable) {
        setUpdateMessage(`发现新版本 ${info.latestVersion ?? ''}`)
      } else {
        setUpdateMessage(`已是最新版本 ${info.currentVersion}`)
      }
    } catch (e) {
      setUpdateMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    setDownloadingUpdate(true)
    setUpdateMessage(null)
    setUpdateProgress(null)
    try {
      const requestId = createDownloadRequestId('settings-update')
      updateDownloadIdRef.current = requestId
      const result = await window.api.downloadAndInstallUpdate({
        assetUrl: updateInfo?.asset?.browserDownloadUrl,
        requestId
      })
      if (result.canceled) setUpdateMessage('已取消选择下载目录。')
      else if (result.ok) setUpdateMessage(`安装包已保存并打开：${result.path ?? ''}`)
      else setUpdateMessage(`下载失败：${result.error ?? '未知错误'}`)
    } catch (e) {
      setUpdateMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setDownloadingUpdate(false)
    }
  }

  const exportDiagnosticReport = async (): Promise<void> => {
    setExportingDiagnostic(true)
    setDiagnosticMessage(null)
    try {
      const result = await window.api.exportDiagnosticReport({
        cwd: currentCwd,
        appearance: appearance as unknown as Record<string, unknown>
      })
      if (result.canceled) setDiagnosticMessage('已取消导出。')
      else setDiagnosticMessage(`已导出：${result.path}`)
    } catch (e) {
      setDiagnosticMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setExportingDiagnostic(false)
    }
  }

  const toggleWslSupport = async (enabled: boolean): Promise<void> => {
    if (enabled === wslSupportEnabled) return
    const previousSupport = wslSupportEnabled
    const previousBackend = claudeBackend
    setWslSupportEnabled(enabled)
    if (!enabled) setClaudeBackend('windows')
    try {
      const prefs = await window.api.savePreferences({
        wslSupportEnabled: enabled,
        ...(enabled ? {} : { claudeExecutionBackend: 'windows' as const })
      })
      setModels(prefs.composerModels ?? [])
      setClaudeBackend(prefs.claudeExecutionBackend ?? 'windows')
      emitForgeEvent('providerChanged')
      emitForgeEvent('modelOptionsChanged')
      emitForgeEvent('wslSupportChanged')
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setWslSupportEnabled(previousSupport)
      setClaudeBackend(previousBackend)
    }
  }

  const switchAgentBackend = async (next: AgentBackendId): Promise<void> => {
    if (next === agentBackend) return
    const previous = agentBackend
    setAgentBackend(next)
    try {
      const prefs = await window.api.savePreferences({ agentBackend: next })
      setModels(prefs.composerModels ?? [])
      emitForgeEvent('agentBackendChanged')
      emitForgeEvent('providerChanged')
      emitForgeEvent('modelOptionsChanged')
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } catch {
      setAgentBackend(previous)
      return
    }
    await reloadForBackendSwitch()
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const cleanModels = models
        .map((m) => ({ id: m.id.trim(), label: m.label.trim() }))
        .filter((m) => m.id)
      const prefs = await window.api.savePreferences({
        defaultEffort: effort,
        defaultPermissionMode: permMode,
        composerModels: cleanModels
      })
      setModels(prefs.composerModels ?? cleanModels)
      emitForgeEvent('modelOptionsChanged')
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
  const backendLabel = claudeBackend === 'wsl' ? 'WSL' : 'Windows'
  const modelScopeLabel =
    agentBackend === 'codex' ? 'Codex' : agentBackend === 'hermes' ? 'Hermes' : backendLabel
  const defaultModelListLabel =
    agentBackend === 'codex' ? 'Codex' : agentBackend === 'hermes' ? 'Hermes' : 'Opus/Sonnet/Haiku'
  const defaultModelCount = defaultModelsForAgent(agentBackend).length
  const agentOptions = (agentBackends.length
    ? agentBackends
    : [
        {
          id: 'claude-code' as AgentBackendId,
          name: 'Claude Code',
          description: '当前稳定后端。',
          status: 'available' as const,
          runtimeModes: ['windows', 'wsl'] as Array<'windows' | 'wsl'>,
          capabilities: {
            streaming: true,
            permissions: true,
            mcp: true,
            skills: true,
            sessionHistory: true,
            subagents: true
          }
        }
      ]).map((backend) => ({
    value: backend.id,
    label: backend.status === 'available' ? backend.name : `${backend.name}（即将支持）`
  }))
  const selectedAgent = agentBackends.find((backend) => backend.id === agentBackend)

  const reloadPreferenceState = async (): Promise<void> => {
    const [p, backends] = await Promise.all([
      window.api.getPreferences(),
      window.api.listAgentBackends().catch(() => [] as AgentBackendInfo[])
    ])
    setAgentBackend(p.agentBackend ?? 'claude-code')
    setAgentBackends(backends)
    setEffort(p.defaultEffort ?? 'high')
    setPermMode(p.defaultPermissionMode ?? 'default')
    setModels(p.composerModels ?? [])
    setVulkan(!!p.vulkanBackend)
    setClaudeBackend(p.claudeExecutionBackend ?? 'windows')
    setWslSupportEnabled(!!p.wslSupportEnabled)
    setMinimizeToTray(!!p.minimizeToTray)
    setNativeNotifications(p.nativeNotifications !== false)
    setAskOnClose(!p.closePromptDismissed)
  }

  // When the close-prompt dialog confirms "don't ask again", the persisted
  // closePromptDismissed changes behind our back - re-sync the toggles.
  useEffect(() => {
    const handler = (): void => {
      void reloadPreferenceState()
    }
    const offClosePrefs = onForgeEvent('closePrefsChanged', handler)
    const offWslSupport = onForgeEvent('wslSupportChanged', handler)
    return () => {
      offClosePrefs()
      offWslSupport()
    }
  }, [])

  const exportSettings = async (): Promise<void> => {
    const backup = await window.api.exportSettings(appearance as unknown as Record<string, unknown>)
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `forge-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importSettingsFile = async (file: File): Promise<void> => {
    const parsed = JSON.parse(await file.text()) as SettingsBackup
    await window.api.importSettings(parsed)
    if (parsed.appearance) {
      const next = parsed.appearance as Partial<typeof appearance>
      if (typeof next.motionSpeed === 'number') updateAppearance('motionSpeed', next.motionSpeed)
      if (typeof next.glassGlow === 'boolean') updateAppearance('glassGlow', next.glassGlow)
    }
    await reloadPreferenceState()
    emitForgeEvent('providerChanged')
    emitForgeEvent('modelOptionsChanged')
    setSavedAt(true)
    setTimeout(() => setSavedAt(false), 1500)
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'
  const labelCls = 'mb-1.5 block text-xs text-zinc-500'
  const updatePercent = progressPercent(updateProgress)

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
            <ToggleControl
              label="玻璃泛光"
              description="控制玻璃组件的外发光、边缘高光和环境泛光。"
              checked={appearance.glassGlow}
              onChange={(checked) => updateAppearance('glassGlow', checked)}
            />
            <RangeControl
              label="动画速度"
              value={appearance.motionSpeed}
              min={MOTION_SPEED_MIN}
              max={MOTION_SPEED_MAX}
              step={MOTION_SPEED_STEP}
              display={`${appearance.motionSpeed}%`}
              onChange={(value) => updateAppearance('motionSpeed', value)}
            />
          </div>
        </section>

        <section className="glass-panel-soft glass-overflow-visible rounded-2xl p-4">
          <div className="mb-3">
            <label className={labelCls}>Agent 后端</label>
            <p className="text-[11px] leading-relaxed text-zinc-600">
              控制会话由哪个 Agent 引擎接管。Windows/WSL 是 Claude Code 的运行环境，Agent 后端是更上层的可插拔引擎。
            </p>
          </div>
          <DisclosureSelect
            value={agentBackend}
            options={agentOptions}
            onChange={(v) => void switchAgentBackend(v as AgentBackendId)}
            className="w-full"
          />
          {selectedAgent && (
            <div className="mt-3 rounded-xl border border-white/[0.06] bg-bg-elev/50 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-zinc-300">{selectedAgent.name}</span>
                <span className="rounded bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
                  {selectedAgent.status === 'available' ? '可用' : '即将支持'}
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {selectedAgent.description}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-zinc-500">
                {[
                  selectedAgent.capabilities.streaming ? '流式输出' : '',
                  selectedAgent.capabilities.permissions ? '权限拦截' : '',
                  selectedAgent.capabilities.mcp ? 'MCP' : '',
                  selectedAgent.capabilities.skills ? 'Skills' : '',
                  selectedAgent.capabilities.sessionHistory ? '历史恢复' : '',
                  selectedAgent.capabilities.subagents ? 'Subagents' : ''
                ]
                  .filter(Boolean)
                  .map((label) => (
                    <span key={label} className="rounded bg-white/[0.04] px-2 py-0.5">
                      {label}
                    </span>
                  ))}
              </div>
            </div>
          )}
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

        <section className="glass-panel-soft rounded-2xl p-4">
          <ToggleControl
            label="WSL 支持"
            description="开启后才显示 WSL 会话信息、WSL Provider Profile、WSL 健康检查，并允许打开 WSL 历史时自动切换后端。关闭后界面回到纯 Windows 模式。"
            checked={wslSupportEnabled}
            onChange={(checked) => void toggleWslSupport(checked)}
          />
        </section>

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-xs text-zinc-500">
              Composer 模型列表({modelScopeLabel}, 留空用内置)
            </label>
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
              <div className="text-xs text-zinc-600">
                未配置,使用内置 {defaultModelListLabel} 列表({defaultModelCount} 个)。
              </div>
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
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-zinc-200">设置导入 / 导出</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
              备份 Forge 设置、Provider 配置、模型列表和外观设置。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void exportSettings()}
              className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-xs text-zinc-300 transition hover:bg-bg-hover"
            >
              导出设置
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-xs text-zinc-300 transition hover:bg-bg-hover"
            >
              导入设置
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.currentTarget.value = ''
                if (file) void importSettingsFile(file)
              }}
            />
          </div>
        </section>

        <section className="glass-panel-soft rounded-2xl p-4">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-zinc-200">系统</h2>
          </div>
          <div className="space-y-4">
            <ToggleControl
              label="最小化到系统托盘"
              description="关闭窗口时最小化到托盘而非退出应用。点击托盘图标可恢复窗口。"
              checked={minimizeToTray}
              onChange={(checked) => void toggleMinimizeToTray(checked)}
            />
            <ToggleControl
              label="会话完成通知"
              description="当 Agent 完成任务且窗口不在前台时,显示系统原生通知。"
              checked={nativeNotifications}
              onChange={(checked) => void toggleNativeNotifications(checked)}
            />
            <ToggleControl
              label="每次关闭都询问"
              description="关闭窗口时每次弹出「最小化到托盘 / 直接退出」选择框。关闭后直接按上面的设置执行,不再询问。"
              checked={askOnClose}
              onChange={(checked) => void toggleAskOnClose(checked)}
            />
            <div className="border-t border-white/[0.06] pt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-zinc-500">自动更新</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    启动后自动检查 GitHub Release；也可以手动检查并下载最新安装包。
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void checkUpdates()}
                    disabled={checkingUpdate}
                    className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
                  >
                    {checkingUpdate ? '检查中...' : '检查更新'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadUpdate()}
                    disabled={downloadingUpdate || !updateInfo?.asset}
                    className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {downloadingUpdate ? '下载中...' : '选择目录并下载'}
                  </button>
                </div>
              </div>
              {updateInfo && (
                <div className="text-[11px] text-zinc-500">
                  当前 {updateInfo.currentVersion}
                  {updateInfo.latestVersion ? ` / 最新 ${updateInfo.latestVersion}` : ''}
                  {updateInfo.asset?.name ? ` / ${updateInfo.asset.name}` : ''}
                </div>
              )}
              {(downloadingUpdate || updateProgress) && (
                <div className="mt-3 rounded-xl border border-white/[0.06] bg-bg-elev/60 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-zinc-400">
                      {updateProgress?.done ? '下载完成' : downloadingUpdate ? '下载中' : '准备下载'}
                    </span>
                    <span className="font-mono text-zinc-500">
                      {updateProgress?.totalBytes
                        ? `${updatePercent.toFixed(1)}%`
                        : formatSpeed(updateProgress?.bytesPerSecond)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
                    <div
                      className="h-full rounded-full bg-accent transition-[width]"
                      style={{
                        width: `${updateProgress?.totalBytes ? updatePercent : downloadingUpdate ? 100 : 0}%`
                      }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
                    <span>{formatProgressText(updateProgress)}</span>
                    {updateProgress?.totalBytes && <span>{formatSpeed(updateProgress.bytesPerSecond)}</span>}
                  </div>
                  {updateProgress?.path && (
                    <div className="mt-1 truncate text-[11px] text-zinc-600" title={updateProgress.path}>
                      {updateProgress.path}
                    </div>
                  )}
                </div>
              )}
              {updateMessage && <div className="mt-1 text-[11px] text-zinc-500">{updateMessage}</div>}
            </div>
            <div className="border-t border-white/[0.06] pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-zinc-500">诊断报告</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    导出运行时、WSL、Provider 摘要、配置快照和最近日志；敏感密钥会脱敏。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void exportDiagnosticReport()}
                  disabled={exportingDiagnostic}
                  className="shrink-0 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
                >
                  {exportingDiagnostic ? '导出中...' : '导出报告'}
                </button>
              </div>
              {diagnosticMessage && (
                <div className="mt-2 break-all text-[11px] text-zinc-500">{diagnosticMessage}</div>
              )}
            </div>
          </div>
        </section>

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
          此处的默认 effort 与权限模式对**新建对话**生效;当前会话可在输入框工具栏里实时切换权限模式,effort 仍会在下一条消息生效。模型列表保存后立即更新 Composer 下拉。
        </p>
      </div>
    </div>
  )
}
