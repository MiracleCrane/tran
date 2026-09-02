import { useCallback, useEffect, useState } from 'react'
import type { RpTavernStatus } from '../../shared/ipc'
import {
  RefreshIcon,
  ToolPanelAlert,
  ToolPanelButton,
  ToolPanelHeader
} from './ToolPanelChrome'
import HoverTip from './HoverTip'

function StatusDot({ ok }: { ok: boolean }): JSX.Element {
  return <span className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
}

function StatusRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] py-2.5 last:border-0">
      <div className="flex items-center gap-2 text-sm text-zinc-300">
        <StatusDot ok={ok} />
        {label}
      </div>
      {/* 2026-09-02：原生 title= 全 app 禁用，换 HoverTip 气泡（detail 截断时悬停看全文）。 */}
      <HoverTip tip={detail} tipClassName="break-all" className="inline-flex min-w-0">
        <span className="truncate text-xs text-zinc-500">{detail}</span>
      </HoverTip>
    </div>
  )
}

export default function RpTavernPanel(): JSX.Element {
  const [status, setStatus] = useState<RpTavernStatus | null>(null)
  const [installPath, setInstallPath] = useState('C:\\LegacyD\\project\\SillyTavern')
  const [busy, setBusy] = useState<'refresh' | 'save' | 'open' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const next = await window.api.getRpTavernStatus()
      setStatus(next)
      if (next.installPath) setInstallPath(next.installPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function savePath(): Promise<void> {
    setBusy('save')
    setError(null)
    try {
      const next = await window.api.configureRpTavern(installPath)
      setStatus(next)
      if (!next.installed) setError('这个目录不是有效的 SillyTavern 安装目录。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  async function openTavern(): Promise<void> {
    setBusy('open')
    setError(null)
    try {
      const result = await window.api.openRpTavern()
      setStatus(result.status)
      if (!result.ok) setError(result.error ?? '无法打开 RP 酒馆。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto px-6 pb-8">
      <ToolPanelHeader
        title="RP 酒馆"
        description="在 Tran 中启动并打开外置 SillyTavern"
        actions={
          <ToolPanelButton onClick={() => void refresh()} disabled={busy !== null}>
            <RefreshIcon spinning={busy === 'refresh'} />
            刷新状态
          </ToolPanelButton>
        }
      />

      {error ? <ToolPanelAlert tone="error">{error}</ToolPanelAlert> : null}
      {status?.installed && status.nodeCompatible && status.running ? (
        <ToolPanelAlert tone="success">酒馆已就绪，可以直接打开 RP TUI。</ToolPanelAlert>
      ) : null}

      <section className="mb-5 rounded-xl border border-border-subtle bg-bg-panel/70 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-200">运行状态</h2>
        <StatusRow
          label="SillyTavern"
          ok={status?.installed ?? false}
          detail={status?.installed ? `v${status.version ?? '未知'}` : '未检测到'}
        />
        <StatusRow
          label="Node.js 20+"
          ok={status?.nodeCompatible ?? false}
          detail={status?.nodeVersion ?? '未检测到'}
        />
        <StatusRow
          label="酒馆服务"
          ok={status?.running ?? false}
          detail={status?.running ? '127.0.0.1:8000' : '未运行'}
        />
      </section>

      <section className="mb-5 rounded-xl border border-border-subtle bg-bg-panel/70 p-4">
        <label htmlFor="rp-tavern-path" className="mb-2 block text-sm font-medium text-zinc-200">
          SillyTavern 安装目录
        </label>
        <div className="flex gap-2">
          <input
            id="rp-tavern-path"
            value={installPath}
            onChange={(event) => setInstallPath(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-black/20 px-3 py-2 font-mono text-xs text-zinc-300 outline-none transition focus:border-accent/60"
          />
          <ToolPanelButton onClick={() => void savePath()} disabled={busy !== null || !installPath.trim()}>
            {busy === 'save' ? '保存中…' : '保存目录'}
          </ToolPanelButton>
        </div>
        <p className="mt-2 text-xs leading-5 text-zinc-500">
          Tran 仅保存目录并调用现有安装，不会自动拉取更新，也不会在退出时结束你自行启动的酒馆服务。
        </p>
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          API、模型、Prompt、角色卡和世界书全部由 SillyTavern 自己管理，Tran 不读取或修改这些配置。
        </p>
      </section>

      <div className="mb-5 flex justify-end">
        <ToolPanelButton
          variant="primary"
          className="min-w-28"
          onClick={() => void openTavern()}
          disabled={busy !== null || !status?.installed || !status.nodeCompatible}
        >
          {busy === 'open' ? '正在启动…' : '打开 RP TUI'}
        </ToolPanelButton>
      </div>

      <section className="rounded-xl border border-border-subtle bg-bg-panel/40 p-4 text-xs leading-6 text-zinc-500">
        <h2 className="mb-1 text-sm font-medium text-zinc-300">首次安装说明</h2>
        <p>需要先单独安装 Node.js 20+ 和 SillyTavern。推荐克隆官方 release 分支：</p>
        <code className="my-2 block overflow-x-auto rounded-md bg-black/30 px-3 py-2 text-[11px] text-zinc-300">
          git clone https://github.com/SillyTavern/SillyTavern -b release
        </code>
        <p>
          SillyTavern 是独立的 AGPL-3.0 软件；Tran 不打包、不修改它的源码。角色卡、聊天记录、模型密钥和更新均由
          SillyTavern 自己管理。{' '}
          <a
            href="https://github.com/SillyTavern/SillyTavern"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            查看官方仓库
          </a>
        </p>
      </section>
    </div>
  )
}
