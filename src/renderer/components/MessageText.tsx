import { memo, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { UserAttachment } from '../types'
import { pickedFileToUserAttachment } from '../utils/attachments'

function isPathLike(s: string): boolean {
  if (!s || s.length > 260) return false
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,12}$/.test(s)
}

function normalizePathForPreview(text: string): string {
  const trimmed = text.trim()
  const lineRef = trimmed.match(/^(.+\.[A-Za-z0-9]{1,12})(?::\d+){1,2}$/)
  return lineRef?.[1] ?? trimmed
}

function fallbackPathAttachment(path: string): UserAttachment {
  return {
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    kind: 'other',
    path
  }
}

function stripHrefDecorations(href: string): string {
  return href.trim().replace(/[?#].*$/, '')
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href) || href.startsWith('//')
}

function normalizeExternalHref(href: string): string {
  return href.startsWith('//') ? `https:${href}` : href
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function fileUrlToPath(href: string): string {
  try {
    const url = new URL(href)
    const decoded = safeDecodeURIComponent(url.pathname)
    return decoded.replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return href
  }
}

function hrefToPreviewPath(href: string): string {
  const raw = stripHrefDecorations(href)
  const decoded = raw.toLowerCase().startsWith('file:') ? fileUrlToPath(raw) : safeDecodeURIComponent(raw)
  const projectRelative = decoded.replace(/^\.\/+/, '').replace(/^\/+(?![A-Za-z]:)/, '')
  return normalizePathForPreview(projectRelative)
}

function openPathPreview(
  cwd: string,
  path: string,
  openAttachmentPreview: (attachment: UserAttachment) => void
): void {
  void window.api.readFiles(cwd, [path]).then((files) => {
    openAttachmentPreview(files[0] ? pickedFileToUserAttachment(files[0]) : fallbackPathAttachment(path))
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CodeRenderer({ className, children: c }: any): JSX.Element {
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const openAttachmentPreview = useUiStore((s) => s.openAttachmentPreview)
  const text = String(c ?? '')
  const isBlock = !!className && /language-|hljs/.test(className)

  if (!isBlock && isPathLike(text)) {
    const path = normalizePathForPreview(text)
    return (
      <button
        type="button"
        onClick={(event) => {
          if (event.ctrlKey) {
            void window.api.revealInExplorer(cwd, path)
            return
          }
          openPathPreview(cwd, path, openAttachmentPreview)
        }}
        className="mx-0.5 inline rounded bg-white/[0.07] px-1 font-mono text-[0.85em] text-accent transition hover:bg-white/[0.14] hover:underline"
        title={`预览 ${path}；Ctrl+点击在资源管理器中显示`}
      >
        {text}
      </button>
    )
  }

  return <code className={className}>{c}</code>
}

type LinkRendererProps = AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }

function LinkRenderer({
  href = '',
  children,
  node: _node,
  ...props
}: LinkRendererProps): JSX.Element {
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const openAttachmentPreview = useUiStore((s) => s.openAttachmentPreview)
  const title = typeof href === 'string' && href ? href : undefined

  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!href || event.defaultPrevented || event.button !== 0) return

    event.preventDefault()

    if (href.startsWith('#')) return
    if (isExternalHref(href)) {
      window.open(normalizeExternalHref(href), '_blank', 'noopener,noreferrer')
      return
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) && !href.toLowerCase().startsWith('file:')) return

    const path = hrefToPreviewPath(href)
    if (!path) return
    if (event.ctrlKey) {
      void window.api.revealInExplorer(cwd, path)
      return
    }
    openPathPreview(cwd, path, openAttachmentPreview)
  }

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      title={title}
      className="text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
    >
      {children}
    </a>
  )
}

const MD_COMPONENTS = { code: CodeRenderer, a: LinkRenderer }
const MD_PLAIN = { remarkPlugins: [remarkGfm], components: MD_COMPONENTS }
const MD_HIGHLIGHTED = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypeHighlight],
  components: MD_COMPONENTS
}

function MessageTextImpl({
  children,
  highlight = true
}: {
  children: string
  highlight?: boolean
}): JSX.Element {
  const md = highlight ? MD_HIGHLIGHTED : MD_PLAIN
  return (
    <div className="prose-forge text-zinc-200">
      <ReactMarkdown {...md}>{children}</ReactMarkdown>
    </div>
  )
}

const MessageText = memo(MessageTextImpl)
export default MessageText
