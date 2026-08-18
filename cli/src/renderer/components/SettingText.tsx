import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-medium text-zinc-300">{children}</strong>,
  em: ({ children }) => <em className="text-zinc-400">{children}</em>,
  code: ({ children, className }) => {
    const block = typeof className === 'string' && className.startsWith('language-')
    return block ? (
      <code className="font-mono text-[10.5px] text-zinc-300">{children}</code>
    ) : (
      <code className="rounded bg-bg-elev px-1 py-px font-mono text-[10.5px] text-zinc-300">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-white/10 pl-2.5 text-zinc-400">{children}</blockquote>
  ),
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-xs font-semibold text-zinc-300">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2 text-xs font-semibold text-zinc-300">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-[11px] font-semibold text-zinc-300">{children}</h3>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sky-400/90 underline decoration-sky-400/30 underline-offset-2 hover:text-sky-300"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/[0.06]">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-white/[0.08] bg-white/[0.03] px-2 py-1 font-medium text-zinc-300">{children}</th>,
  td: ({ children }) => <td className="border-b border-white/[0.05] px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="my-2 border-white/[0.07]" />
}

/** 设置说明统一使用的受限 Markdown renderer；不启用原始 HTML。 */
export default function SettingText({
  children,
  className = ''
}: {
  children: string
  className?: string
}): JSX.Element {
  return (
    <div className={`setting-markdown text-[11px] leading-relaxed text-zinc-500 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        urlTransform={defaultUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
