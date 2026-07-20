import { useEffect, useRef, useState } from 'react'
import type { UpdateCheckResult, UpdateDownloadProgress } from '../../shared/ipc'
import {
  createDownloadRequestId,
  formatBytes,
  formatProgressText,
  formatSpeed,
  progressPercent
} from '../utils/downloadFormat'

interface UpdateAvailableDialogProps {
  info: UpdateCheckResult | null
  onClose: () => void
}

export default function UpdateAvailableDialog({
  info,
  onClose
}: UpdateAvailableDialogProps): JSX.Element | null {
  const requestIdRef = useRef(createDownloadRequestId('update-dialog'))
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null)
  const [downloadPath, setDownloadPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return window.api.onUpdateDownloadProgress((next) => {
      if (next.requestId && next.requestId !== requestIdRef.current) return
      setProgress(next)
    })
  }, [])

  if (!info || !info.updateAvailable) return null

  const download = async (): Promise<void> => {
    setError(null)
    setProgress(null)
    setDownloadPath(null)
    setDownloading(true)
    try {
      requestIdRef.current = createDownloadRequestId('update-dialog')
      const result = await window.api.downloadAndInstallUpdate({
        assetUrl: info.asset?.browserDownloadUrl,
        requestId: requestIdRef.current
      })
      if (result.canceled) {
        setDownloading(false)
        return
      }
      if (!result.ok) {
        setError(result.error ?? '下载更新失败。')
        setDownloading(false)
        return
      }
      setDownloadPath(result.path ?? null)
      setDownloading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDownloading(false)
    }
  }

  const percent = progressPercent(progress)

  return (
    <div
      className="tran-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={downloading ? undefined : onClose}
    >
      <div
        className="tran-modal-panel w-full max-w-md rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="text-base font-semibold text-zinc-100">发现 Tran 更新</h2>
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
        {(downloading || progress || downloadPath) && (
          <div className="mt-4 rounded-xl border border-white/[0.06] bg-bg-elev/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className="text-zinc-300">
                {progress?.done ? '下载完成' : downloading ? '下载中' : '准备下载'}
              </span>
              <span className="font-mono text-zinc-500">
                {progress && progress.totalBytes ? `${percent.toFixed(1)}%` : formatSpeed(progress?.bytesPerSecond)}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-black/30">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${progress?.totalBytes ? percent : downloading ? 100 : 0}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
              <span>{formatProgressText(progress)}</span>
              {progress && progress.totalBytes && <span>{formatSpeed(progress.bytesPerSecond)}</span>}
            </div>
            {downloadPath && (
              <p className="mt-2 truncate text-[11px] text-zinc-500" title={downloadPath}>
                已保存并打开：{downloadPath}
              </p>
            )}
          </div>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={downloading}
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
            {downloading ? '下载中...' : downloadPath ? '重新下载' : '选择目录并下载'}
          </button>
        </div>
      </div>
    </div>
  )
}
