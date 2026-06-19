import type { UpdateDownloadProgress } from '../../shared/ipc'

export function createDownloadRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return '0 KB'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  return `${formatBytes(bytesPerSecond ?? 0)}/s`
}

export function progressPercent(progress: UpdateDownloadProgress | null): number {
  if (!progress || typeof progress.percent !== 'number') return 0
  return Math.max(0, Math.min(100, progress.percent))
}

export function formatProgressText(progress: UpdateDownloadProgress | null): string {
  if (!progress) return '等待选择保存目录'
  const received = formatBytes(progress.receivedBytes)
  if (!progress.totalBytes) return `${received} / 未知大小`
  return `${received} / ${formatBytes(progress.totalBytes)}`
}
