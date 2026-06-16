import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { RuntimeStatus } from '../../shared/ipc'

function shortVersion(version: string | undefined): string {
  if (!version) return 'Claude ?'
  return version.replace(/^claude(?: code)?\s*/i, '').trim() || version
}

export default function RuntimeStatusStrip(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const setView = useUiStore((s) => s.setView)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)

  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      if (!meta) return
      if (typeof window.api.getRuntimeStatus !== 'function') return
      const [next, prefs] = await Promise.all([
        window.api.getRuntimeStatus(meta.cwd, meta.model).catch(() => null),
        window.api.getPreferences().catch(() => null)
      ])
      if (alive) setWslSupportEnabled(!!prefs?.wslSupportEnabled)
      if (alive && next) setStatus(next)
    }

    void refresh()
    window.addEventListener('forge:provider-changed', refresh)
    window.addEventListener('forge:model-options-changed', refresh)
    window.addEventListener('forge:wsl-support-changed', refresh)
    return () => {
      alive = false
      window.removeEventListener('forge:provider-changed', refresh)
      window.removeEventListener('forge:model-options-changed', refresh)
      window.removeEventListener('forge:wsl-support-changed', refresh)
    }
  }, [meta?.cwd, meta?.model, meta])

  if (!meta) return <></>

  const backend = status?.backend ?? 'windows'
  const providerName = status?.provider?.name || status?.provider?.baseUrl || 'No provider'
  const version = status?.claudeCodeVersion ? shortVersion(status.claudeCodeVersion) : 'Claude ?'
  const versionTitle = status?.versionError
    ? `Claude Code version check failed: ${status.versionError}`
    : status?.claudeCodePath || status?.claudeCodeVersion || version

  const chip =
    'inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.07] hover:text-zinc-200'

  return (
    <div className="px-6 pb-1 pt-2">
      <div className="mx-auto flex max-w-5xl items-center gap-1.5 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025] px-2 py-1 text-zinc-500">
        <button
          type="button"
          onClick={() => setView(backend === 'wsl' && wslSupportEnabled ? 'wslHealth' : 'settings')}
          className={`${chip} shrink-0`}
          title="运行环境设置"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${backend === 'wsl' ? 'bg-sky-400' : 'bg-emerald-400'}`} />
          <span>{backend === 'wsl' ? 'WSL' : 'Windows'}</span>
          {wslSupportEnabled && status?.wslDistro && (
            <span className="max-w-24 truncate text-zinc-600">{status.wslDistro}</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setView('providers')}
          className={`${chip} min-w-0`}
          title="Provider 配置"
        >
          <span className="text-zinc-600">Provider</span>
          <span className="truncate text-zinc-300">{providerName}</span>
        </button>
        <button
          type="button"
          onClick={() => setView(backend === 'wsl' && wslSupportEnabled ? 'wslHealth' : 'settings')}
          className={`${chip} ml-auto shrink-0 ${status?.versionError ? 'text-amber-300' : ''}`}
          title={versionTitle}
        >
          <span className="text-zinc-600">Claude</span>
          <span className="font-mono text-zinc-300">{version}</span>
        </button>
      </div>
    </div>
  )
}
