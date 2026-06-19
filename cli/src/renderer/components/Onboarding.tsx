import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { ClaudeExecutionBackend, Provider } from '../../shared/ipc'
import { isWslProjectPath } from '../../shared/paths'
import { emitForgeEvent } from '../events'

const EMPTY_PROVIDER_MAP: Record<ClaudeExecutionBackend, Provider[]> = {
  windows: [],
  wsl: []
}

const EMPTY_SELECTED_PROVIDER_MAP: Record<ClaudeExecutionBackend, string> = {
  windows: '',
  wsl: ''
}

export default function Onboarding(): JSX.Element {
  const startSession = useSessionStore((s) => s.startSession)
  const showBlockingOverlay = useUiStore((s) => s.showBlockingOverlay)
  const hideBlockingOverlay = useUiStore((s) => s.hideBlockingOverlay)
  const [cwd, setCwd] = useState('')
  const [backend, setBackend] = useState<ClaudeExecutionBackend>('windows')
  const [providersByBackend, setProvidersByBackend] =
    useState<Record<ClaudeExecutionBackend, Provider[]>>(EMPTY_PROVIDER_MAP)
  const [selectedIds, setSelectedIds] =
    useState<Record<ClaudeExecutionBackend, string>>(EMPTY_SELECTED_PROVIDER_MAP)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const profiles = await window.api.getProviderProfiles()
        const nextProviders: Record<ClaudeExecutionBackend, Provider[]> = { windows: [], wsl: [] }
        const nextSelected: Record<ClaudeExecutionBackend, string> = { windows: '', wsl: '' }
        for (const profile of profiles.profiles) {
          if (profile.backend !== 'windows' && profile.backend !== 'wsl') continue
          nextProviders[profile.backend] = profile.providers
          nextSelected[profile.backend] =
            profile.activeProviderId ?? profile.providers[0]?.id ?? ''
        }
        setProvidersByBackend(nextProviders)
        setSelectedIds(nextSelected)
        setBackend(
          profiles.activeBackend === 'windows' || profiles.activeBackend === 'wsl'
            ? profiles.activeBackend
            : 'windows'
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const inferBackendFromPath = (path: string): ClaudeExecutionBackend =>
    isWslProjectPath(path, { includePosixAbsolute: true }) ? 'wsl' : backend

  const providers = providersByBackend[backend]
  const selectedId = selectedIds[backend]

  const selectBackend = (next: ClaudeExecutionBackend): void => {
    setBackend(next)
    setError(null)
  }

  const selectProvider = (id: string): void => {
    setSelectedIds((prev) => ({ ...prev, [backend]: id }))
  }

  const pick = async (): Promise<void> => {
    const overlayId = showBlockingOverlay('正在等待资源管理器响应...')
    let dir: string | null = null
    try {
      dir = await window.api.pickDirectory({ backend })
    } finally {
      hideBlockingOverlay(overlayId)
    }
    if (!dir) return
    const nextBackend = inferBackendFromPath(dir)
    if (nextBackend !== backend) setBackend(nextBackend)
    setCwd(dir)
  }

  const start = async (): Promise<void> => {
    setError(null)
    const cleanCwd = cwd.trim()
    const targetBackend = inferBackendFromPath(cleanCwd)
    const targetProviders = providersByBackend[targetBackend]
    const targetSelectedId = selectedIds[targetBackend]
    const targetSelected = targetProviders.find((p) => p.id === targetSelectedId) ?? null

    if (!cleanCwd) {
      setError('请先选择一个工作目录。')
      return
    }
    if (!targetSelected) {
      setError('请选择一个运营商。')
      return
    }
    setSubmitting(true)
    try {
      await window.api.savePreferences({
        claudeExecutionBackend: targetBackend,
        ...(targetBackend === 'wsl' ? { wslSupportEnabled: true } : {})
      })
      // Make the chosen provider active before spawning, so its env/model apply.
      await window.api.setActiveProviderForBackend(targetBackend, targetSelected.id)
      // Persist the picked directory as the first project (and last-used), so
      // the app auto-enters it next launch instead of showing onboarding again.
      await window.api.addProject(cleanCwd)
      if (targetBackend === 'wsl') emitForgeEvent('wslSupportChanged')
      emitForgeEvent('providerChanged')
      emitForgeEvent('modelOptionsChanged')
      await startSession({ cwd: cleanCwd, model: targetSelected.model })
      // startSession() sets meta → App switches to the main view and unmounts us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-transparent px-6">
      <div className="w-full max-w-lg rounded-2xl border border-border-subtle bg-bg-panel p-8 shadow-2xl">
        <div className="mb-1 text-2xl font-semibold text-zinc-100">Forge</div>
        <div className="mb-6 text-sm text-zinc-400">
          Forge 的桌面 Agent 客户端。选择一个项目文件夹即可开始。
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Runtime
        </label>
        <div className="mb-4 grid grid-cols-2 gap-2">
          {(['windows', 'wsl'] as ClaudeExecutionBackend[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => selectBackend(item)}
              aria-pressed={backend === item}
              className={`rounded-lg border px-3 py-2 text-sm transition ${
                backend === item
                  ? 'border-accent bg-accent/15 text-zinc-100'
                  : 'border-border-subtle bg-bg-elev text-zinc-400 hover:bg-bg-hover hover:text-zinc-200'
              }`}
            >
              {item === 'wsl' ? 'WSL' : 'Windows'}
            </button>
          ))}
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          工作目录
        </label>
        <div className="mb-4 flex gap-2">
          <input
            value={cwd}
            onChange={(e) => {
              const next = e.target.value
              setCwd(next)
              if (isWslProjectPath(next, { includePosixAbsolute: true }) && backend !== 'wsl') {
                setBackend('wsl')
              }
            }}
            placeholder={backend === 'wsl' ? '/home/user/project' : 'C:\\Projects\\path'}
            className="flex-1 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-accent"
          />
          <button
            onClick={pick}
            className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 hover:bg-bg-hover"
          >
            浏览…
          </button>
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          运营商
        </label>
        <select
          value={selectedId}
          onChange={(e) => selectProvider(e.target.value)}
          className="mb-2 w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.baseUrl} · {p.baseUrl} · {p.model}
            </option>
          ))}
        </select>
        <p className="mb-5 text-xs text-zinc-500">
          进入后可从左侧「运营商」添加更多配置并自由切换。当前所选的地址与密钥会用于本次会话。
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={start}
          disabled={submitting}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '正在启动…' : '开始会话'}
        </button>
      </div>
    </div>
  )
}
