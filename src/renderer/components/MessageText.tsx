import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useSessionStore } from '../store/sessionStore'

/** Heuristic: does this inline-code span look like a file path? (has a
 *  separator or a trailing extension) — used to make it click-to-reveal. */
function isPathLike(s: string): boolean {
  if (!s || s.length > 260) return false
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,12}$/.test(s)
}

export default function MessageText({ children }: { children: string }): JSX.Element {
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')

  // Custom inline-code renderer: path-like spans become click-to-reveal buttons
  // (open the file's folder in the OS file manager). Fenced/code-block stays put.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = ({ className, children: c }: any): JSX.Element => {
    const text = String(c ?? '')
    const isBlock = !!className && /language-|hljs/.test(className)
    if (!isBlock && isPathLike(text)) {
      return (
        <button
          type="button"
          onClick={() => void window.api.revealInExplorer(cwd, text)}
          className="mx-0.5 inline rounded bg-white/[0.07] px-1 font-mono text-[0.85em] text-accent transition hover:bg-white/[0.14] hover:underline"
          title={`在资源管理器中显示:${text}`}
        >
          {text}
        </button>
      )
    }
    return <code className={className}>{c}</code>
  }

  return (
    <div className="prose-forge text-zinc-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{ code }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
