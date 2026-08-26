import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { RuntimeStatus } from '../../shared/ipc'
import { onForgeEvent } from '../events'
import HoverTip from './HoverTip'

function shortVersion(version: string | undefined): string {
  if (!version) return 'Agent ?'
  return version.replace(/^(kimi(?: code(?: cli)?)?)\s*/i, '').trim() || version
}

export default function RuntimeStatusStrip(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const setView = useUiStore((s) => s.setView)
  const openSettings = useUiStore((s) => s.openSettings)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  /** 摘要 API 的不可自愈故障（额度耗尽/凭证失效）。静默回退是这条链路的常态，
   *  但这两类静默下去就是"功能悄悄停了"，必须让用户看见。 */
  const [summaryIssue, setSummaryIssue] = useState<{ kind: string; detail: string } | null>(null)

  useEffect(() => {
    if (typeof window.api.onSummaryApiIssue !== 'function') return
    return window.api.onSummaryApiIssue(setSummaryIssue)
  }, [])

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
  // TODO(providers): 运营商芯片绑定旧 Claude 后端，kimi-only 阶段固定隐藏。
  const showProvider = false
  const agentName = status?.agentName ?? 'Tran Agent'
  const providerName = status?.provider?.name || status?.provider?.baseUrl || '未配置运营商'
  const versionSource = status?.agentVersion
  const version = versionSource ? shortVersion(versionSource) : `${agentName} ?`
  const versionTitle = status?.versionError
    ? `${agentName} version check failed: ${status.versionError}`
    : status?.agentPath || versionSource || version

  const chip =
    'inline-flex min-w-0 items-center gap-1 rounded-[5px] px-1 py-0 text-[9px] leading-[11px] transition hover:bg-white/[0.07] hover:text-zinc-200'

  return (
    <div className="px-1 pb-0 pt-1">
      <div className="flex w-full items-center gap-0.5 overflow-hidden rounded-[14px] border border-white/[0.03] bg-white/[0.006] px-1 py-0 text-zinc-500">
        <HoverTip tip="运行环境设置">
          <button
            type="button"
            onClick={() => setView(backend === 'wsl' && wslSupportEnabled ? 'wslHealth' : 'settings')}
            className={`${chip} shrink-0`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${backend === 'wsl' ? 'bg-sky-400' : 'bg-emerald-400'}`} />
            <span>{backend === 'wsl' ? 'WSL' : 'Windows'}</span>
            {wslSupportEnabled && status?.wslDistro && (
              <span className="max-w-24 truncate text-zinc-600">{status.wslDistro}</span>
            )}
          </button>
        </HoverTip>
        {summaryIssue && (
          <HoverTip
            tip={`${summaryIssue.detail}\n\n点击前往 设置 → AI 功能 检查配置；点掉即忽略本次提示。`}
            tipClassName="whitespace-pre-line break-words text-left"
          >
            <button
              type="button"
              onClick={() => {
                // 「AI 辅助」页 2026-08-27 并入 设置 → AI 功能，这里跟着改指向。
                openSettings('assistant')
                setSummaryIssue(null)
              }}
              className={`${chip} shrink-0 text-amber-400/90 hover:text-amber-300`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              <span>
                {summaryIssue.kind === 'quota'
                  ? '摘要额度已用尽'
                  : summaryIssue.kind === 'network'
                    ? '摘要 API 连不上'
                    : '摘要 Key 失效'}
              </span>
            </button>
          </HoverTip>
        )}
        <div className={`runtime-provider-reveal ${showProvider ? 'is-visible' : ''}`}>
          <HoverTip tip="运营商配置" className="inline-flex min-w-0">
            <button
              type="button"
              onClick={() => {
                if (showProvider) setView('providers')
              }}
              className={`${chip} min-w-0`}
              disabled={!showProvider}
              tabIndex={showProvider ? 0 : -1}
              aria-hidden={!showProvider}
            >
              <span className="text-zinc-600">运营商</span>
              <span className="truncate text-zinc-300">{providerName}</span>
            </button>
          </HoverTip>
        </div>
        <HoverTip tip={versionTitle} tipClassName="break-all text-left" className="ml-auto inline-flex shrink-0">
          <button
            type="button"
            onClick={() => setView(backend === 'wsl' && wslSupportEnabled ? 'wslHealth' : 'settings')}
            className={`${chip} ${status?.versionError ? 'text-amber-300' : ''}`}
          >
            <span className="text-zinc-600">Agent</span>
            <span className="text-zinc-300">{agentName}</span>
            <span className="font-mono text-zinc-300">{version}</span>
          </button>
        </HoverTip>
      </div>
    </div>
  )
}
