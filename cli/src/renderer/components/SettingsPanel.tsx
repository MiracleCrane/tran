import { useCallback, useEffect, useRef, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type {
  ComposerModel,
  EffortLevel,
  PermissionMode,
  ClaudeExecutionBackend,
  AgentBackendId,
  AgentBackendInfo,
  SettingsBackup,
  UpdateCheckResult,
  UpdateDownloadProgress,
  KimiVersionInfo,
  SummaryModelProbe,
  PromptDiagnosis
} from '../../shared/ipc'
import {
  MOTION_SPEED_MAX,
  MOTION_SPEED_MIN,
  MOTION_SPEED_STEP,
  useAppearanceStore
} from '../store/appearanceStore'
import DisclosureSelect from './DisclosureSelect'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import {
  createDownloadRequestId,
  formatProgressText,
  formatSpeed,
  progressPercent
} from '../utils/downloadFormat'
import { defaultModelsForAgent } from '../../shared/models'
import { emitForgeEvent, onForgeEvent } from '../events'
import { useTransientFlag } from '../hooks/useTransientFlag'

const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最大' }
]

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: '逐条确认 (default)' },
  { id: 'yolo', label: '自动通过 (yolo)' },
  { id: 'auto', label: '完全自主 (auto·慎用)' }
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
        className="h-2 w-full cursor-pointer accent-[#8b5cf6]"
      />
    </label>
  )
}

