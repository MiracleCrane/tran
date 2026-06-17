import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { PickedDirectoryEntry } from '../../shared/ipc'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { UserAttachment } from '../types'
import { pathToUserAttachment, pickedFileToUserAttachment } from '../utils/attachments'
import MessageText from './MessageText'

type TextMode = 'rendered' | 'source'

const CLOSE_ANIMATION_MS = 720
const CONTENT_SWAP_FADE_MS = 120
const PREVIEW_READ_ERROR = '文件或目录不存在，或无法读取。'

const BackIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CloseIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const RevealIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-11z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M9 13h6M12 10v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

function formatBytes(size?: number): string {
  if (!Number.isFinite(size)) return ''
  const value = Number(size)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function isMarkdownAttachment(attachment: UserAttachment): boolean {
  return /^(md|markdown|mdx)$/.test(extensionOf(attachment.name)) || attachment.mimeType === 'text/markdown'
}

function displayTextFor(attachment: UserAttachment): string {
  const text = attachment.text ?? ''
  if (extensionOf(attachment.name) !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function attachmentKey(attachment: UserAttachment | null): string {
  if (!attachment) return ''
  return `${attachment.path ?? ''}\n${attachment.name}\n${attachment.kind}`
}

function fileMeta(attachment: UserAttachment): string {
  if (attachment.previewState === 'loading') return 'loading'
  if (attachment.previewState === 'error') return 'unavailable'
  if (attachment.kind === 'directory') {
    const count = attachment.entries?.length ?? 0
    return ['directory', `${count}${attachment.entriesTruncated ? '+' : ''} items`].join(' · ')
  }
  return [attachment.kind, formatBytes(attachment.size)].filter(Boolean).join(' · ')
}

function loadingPathAttachment(path: string): UserAttachment {
  return pathToUserAttachment(path, { previewState: 'loading' })
}

function errorPathAttachment(path: string, error = PREVIEW_READ_ERROR): UserAttachment {
  return pathToUserAttachment(path, { previewState: 'error', previewError: error })
}

function SourceView({ attachment }: { attachment: UserAttachment }): JSX.Element {
  const text = displayTextFor(attachment)

  return (
    <pre className="m-0 min-h-full w-full whitespace-pre-wrap break-words bg-transparent px-2 py-1 font-mono text-[12.5px] leading-[1.55] text-zinc-300">{text || '(empty file)'}</pre>
  )
}

function DirectoryView({
  entries,
  truncated,
  onOpen
}: {
  entries: PickedDirectoryEntry[]
  truncated?: boolean
  onOpen: (event: MouseEvent<HTMLButtonElement>, path: string) => void
}): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
        这个目录为空或无法读取
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {truncated && (
        <div className="mb-2 rounded-lg border border-white/[0.08] bg-white/[0.035] px-2.5 py-2 text-[11px] text-zinc-500">
          目录内容较多，仅显示前 {entries.length} 项
        </div>
      )}
      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          onClick={(event) => onOpen(event, entry.path)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06]"
          title={`预览 ${entry.name}；Ctrl+点击在资源管理器中打开`}
        >
          <span className="w-8 shrink-0 rounded-md border border-white/[0.08] bg-white/[0.035] px-1 py-0.5 text-center text-[9px] uppercase tracking-wide text-zinc-500">
            {entry.kind === 'directory' ? 'dir' : 'file'}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-600">
            {entry.kind === 'directory' ? '' : formatBytes(entry.size)}
          </span>
        </button>
      ))}
    </div>
  )
}

function LoadingView({ path }: { path?: string }): JSX.Element {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-500">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
      <div>
        <div className="text-zinc-300">正在读取预览...</div>
        {path && <div className="mt-1 max-w-[18rem] truncate font-mono text-[11px] text-zinc-600">{path}</div>}
      </div>
    </div>
  )
}

function ErrorView({ path, message }: { path?: string; message: string }): JSX.Element {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-zinc-500">
      <div className="rounded-lg border border-orange-500/25 bg-orange-500/10 px-3 py-2 text-orange-200">
        {message}
      </div>
      {path && <div className="max-w-[18rem] truncate font-mono text-[11px] text-zinc-600">{path}</div>}
    </div>
  )
}

