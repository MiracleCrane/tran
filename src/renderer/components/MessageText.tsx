import { memo } from 'react'
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
          void window.api.readFiles(cwd, [path]).then((files) => {
            openAttachmentPreview(files[0] ? pickedFileToUserAttachment(files[0]) : fallbackPathAttachment(path))
          })
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

const MD_COMPONENTS = { code: CodeRenderer }
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