function ToggleControl({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-45' : ''}`}>
      <div>
        <div className="text-xs text-zinc-500">{label}</div>
        {description && <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">{description}</p>}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-zinc-700'} ${disabled ? 'cursor-not-allowed' : ''}`}
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

export default function SettingsPanel(): JSX.Element {
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>('kimi')
  const [agentBackends, setAgentBackends] = useState<AgentBackendInfo[]>([])
  const [effort, setEffort] = useState<EffortLevel>('high')
  const [permMode, setPermMode] = useState<PermissionMode>('default')
  const [models, setModels] = useState<ComposerModel[]>([])
  const [vulkan, setVulkan] = useState(false)
  const [claudeBackend, setClaudeBackend] = useState<ClaudeExecutionBackend>('windows')
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  const [minimizeToTray, setMinimizeToTray] = useState(false)
  const [startMaximized, setStartMaximized] = useState(false)
  const [nativeNotifications, setNativeNotifications] = useState(true)
  const [aiNaming, setAiNaming] = useState(true)
  const [summaryApiBaseUrl, setSummaryApiBaseUrl] = useState('https://api.deepseek.com')
  // API Key 不再回显明文：输入框只承载「本次新输入」，已配置状态用主进程回的掩码提示。
  const [summaryApiKey, setSummaryApiKey] = useState('')
  const [summaryKeyMasked, setSummaryKeyMasked] = useState<string | null>(null)
  // DeepSeek 余额（用量卡里那行）的 key，掩码回显模式同摘要 Key。
  const [deepseekApiKey, setDeepseekApiKey] = useState('')
  const [deepseekKeyMasked, setDeepseekKeyMasked] = useState<string | null>(null)
  const [summaryModel, setSummaryModel] = useState('')
  const [autoTodoNudge, setAutoTodoNudge] = useState(false)
  const [cloudUsage, setCloudUsage] = useState(true)
  const [probing, setProbing] = useState(false)
  const [probes, setProbes] = useState<SummaryModelProbe[] | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<PromptDiagnosis[] | null>(null)
  const [askOnClose, setAskOnClose] = useState(true)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [exportingDiagnostic, setExportingDiagnostic] = useState(false)
  const [diagnosticMessage, setDiagnosticMessage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  // Kimi Code CLI 版本（与 Tran 自身更新分开：只查不装，升级要重启 ACP 连接）。
  const [kimiVersion, setKimiVersion] = useState<KimiVersionInfo | null>(null)
  const [checkingKimi, setCheckingKimi] = useState(false)
  // 「已复制」提示：1.5s 自动复位，定时器由 hook 统一清理。
  const [kimiCopied, flashKimiCopied] = useTransientFlag()
  const [upgradingKimi, setUpgradingKimi] = useState(false)
  const [kimiUpgradeMsg, setKimiUpgradeMsg] = useState<string | null>(null)
  const [kimiConfirmOpen, setKimiConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // 「已保存」提示：连续保存不再互相踩定时器，卸载时也会清理。
  const [savedAt, flashSaved] = useTransientFlag()
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const updateDownloadIdRef = useRef<string | null>(null)
  const appearance = useAppearanceStore((s) => s.settings)
  const updateAppearance = useAppearanceStore((s) => s.updateSetting)
  const resetAppearance = useAppearanceStore((s) => s.reset)
  const currentCwd = useSessionStore((s) => s.meta?.cwd)
  const reloadForBackendSwitch = useSessionStore((s) => s.reloadForBackendSwitch)

  // 初始加载：任何一步失败都不能让页面永久停在「加载中」——
  // catch 记录错误（页面顶部给出重试入口），finally 一律 setLoaded。
  const loadInitial = useCallback((): void => {
    setLoadError(null)
    void window.api.getAppVersion().then(setAppVersion).catch(() => {})
    void Promise.all([
      window.api.getPreferences(),
      window.api.listAgentBackends().catch(() => [] as AgentBackendInfo[]),
      window.api.getApiKey().catch(() => null)
    ])
      .then(([p, backends, apiKey]) => {
        setAgentBackend(p.agentBackend ?? 'kimi')
        setAgentBackends(backends)
        setEffort(p.defaultEffort ?? 'high')
        setPermMode(p.defaultPermissionMode ?? 'default')
        setModels(p.composerModels ?? [])
        setVulkan(!!p.vulkanBackend)
        setClaudeBackend(p.claudeExecutionBackend ?? 'windows')
        setWslSupportEnabled(!!p.wslSupportEnabled)
        setMinimizeToTray(!!p.minimizeToTray)
        setStartMaximized(!!p.startMaximized)
        setNativeNotifications(p.nativeNotifications !== false)
        setAiNaming(p.aiNamingEnabled !== false)
        setSummaryApiBaseUrl(p.summaryApiBaseUrl ?? 'https://api.deepseek.com')
        // getApiKey 只回 { configured, masked }，不再下发明文。
        setSummaryKeyMasked(apiKey?.masked ?? null)
        setSummaryModel(p.summaryModel ?? '')
        setAutoTodoNudge(p.autoTodoNudge === true)
        setCloudUsage(p.cloudUsageEnabled !== false)
        setAskOnClose(!p.closePromptDismissed)
        // DeepSeek key 状态独立拉（同样是只回掩码），不进上面的 Promise.all
        // 是怕它失败拖垮整个初始化——这一个字段不值得。
        void window.api
          .getDeepseekApiKeyStatus()
          .then((info) => setDeepseekKeyMasked(info.masked))
          .catch(() => {})
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    loadInitial()
  }, [loadInitial])

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
      flashSaved()
    } catch {
      setVulkan(!next) // revert on failure
    }
  }

  /** Minimize-to-tray applies immediately (controls the window-close behavior). */
  const toggleMinimizeToTray = async (next: boolean): Promise<void> => {
    setMinimizeToTray(next)
    try {
      await window.api.savePreferences({ minimizeToTray: next })
      flashSaved()
    } catch {
      setMinimizeToTray(!next)
    }
  }

  /** Start-maximized applies on next launch (read once when the window is
   *  created); persist immediately like the other system toggles. */
  const toggleStartMaximized = async (next: boolean): Promise<void> => {
    setStartMaximized(next)
    try {
      await window.api.savePreferences({ startMaximized: next })
      flashSaved()
    } catch {
      setStartMaximized(!next)
    }
  }

  /** Native notification toggle applies immediately. */
  const toggleNativeNotifications = async (next: boolean): Promise<void> => {
    setNativeNotifications(next)
    try {
      await window.api.savePreferences({ nativeNotifications: next })
      flashSaved()
    } catch {
      setNativeNotifications(!next)
    }
  }

  /** AI 自动命名开关（默认开）：立即生效；关闭后主进程任何路径都不调命名 API。 */
  const toggleAiNaming = async (next: boolean): Promise<void> => {
    setAiNaming(next)
    try {
      await window.api.savePreferences({ aiNamingEnabled: next })
      flashSaved()
    } catch {
      setAiNaming(!next)
    }
  }

  const saveSummaryApiBaseUrl = async (next: string): Promise<void> => {
    setSummaryApiBaseUrl(next)
    try {
      await window.api.savePreferences({ summaryApiBaseUrl: next.trim() })
      flashSaved()
    } catch {
      /* 保留输入，方便用户修正后重试 */
    }
  }

  /** 保存新输入的 Key。空输入直接忽略（清除走旁边的「清除」按钮），
   *  保存成功后清空输入框并刷新掩码回显——界面上任何时刻都不留明文。 */
  const saveSummaryApiKey = async (next: string): Promise<void> => {
    const trimmed = next.trim()
    if (!trimmed) return
    try {
      await window.api.setApiKey(trimmed)
      const info = await window.api.getApiKey().catch(() => null)
      setSummaryKeyMasked(info?.masked ?? null)
      setSummaryApiKey('')
      flashSaved()
    } catch {
      /* 保留输入，方便用户修正后重试 */
    }
  }

  /** 清除已存储的 Key（掩码回显模式下无法靠清空输入框来清除）。 */
  const clearSummaryApiKey = async (): Promise<void> => {
    try {
      await window.api.setApiKey('')
      setSummaryKeyMasked(null)
      setSummaryApiKey('')
      flashSaved()
    } catch {
      /* 清除失败保持原状 */
    }
  }

  /** DeepSeek 余额 key：保存逻辑与摘要 Key 同款——空输入忽略，清除走按钮，
   *  保存成功清空输入框并刷新掩码。主进程侧保存后会让余额缓存作废。 */
  const saveDeepseekKey = async (next: string): Promise<void> => {
    const trimmed = next.trim()
    if (!trimmed) return
    try {
      const info = await window.api.saveDeepseekApiKey(trimmed)
      setDeepseekKeyMasked(info.masked)
      setDeepseekApiKey('')
      flashSaved()
    } catch {
      /* 保留输入，方便用户修正后重试 */
    }
  }

  const clearDeepseekKey = async (): Promise<void> => {
    try {
      await window.api.saveDeepseekApiKey('')
      setDeepseekKeyMasked(null)
      setDeepseekApiKey('')
      flashSaved()
    } catch {
      /* 清除失败保持原状 */
    }
  }

  /** 后台任务收尾后自动催 AI 更新待办。与命名那类小请求**不是一个量级**：
   *  那是一次真实对话轮，所以单独一个开关，不跟 AI 命名共用。 */
  const toggleAutoTodoNudge = async (next: boolean): Promise<void> => {
    setAutoTodoNudge(next)
    try {
      await window.api.savePreferences({ autoTodoNudge: next })
      flashSaved()
    } catch {
      setAutoTodoNudge(!next)
    }
  }

  /** 云端额度查询开关（默认开）。它复用 Kimi CLI 的登录凭证直连云端私有接口，
   *  属于"非官方公开"的调用方式——给用户一个明确的知情关闭入口。 */
  const toggleCloudUsage = async (next: boolean): Promise<void> => {
    setCloudUsage(next)
    try {
      await window.api.savePreferences({ cloudUsageEnabled: next })
      flashSaved()
    } catch {
      setCloudUsage(!next)
    }
  }

  /** 总结型号：存的是原样字符串，空串 = 用主进程的默认值（deepseek-v4-flash）。
   *  不做前端校验——能不能用只有服务端说了算，所以旁边给了探测按钮。 */
  const saveSummaryModel = async (next: string): Promise<void> => {
    setSummaryModel(next)
    try {
      await window.api.savePreferences({ summaryModel: next.trim() })
      flashSaved()
    } catch {
      /* 保存失败就留在输入框里，不回滚用户输入 */
    }
  }

  /** 逐个探测候选型号能否在用户配置的兼容 API 上使用。串行，主进程侧实现。 */
  const runProbeSummaryModels = async (): Promise<void> => {
    setProbing(true)
    setProbes(null)
    try {
      setProbes(await window.api.probeSummaryModels())
    } catch (e) {
      setProbes([
        { model: '(探测失败)', ok: false, known: false, error: e instanceof Error ? e.message : String(e) }
      ])
    } finally {
      setProbing(false)
    }
  }

  /** 提示词策略自检：四种请求形态各打一发（共约 400 token），把服务端原始
   *  报错带回来。这些型号对格式要求的遵循很差，而 400 的真实原因只能从服务端
   *  那句话里看——做成按钮，免得每次都要在 PowerShell 里手工解 HTTP 响应。 */
  const runDiagnoseSummaryPrompt = async (): Promise<void> => {
    setDiagnosing(true)
    setDiagnosis(null)
    try {
      setDiagnosis(await window.api.diagnoseSummaryPrompt())
    } catch (e) {
      setDiagnosis([
        { label: '(自检失败)', ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 }
      ])
    } finally {
      setDiagnosing(false)
    }
  }

  /** "每次关闭都询问" toggle. askOnClose=true (default) re-shows the close
   *  prompt on every close; askOnClose=false dismisses it permanently and the
   *  app follows the minimizeToTray setting instead. */
  const toggleAskOnClose = async (next: boolean): Promise<void> => {
    setAskOnClose(next)
    try {
      await window.api.savePreferences({ closePromptDismissed: !next })
      flashSaved()
    } catch {
      setAskOnClose(!next)
    }
  }

  const checkKimi = async (force: boolean): Promise<void> => {
    setCheckingKimi(true)
    try {
      setKimiVersion(await window.api.checkKimiVersion(force))
    } catch (e) {
      setKimiVersion({
        updateAvailable: false,
        upgradeCommand: 'npm install -g @moonshot-ai/kimi-code@latest',
        error: e instanceof Error ? e.message : String(e),
        checkedAt: Date.now()
      })
    } finally {
      setCheckingKimi(false)
    }
  }

  const runKimiUpgrade = async (): Promise<void> => {
    setKimiConfirmOpen(false)
    setUpgradingKimi(true)
    setKimiUpgradeMsg('正在断开会话并安装…')
    try {
      const result = await window.api.upgradeKimi()
      if (result.ok) {
        setKimiUpgradeMsg('升级完成。请重新打开会话。')
        setKimiVersion(await window.api.checkKimiVersion(true))
      } else {
        setKimiUpgradeMsg(`升级失败：${result.error ?? '未知错误'}`)
      }
    } catch (e) {
      setKimiUpgradeMsg(`升级失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setUpgradingKimi(false)
    }
  }

  const copyKimiUpgrade = async (): Promise<void> => {
    if (!kimiVersion) return
    try {
      await navigator.clipboard.writeText(kimiVersion.upgradeCommand)
      flashKimiCopied()
    } catch {
      /* clipboard unavailable */
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
      flashSaved()
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
      flashSaved()
    } finally {
      setSaving(false)
    }
  }

  const addModel = (): void => setModels((m) => [...m, { id: '', label: '' }])
  const updateModel = (i: number, patch: Partial<ComposerModel>): void =>
    setModels((m) => m.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
  const removeModel = (i: number): void => setModels((m) => m.filter((_, idx) => idx !== i))
  const modelScopeLabel = 'Kimi'
  const defaultModelListLabel = 'Kimi'
  const defaultModelCount = defaultModelsForAgent(agentBackend).length
  const agentOptions = (agentBackends.length
    ? agentBackends
    : [
        {
          id: 'kimi' as AgentBackendId,
          name: 'Kimi Code CLI',
          description: '当前内置后端。',
          status: 'available' as const,
          runtimeModes: ['windows'] as Array<'windows' | 'wsl'>,
          capabilities: {
            streaming: true,
            permissions: true,
            mcp: true,
            skills: false,
            sessionHistory: true,
            subagents: false
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
    setAgentBackend(p.agentBackend ?? 'kimi')
    setAgentBackends(backends)
    setEffort(p.defaultEffort ?? 'high')
    setPermMode(p.defaultPermissionMode ?? 'default')
    setModels(p.composerModels ?? [])
    setVulkan(!!p.vulkanBackend)
    setClaudeBackend(p.claudeExecutionBackend ?? 'windows')
    setWslSupportEnabled(!!p.wslSupportEnabled)
    setMinimizeToTray(!!p.minimizeToTray)
    setStartMaximized(!!p.startMaximized)
    setNativeNotifications(p.nativeNotifications !== false)
    setAskOnClose(!p.closePromptDismissed)
  }

  // When the close-prompt dialog confirms "don't ask again", the persisted
  // closePromptDismissed changes behind our back - re-sync the toggles.
  useEffect(() => {
    const handler = (): void => {
      void reloadPreferenceState().catch(() => {})
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
    a.download = `tran-settings-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importSettingsFile = async (file: File): Promise<void> => {
    setImportMessage(null)
    // 解析失败单独提示：之前 JSON.parse 抛异常被 void 吞掉，界面毫无反应。
    let parsed: SettingsBackup
    try {
      parsed = JSON.parse(await file.text()) as SettingsBackup
    } catch {
      setImportMessage('文件无法解析：不是有效的 JSON 设置备份。')
      return
    }
    try {
      await window.api.importSettings(parsed)
      if (parsed.appearance) {
        const next = parsed.appearance as Partial<typeof appearance>
        if (typeof next.motionSpeed === 'number') updateAppearance('motionSpeed', next.motionSpeed)
        if (typeof next.glassGlow === 'boolean') updateAppearance('glassGlow', next.glassGlow)
      }
      await reloadPreferenceState()
      emitForgeEvent('providerChanged')
      emitForgeEvent('modelOptionsChanged')
      flashSaved()
    } catch (e) {
      setImportMessage(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
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
        {/* #35 吸顶标题栏：下滚后"返回对话"仍可点。 */}
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={() => useUiStore.getState().setView('chat')}
            className="glass-control flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">设置</h1>
          {appVersion && (
            <span className="rounded bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
              Tran v{appVersion}
            </span>
          )}
        </div>

        {/* 初始加载失败：页面照常渲染（显示默认值），顶部给错误与重试入口。 */}
        {loadError && (
          <div className="flex items-center gap-3 rounded-xl border border-red-400/20 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            <span className="min-w-0 flex-1">设置加载失败：{loadError}</span>
            <button
              type="button"
              onClick={loadInitial}
              className="shrink-0 rounded-md border border-red-400/30 px-2 py-1 text-[11px] transition hover:bg-red-400/10"
            >
              重试
            </button>
          </div>
        )}

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
            {/* 界面风格：即时生效（根元素 data-ui 切换），不需要重启。 */}
            <div>
              <div className="text-xs text-zinc-500">界面风格</div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                简约（默认）：面板不再描边和投影，分区靠背景深浅；「新建对话」降为
                次要按钮；你的发言从右侧气泡改为左侧一条竖线（贴日志贴代码时更好读），
                与 AI 回复共用同一条居中的正文列。
              </p>
              <div className="mt-2 flex gap-1.5">
                {([
                  { id: 'glass', label: '玻璃' },
                  { id: 'flat', label: '简约' }
                ] as const).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => updateAppearance('uiStyle', option.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs transition ${
                      appearance.uiStyle === option.id
                        ? 'bg-accent/20 text-accent'
                        : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {/* 主题底色：即时生效（根元素 data-theme 切换），只换底色台阶，
                accent 紫色系不动。 */}
            <div>
              <div className="text-xs text-zinc-500">主题底色</div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                深黑（默认）：一直以来的近黑底色；炭灰：Codex 风，整体抬亮一档，
                壳 #1b1d21、面板 #23262b。
              </p>
              <div className="mt-2 flex gap-1.5">
                {([
                  { id: 'onyx', label: '深黑' },
                  { id: 'charcoal', label: '炭灰' }
                ] as const).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => updateAppearance('theme', option.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs transition ${
                      appearance.theme === option.id
                        ? 'bg-accent/20 text-accent'
                        : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <ToggleControl
              label="玻璃泛光"
              description="控制玻璃组件的外发光、边缘高光和环境泛光。简约风下不生效。"
              checked={appearance.glassGlow}
              disabled={appearance.uiStyle === 'flat'}
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
              控制会话由哪个 Agent 引擎接管。当前版本内置 Kimi Code CLI 后端。
            </p>
          </div>
          {/* 只有一个后端时隐藏切换器，只展示能力说明卡片。 */}
          {agentOptions.length > 1 && (
            <DisclosureSelect
              value={agentBackend}
              options={agentOptions}
              onChange={(v) => void switchAgentBackend(v as AgentBackendId)}
              className="w-full"
            />
          )}
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
              备份 Tran 设置、Provider 配置、模型列表和外观设置。
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
          {importMessage && (
            <div className="mt-2 text-[11px] leading-relaxed text-red-300">{importMessage}</div>
          )}
        </section>

        <section className="glass-panel-soft rounded-2xl p-4">
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-zinc-200">系统</h2>
          </div>
          <div className="space-y-4">
            <ToggleControl
              label="AI 自动命名"
              description="新会话发第一条消息后自动生成短标题（每次约消耗一两百 token）；侧栏可一键补全老会话。关闭后不做任何命名调用，命令说明和思考块摘要也一并停用。"
              checked={aiNaming}
              onChange={(checked) => void toggleAiNaming(checked)}
            />
            <ToggleControl
              label="云端套餐额度显示"
              description="状态栏额度环的数据来源：复用 Kimi CLI 的登录凭证直连 Kimi 云端接口（与 CLI 同款数据源，但属于未公开的私有接口）。若你不希望 Tran 触碰 CLI 的登录凭证或访问云端，可关闭；关闭后额度环显示为不可用，聊天等其他功能不受影响。"
              checked={cloudUsage}
              onChange={(checked) => void toggleCloudUsage(checked)}
            />
            <ToggleControl
              label="后台任务结束后自动更新待办"
              description="后台任务收尾且待办还有未完成项时，Tran 替你向 AI 发一次「更新待办」的请求。⚠ 默认关闭：这是一次完整对话轮，要把整个会话上下文重新过一遍——实测一个 42 条记录的会话约 88000 token，是命名那类小请求（约 120 token）的七百倍。而且你下次随便发条消息，AI 本来就会收到后台任务的完成通知并更新待办，所以它买到的只是「提前」，不是「否则就不会更新」。愿意花这个额度换及时性再开。"
              checked={autoTodoNudge}
              onChange={(checked) => void toggleAutoTodoNudge(checked)}
            />
            {/* 独立摘要 API：不复用 Kimi 的任何登录态或内部接口。 */}
            <div className="space-y-2">
              <div>
                <div className="text-xs font-medium text-zinc-300">摘要 / 命名 API</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                  会话命名、命令说明、思考摘要和思考翻译统一走这里。支持 DeepSeek
                  等 OpenAI 兼容接口；API Key 使用系统安全存储，不会发送给 Kimi。
                </div>
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">API Base URL</span>
                <input
                  type="url"
                  value={summaryApiBaseUrl}
                  spellCheck={false}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => setSummaryApiBaseUrl(e.target.value)}
                  onBlur={(e) => void saveSummaryApiBaseUrl(e.target.value)}
                  className="w-full rounded-lg border border-border-subtle bg-bg-elev/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-zinc-500">API Key</span>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={summaryApiKey}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={summaryKeyMasked ? `已配置 ${summaryKeyMasked} · 输入新 Key 覆盖` : 'sk-...'}
                    onChange={(e) => setSummaryApiKey(e.target.value)}
                    onBlur={(e) => void saveSummaryApiKey(e.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-elev/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                  />
                  {summaryKeyMasked && (
                    <button
                      type="button"
                      onClick={() => void clearSummaryApiKey()}
                      className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                    >
                      清除
                    </button>
                  )}
                </div>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={summaryModel}
                  spellCheck={false}
                  placeholder="deepseek-v4-flash"
                  onChange={(e) => setSummaryModel(e.target.value)}
                  onBlur={(e) => void saveSummaryModel(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-elev/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
                <button
                  type="button"
                  onClick={() => void runProbeSummaryModels()}
                  disabled={probing}
                  className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {probing ? '探测中…' : '测试接口'}
                </button>
                <button
                  type="button"
                  onClick={() => void runDiagnoseSummaryPrompt()}
                  disabled={diagnosing}
                  title="四种请求形态各打一发（约 400 token），定位服务端拒绝哪个参数"
                  className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {diagnosing ? '自检中…' : '提示词自检'}
                </button>
              </div>
              {probes && (
                <div className="space-y-1 rounded-lg border border-white/[0.06] bg-bg-elev/60 p-2">
                  {probes.map((p) => (
                    <div key={p.model} className="flex items-baseline gap-2 text-[11px]">
                      <span
                        className={
                          p.ok && p.known ? 'text-emerald-400' : p.ok ? 'text-amber-400' : 'text-zinc-600'
                        }
                      >
                        {p.ok && p.known ? '✓' : p.ok ? '⚠' : '✕'}
                      </span>
                      <button
                        type="button"
                        disabled={!p.ok || !p.known}
                        onClick={() => void saveSummaryModel(p.model)}
                        className="font-mono text-zinc-300 enabled:hover:text-accent enabled:hover:underline disabled:cursor-default disabled:text-zinc-600"
                        title={p.ok && p.known ? '点击选用该型号' : undefined}
                      >
                        {p.model}
                      </button>
                      {p.displayName && <span className="text-zinc-500">{p.displayName}</span>}
                      {p.contextLength && (
                        <span className="text-zinc-600">{Math.round(p.contextLength / 1024)}k</span>
                      )}
                      {p.ok ? (
                        <span className="text-zinc-500">{p.latencyMs} ms</span>
                      ) : (
                        <span className="min-w-0 truncate text-zinc-600" title={p.error}>
                          {p.error}
                        </span>
                      )}
                      {p.ok && !p.known && <span className="text-amber-400/80">接口可用，模型目录未确认</span>}
                    </div>
                  ))}
                  <div className="pt-1 text-[10px] leading-relaxed text-zinc-600">
                    Tran 会先尝试读取 <code className="font-mono">/models</code>，再向当前模型发送
                    一条最小测试请求。部分兼容服务不提供模型目录，此时只报告接口是否可用。
                  </div>
                </div>
              )}
              {diagnosis && (
                <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-bg-elev/60 p-2">
                  {diagnosis.map((d) => (
                    <div key={d.label} className="space-y-0.5 text-[11px]">
                      <div className="flex items-baseline gap-2">
                        <span className={d.ok ? 'text-emerald-400' : 'text-red-400'}>{d.ok ? '✓' : '✕'}</span>
                        <span className="text-zinc-300">{d.label}</span>
                        <span className="text-zinc-600">{d.latencyMs} ms</span>
                        {d.ok && (
                          <span className={d.cleaned ? 'text-emerald-400' : 'text-amber-400'}>
                            {d.cleaned ? `清洗后：${d.cleaned}` : '清洗后判废'}
                          </span>
                        )}
                      </div>
                      {(d.output || d.error) && (
                        <div className="break-all pl-5 font-mono text-[10px] leading-relaxed text-zinc-500">
                          {d.output ?? d.error}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="pt-1 text-[10px] leading-relaxed text-zinc-600">
                    形态 2 失败 = 端点不支持 stop；形态 3 失败 = 不接受 assistant 角色消息。
                    失败行显示的是服务端原文。2026-07-30 实测四种形态**全部可用**，
                    正式路径用的是形态 4（多轮少样本 + stop）。
                  </div>
                </div>
              )}
            </div>
            {/* DeepSeek 余额：官方 GET /user/balance，用量卡里展示一行。
                与上面的摘要 API 相互独立——那边可以是任何 OpenAI 兼容服务。 */}
            <div className="space-y-2">
              <div>
                <div className="text-xs font-medium text-zinc-300">DeepSeek 余额</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                  用量卡里显示 DeepSeek 账户余额（总 / 充值 / 赠金），走官方公开的
                  /user/balance 接口。填你的 DeepSeek API Key 即可；官方只暴露余额，
                  没有 token 用量明细。Key 使用系统安全存储。
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={deepseekApiKey}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={deepseekKeyMasked ? `已配置 ${deepseekKeyMasked} · 输入新 Key 覆盖` : 'sk-...'}
                  onChange={(e) => setDeepseekApiKey(e.target.value)}
                  onBlur={(e) => void saveDeepseekKey(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-elev/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
                {deepseekKeyMasked && (
                  <button
                    type="button"
                    onClick={() => void clearDeepseekKey()}
                    className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
            <ToggleControl
              label="最小化到系统托盘"
              description="关闭窗口时最小化到托盘而非退出应用。点击托盘图标可恢复窗口。"
              checked={minimizeToTray}
              onChange={(checked) => void toggleMinimizeToTray(checked)}
            />
            <ToggleControl
              label="启动时最大化"
              description="应用启动时主窗口直接最大化显示。"
              checked={startMaximized}
              onChange={(checked) => void toggleStartMaximized(checked)}
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
            </div>
            <div className="border-t border-white/[0.06] pt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs text-zinc-500">Kimi Code CLI 版本</div>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                    只检查不自动安装 —— 升级需重装全局 npm 包并重连 ACP，正在跑的对话会断，时机由你定。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void checkKimi(true)}
                  disabled={checkingKimi}
                  className="shrink-0 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
                >
                  {checkingKimi ? '检查中...' : '检查版本'}
                </button>
              </div>
              {kimiVersion && (
                <div className="text-[11px] text-zinc-500">
                  {kimiVersion.error ? (
                    <span className="text-amber-400/90">{kimiVersion.error}</span>
                  ) : (
                    <>
                      当前 {kimiVersion.currentVersion ?? '未知'}
                      {kimiVersion.latestVersion ? ` / 最新 ${kimiVersion.latestVersion}` : ''}
                      {kimiVersion.installMethod === 'installer'
                        ? ' · 官方脚本安装'
                        : kimiVersion.installMethod === 'npm'
                          ? ' · npm 全局安装'
                          : ''}
                      {kimiVersion.updateAvailable ? (
                        <span className="ml-1 text-accent">· 有新版本</span>
                      ) : (
                        <span className="ml-1 text-zinc-600">· 已是最新</span>
                      )}
                    </>
                  )}
                </div>
              )}
              {kimiVersion?.updateAvailable && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setKimiConfirmOpen(true)}
                      disabled={upgradingKimi || kimiVersion.installMethod === 'unknown'}
                      title={
                        kimiVersion.installMethod === 'unknown'
                          ? `无法判断安装方式（${kimiVersion.installPath ?? ''}），请手动升级`
                          : kimiVersion.upgradeCommand
                      }
                      className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {upgradingKimi ? '升级中…' : `一键升级到 ${kimiVersion.latestVersion ?? '最新版'}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyKimiUpgrade()}
                      className="rounded-md border border-border-subtle px-2 py-1.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                      title={kimiVersion.upgradeCommand}
                    >
                      {kimiCopied ? '已复制' : '复制命令'}
                    </button>
                  </div>
                  {kimiUpgradeMsg && (
                    <div className="text-[11px] leading-relaxed text-zinc-400">{kimiUpgradeMsg}</div>
                  )}
                </div>
              )}
              <ConfirmDialog
                open={kimiConfirmOpen}
                title="升级 Kimi Code CLI"
                message={`将执行 ${kimiVersion?.upgradeCommand ?? ''}。\n\n升级前会断开全部会话——Windows 上正在运行的 kimi 会占用文件，不断开必然安装失败。正在进行的对话会中断，历史不受影响。`}
                confirmLabel="断开会话并升级"
                onConfirm={() => void runKimiUpgrade()}
                onCancel={() => setKimiConfirmOpen(false)}
              />
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
                    导出运行时状态、配置快照和最近日志；敏感密钥会脱敏。
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
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-150 ease-out ${
                  vulkan ? 'translate-x-5' : 'translate-x-0'
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
