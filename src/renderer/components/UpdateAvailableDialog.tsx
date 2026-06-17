import { useState } from 'react'
import type { UpdateCheckResult } from '../../shared/ipc'

interface UpdateAvailableDialogProps {
  info: UpdateCheckResult | null
  onClose: () => void
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function UpdateAvailableDialog({
  info,
  onClose
}: UpdateAvailableDialogProps): JSX.Element | null {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!info || !info.updateAvailable) return null

  const download = async (): Promise<void> => {
    setError(null)
    setDownloading(true)
    try {
      const result = await window.api.downloadAndInstallUpdate(info.asset?.browserDownloadUrl)
      if (!result.ok) {
        setError(result.error ?? '下载更新失败。')
        setDownloading(false)
        return
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="text-base font-semibold text-zinc-100">发现 Forge 更新</h2>
        </div>
        <p className="text-sm leading-relaxed text-zinc-400">
          当前版本 {info.currentVersion}，最新版本 {info.latestVersion ?? '未知'}。
          {info.asset?.size ? ` 安装包约 ${formatBytes(info.asset.size)}。` : ''}
        </p>
        {info.releaseName && (
          <p className="mt-2 truncate text-xs text-zinc-500">{info.releaseName}</p>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            稍后
          </button>
          {info.releaseUrl && (
            <a
              href={info.releaseUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
            >
              查看发布页
            </a>
          )}
          <button
            type="button"
            onClick={() => void download()}
            disabled={downloading || !info.asset}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {downloading ? '下载中...' : '下载并打开'}
          </button>
        </div>
      </div>
    </div>
  )
}