export default function AttachmentPreviewPane(): JSX.Element | null {
  const attachment = useUiStore((s) => s.attachmentPreview)
  const close = useUiStore((s) => s.closeAttachmentPreview)
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const [mode, setMode] = useState<TextMode>('rendered')
  const [renderedAttachment, setRenderedAttachment] = useState<UserAttachment | null>(attachment)
  const [history, setHistory] = useState<UserAttachment[]>(attachment ? [attachment] : [])
  const current = history[history.length - 1] ?? renderedAttachment
  const currentKey = attachmentKey(current)
  const [displayedCurrent, setDisplayedCurrent] = useState<UserAttachment | null>(current)
  const [contentSwitching, setContentSwitching] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const previewRequestSeqRef = useRef(0)

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }

    if (attachment) {
      setRenderedAttachment(attachment)
      setHistory([attachment])
      return
    }

    previewRequestSeqRef.current += 1
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setRenderedAttachment(null)
      setHistory([])
    }, CLOSE_ANIMATION_MS)

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [attachment])

  useEffect(() => {
    if (!current) {
      setDisplayedCurrent(null)
      setContentSwitching(false)
      return
    }

    if (!displayedCurrent || attachmentKey(displayedCurrent) === currentKey) {
      if (!displayedCurrent) setMode('rendered')
      setDisplayedCurrent(current)
      setContentSwitching(false)
      return
    }

    setContentSwitching(true)
    const timeout = window.setTimeout(() => {
      setMode('rendered')
      setDisplayedCurrent(current)
      window.requestAnimationFrame(() => setContentSwitching(false))
    }, CONTENT_SWAP_FADE_MS)

    return () => window.clearTimeout(timeout)
  }, [current, currentKey, displayedCurrent])

  const renderCurrent = displayedCurrent ?? current

  const isMarkdown = useMemo(
    () => !!renderCurrent && renderCurrent.kind === 'text' && isMarkdownAttachment(renderCurrent),
    [renderCurrent]
  )

  if (!renderCurrent) return null

  const pushPreview = (next: UserAttachment): void => {
    setRenderedAttachment(next)
    setHistory((prev) => [...(prev.length ? prev : [renderCurrent]), next])
  }

  const openPathPreview = (event: MouseEvent<HTMLButtonElement>, path: string): void => {
    if (event.ctrlKey) {
      void window.api.revealInExplorer(cwd, path)
      return
    }
    const requestSeq = ++previewRequestSeqRef.current
    const fallback = loadingPathAttachment(path)
    pushPreview(fallback)
    void window.api.readFiles(cwd, [path]).then((files) => {
      if (previewRequestSeqRef.current !== requestSeq) return
      const next = files[0] ? pickedFileToUserAttachment(files[0]) : errorPathAttachment(path)
      setRenderedAttachment(next)
      setHistory((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.path !== path) return prev
        return [...prev.slice(0, -1), next]
      })
    }).catch((error: unknown) => {
      if (previewRequestSeqRef.current !== requestSeq) return
      const message = error instanceof Error ? error.message : PREVIEW_READ_ERROR
      const next = errorPathAttachment(path, message || PREVIEW_READ_ERROR)
      setRenderedAttachment(next)
      setHistory((prev) => {
        const last = prev[prev.length - 1]
        if (!last || last.path !== path) return prev
        return [...prev.slice(0, -1), next]
      })
    })
  }

  const goBack = (): void => {
    setHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  const loading = renderCurrent.previewState === 'loading'
  const previewError = renderCurrent.previewState === 'error'
    ? (renderCurrent.previewError || PREVIEW_READ_ERROR)
    : null
  const canPreviewImage = !loading && !previewError && renderCurrent.kind === 'image' && !!renderCurrent.dataUrl
  const canPreviewText = !loading && !previewError && renderCurrent.kind === 'text' && typeof renderCurrent.text === 'string'
  const canPreviewDirectory = !loading && !previewError && renderCurrent.kind === 'directory'
  const canGoBack = history.length > 1
  const meta = fileMeta(renderCurrent)

  return (
    <aside className="attachment-preview-pane glass-panel flex shrink-0 flex-col rounded-[18px] border">
      <div
        className={`attachment-preview-header flex shrink-0 items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 ${
          contentSwitching ? 'is-switching' : ''
        }`}
      >
        {canGoBack && (
          <button
            type="button"
            onClick={goBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
            title="返回上一级"
          >
            <BackIcon />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100" title={renderCurrent.path ?? renderCurrent.name}>
            {renderCurrent.name}
          </div>
          {meta && <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-600">{meta}</div>}
        </div>
        {renderCurrent.path && (
          <button
            type="button"
            onClick={() => void window.api.revealInExplorer(cwd, renderCurrent.path ?? renderCurrent.name)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
            title="在资源管理器中打开"
          >
            <RevealIcon />
          </button>
        )}
        <button
          type="button"
          onClick={close}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
          title="关闭预览"
        >
          <CloseIcon />
        </button>
      </div>

      <div className={`attachment-preview-content min-h-0 flex-1 overflow-auto p-2 ${contentSwitching ? 'is-switching' : ''}`}>
        {loading && <LoadingView path={renderCurrent.path} />}

        {previewError && <ErrorView path={renderCurrent.path} message={previewError} />}

        {canPreviewImage && (
          <div className="flex min-h-full items-center justify-center">
            <img
              src={renderCurrent.dataUrl}
              alt={renderCurrent.name}
              className="max-h-full max-w-full rounded-xl border border-white/[0.08] object-contain"
            />
          </div>
        )}

        {canPreviewDirectory && (
          <DirectoryView
            entries={renderCurrent.entries ?? []}
            truncated={renderCurrent.entriesTruncated}
            onOpen={openPathPreview}
          />
        )}

        {canPreviewText && (
          <div className="min-h-full">
            {isMarkdown && (
              <div className="mb-2 inline-flex rounded-lg border border-white/[0.08] bg-white/[0.035] p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setMode('rendered')}
                  className={`rounded-md px-2 py-0.5 transition ${
                    mode === 'rendered' ? 'bg-white/[0.1] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  渲染
                </button>
                <button
                  type="button"
                  onClick={() => setMode('source')}
                  className={`rounded-md px-2 py-0.5 transition ${
                    mode === 'source' ? 'bg-white/[0.1] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  源码
                </button>
              </div>
            )}
            {isMarkdown && mode === 'rendered' ? (
              <div className="px-2 py-1">
                <MessageText>{renderCurrent.text ?? ''}</MessageText>
              </div>
            ) : (
              <SourceView attachment={renderCurrent} />
            )}
          </div>
        )}

        {!loading && !previewError && !canPreviewImage && !canPreviewDirectory && !canPreviewText && (
          <div className="flex min-h-full items-center justify-center px-6 text-center text-sm text-zinc-500">
            这个项目没有可预览内容
          </div>
        )}
      </div>
    </aside>
  )
}
