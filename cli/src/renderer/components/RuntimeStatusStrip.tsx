import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { RuntimeStatus } from '../../shared/ipc'
import { onForgeEvent } from '../events'

function shortVersion(version: string | undefined): string {
  if (!version) return 'Agent ?'
  return version.replace(/^(claude(?: code)?|codex-cli|hermes agent)\s*/i, '').trim() || version
}

export default function RuntimeStatusStrip(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const setView = useUiStore((s) => s.setView)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)

  useEffect(() => {
    let alive = true
    let requestSeq = 0
    let probeTimer: number | null = null

    if (!meta) {
      setStatus(null)
      return () => {
        alive = false
      }
    }

    const loadStatus = async (refreshProbe: boolean, seq: number): Promise<void> => {
      if (typeof window.api.getRuntimeStatus !== 'function') return
      const [next, prefs] = await Promise.all([
        window.api
          .getRuntimeStatus(meta.cwd, meta.model, refreshProbe ? { refreshProbe: true } : undefined)
          .catch(() => null),
        window.api.getPreferences().catch(() => null)
      ])
      if (!alive || seq !== requestSeq) return
      setWslSupportEnabled(!!prefs?.wslSupportEnabled)
      if (next) setStatus(next)
    }

    const refresh = (): void => {
      requestSeq += 1
      const seq = requestSeq
      if (probeTimer !== null) {
        window.clearTimeout(probeTimer)
        probeTimer = null
      }

      void loadStatus(false, seq)
      probeTimer = window.setTimeout(() => {
        probeTimer = null
        void loadStatus(true, seq)
      }, 450)
    }

    refresh()
    const offAgentBackend = onForgeEvent('agentBackendChanged', refresh)
    const offProvider = onForgeEvent('providerChanged', refresh)
    const offModels = onForgeEvent('modelOptionsChanged', refresh)
    const offWslSupport = onForgeEvent('wslSupportChanged', refresh)
    return () => {
      alive = false
      if (probeTimer !== null) window.clearTimeout(probeTimer)
      offAgentBackend()
      offProvider()
      offModels()
      offWslSupport()
    }
  }, [meta?.cwd, meta?.model])

  if (!meta) return <></>

  const backend = status?.backend ?? 'windows'
  const activeAgentBackend = status?.agentBackend ?? meta.agentBackend ?? 'claude-code'
  const showProvider = activeAgentBackend === 'claude-code' || activeAgentBackend === 'hermes'
  const agentName = status?.agentName ?? 'Forge Agent'
  const providerName =
    activeAgentBackend === 'codex'
      ? 'Codex CLI'
      : activeAgentBackend === 'hermes'
        ? status?.provider?.name || status?.provider?.baseUrl || 'Hermes 运营商'
        : status?.provider?.name || status?.provider?.baseUrl || '未配置运营商'
  const versionSource = status?.agentVersion ?? status?.claudeCodeVersion
  const version = versionSource ? shortVersion(versionSource) : `${agentName} ?`
  const versionTitle = status?.versionError
    ? `${agentName} version check failed: ${status.versionError}`
    : status?.agentPath || status?.claudeCodePath || versionSource || version

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
        <div className={`runtime-provider-reveal ${showProvider ? 'is-visible' : ''}`}>
          <button
            type="button"
            onClick={() => {
              if (showProvider) setView('providers')
            }}
            className={`${chip} min-w-0`}
            title="运营商配置"
            disabled={!showProvider}
            tabIndex={showProvider ? 0 : -1}
            aria-hidden={!showProvider}
          >
            <span className="text-zinc-600">运营商</span>
            <span className="truncate text-zinc-300">{providerName}</span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => setView(backend === 'wsl' && wslSupportEnabled ? 'wslHealth' : 'settings')}
          className={`${chip} ml-auto shrink-0 ${status?.versionError ? 'text-amber-300' : ''}`}
          title={versionTitle}
        >
          <span className="text-zinc-600">Agent</span>
          <span className="text-zinc-300">{agentName}</span>
          <span className="font-mono text-zinc-300">{version}</span>
        </button>
      </div>
    </div>
  )
}
