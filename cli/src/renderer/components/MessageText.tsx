import { memo, useEffect, useRef, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes, type MouseEvent } from 'react'
import { useTransientFlag } from '../hooks/useTransientFlag'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { UserAttachment } from '../types'
import { pathToUserAttachment, pickedFileToUserAttachment } from '../utils/attachments'
import { showImageContextMenu } from './ImageContextMenu'

function isPathLike(s: string): boolean {
  if (!s || s.length > 260) return false
  return /[/\\]/.test(s) || /\.[A-Za-z0-9]{1,12}$/.test(s)
}

function normalizePathForPreview(text: string): string {
  const trimmed = text.trim()
  const lineRef = trimmed.match(/^(.+\.[A-Za-z0-9]{1,12})(?::\d+){1,2}$/)
  return lineRef?.[1] ?? trimmed
}

const PREVIEW_READ_ERROR = '文件或目录不存在，或无法读取。'

function loadingPathAttachment(path: string): UserAttachment {
  return pathToUserAttachment(path, { previewState: 'loading' })
}

function errorPathAttachment(path: string, error = PREVIEW_READ_ERROR): UserAttachment {
  return pathToUserAttachment(path, { previewState: 'error', previewError: error })
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
  openAttachmentPreview(loadingPathAttachment(path))
  void window.api.readFiles(cwd, [path]).then((files) => {
    const current = useUiStore.getState().attachmentPreview
    if (current?.path !== path) return
    openAttachmentPreview(files[0] ? pickedFileToUserAttachment(files[0]) : errorPathAttachment(path))
  }).catch((error: unknown) => {
    const current = useUiStore.getState().attachmentPreview
    if (current?.path !== path) return
    const message = error instanceof Error ? error.message : PREVIEW_READ_ERROR
    openAttachmentPreview(errorPathAttachment(path, message || PREVIEW_READ_ERROR))
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CodeRenderer({ className, children: c }: any): JSX.Element {
  // cwd/openAttachmentPreview 在点击时经 getState() 现取，不做渲染期订阅：
  // 长会话里成百上千个行内 code span，每个都挂 selector 的话，流式期间每帧
  // store 更新都要跑一遍全部订阅者。
  const text = String(c ?? '')
  const isBlock = !!className && /language-|hljs/.test(className)

  if (!isBlock && isPathLike(text)) {
    const path = normalizePathForPreview(text)
    return (
      <button
        type="button"
        onClick={(event) => {
          const cwd = useSessionStore.getState().meta?.cwd ?? ''
          if (event.ctrlKey) {
            void window.api.revealInExplorer(cwd, path)
            return
          }
          openPathPreview(cwd, path, useUiStore.getState().openAttachmentPreview)
        }}
        className="mx-0.5 inline rounded bg-white/[0.07] px-1 font-mono text-[0.85em] text-zinc-200 transition hover:bg-white/[0.14] hover:underline"
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
  const title = typeof href === 'string' && href ? href : undefined

  // 同 CodeRenderer：store 状态点击时现取，不做渲染期订阅。
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
    const cwd = useSessionStore.getState().meta?.cwd ?? ''
    if (event.ctrlKey) {
      void window.api.revealInExplorer(cwd, path)
      return
    }
    openPathPreview(cwd, path, useUiStore.getState().openAttachmentPreview)
  }

  /** 网站图标：直连站点 /favicon.ico（Codex 用的是 google s2/favicons，但那域名
   *  在国内不通）。加载失败回退为通用外跳小图标——图标只是点缀，绝不能裂图。 */
  const external = isExternalHref(href)
  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      title={title}
      className="text-[#3d9bff] no-underline transition hover:brightness-125"
    >
      {external && <LinkFavicon href={href} />}
      {children}
    </a>
  )
}

/** 站点图标：img 加载失败回退成通用外跳小箭头（裂图比没图标难看）。 */
function LinkFavicon({ href }: { href: string }): JSX.Element | null {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        className="mr-0.5 inline-block align-[-0.1em]"
        aria-hidden
      >
        <path
          d="M9 4h11v11h-2.2V7.6L6 19.4 4.6 18 16.4 6.2H9V4Z"
          fill="currentColor"
        />
      </svg>
    )
  }
  let origin = ''
  try {
    origin = new URL(normalizeExternalHref(href)).origin
  } catch {
    return null
  }
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="mr-0.5 inline-block h-[0.95em] w-[0.95em] rounded-[2px] align-[-0.1em]"
    />
  )
}

type ImgRendererProps = ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }

/** AI 输出的 markdown 图片（#22）：右键弹"复制图片 / 另存为…"菜单。 */
function ImgRenderer({ src, alt, node: _node, ...props }: ImgRendererProps): JSX.Element {
  const source = typeof src === 'string' ? src : ''
  const name = typeof alt === 'string' && alt ? alt : undefined
  return (
    <img
      {...props}
      src={src}
      alt={alt ?? ''}
      onContextMenu={(event) => showImageContextMenu(event, source, name)}
    />
  )
}

/** 代码块外框（2026-08，用户要求"能轻易复制、有框框好区分"）：
 *  语言标签在左、复制按钮在右，下面才是代码本体。复制从渲染后的 DOM 读
 *  textContent——highlight 之后 children 是一串 span，从 props 抠文本不可靠。 */
function PreRenderer({ children, ...props }: any): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // useTransientFlag 管定时器的取消与卸载清理：裸 setTimeout 在 1.2s 内组件
  // 卸载（流式重排/切会话）时会打在已卸载组件上，连点还互相踩。
  const [copied, flashCopied] = useTransientFlag(1200)
  const codeProps = (Array.isArray(children) ? children[0] : children)?.props ?? {}
  const lang = /language-([\w-]+)/.exec(codeProps.className ?? '')?.[1] ?? 'text'

  const copy = async (): Promise<void> => {
    const text = ref.current?.querySelector('code')?.textContent ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      flashCopied()
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return (
    <div ref={ref} className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button type="button" onClick={() => void copy()} className="md-code-copy">
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  )
}

const MD_COMPONENTS = { code: CodeRenderer, a: LinkRenderer, img: ImgRenderer, pre: PreRenderer }
/** #26：react-markdown 默认 urlTransform 白名单只有 https?/ircs?/mailto/xmpp，
 *  data: URI 被清空成 src=""。只放行 data:image/（图片 data URL），其余仍走默认过滤。 */
function urlTransformAllowDataImage(url: string): string {
  return /^data:image\//i.test(url) ? url : defaultUrlTransform(url)
}

/**
 * CJK 加粗兜底（2026-08 用户反馈「**」原样漏出）。
 *
 * micromark 严格执行 CommonMark 侧翼规则：`**` 左侧是中文字、右侧是中文标点
 * （如「是**「协作奖励计划」**，」）时，opening run 既不是 left- 也不是
 * right-flanking，整段按纯文本输出。中英混排的中文对话里这是常态。
 * 这里在 remark 阶段补一刀：text 节点里残留的 `**内容**` 手动切成 strong。
 * 只碰 text 节点——代码 span、链接内部等早已是别的节点类型，不受影响。
 */
interface MdastTextNode {
  type: string
  value?: string
  children?: MdastTextNode[]
}

function splitCjkStrong(value: string): MdastTextNode[] | null {
  if (!value.includes('**')) return null
  const re = /\*\*([^*]+)\*\*/g
  const out: MdastTextNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let hit = false
  while ((match = re.exec(value)) !== null) {
    hit = true
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) })
    out.push({ type: 'strong', children: [{ type: 'text', value: match[1] }] })
    last = match.index + match[0].length
  }
  if (!hit) return null
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function remarkCjkStrong(): (tree: MdastTextNode) => void {
  return (tree) => {
    const walk = (node: MdastTextNode): void => {
      if (!node.children) return
      const next: MdastTextNode[] = []
      let changed = false
      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          const parts = splitCjkStrong(child.value)
          if (parts) {
            next.push(...parts)
            changed = true
            continue
          }
        }
        walk(child)
        next.push(child)
      }
      if (changed) node.children = next
    }
    walk(tree)
  }
}

const MD_PLAIN = { remarkPlugins: [remarkGfm, remarkCjkStrong], urlTransform: urlTransformAllowDataImage, components: MD_COMPONENTS }
const MD_HIGHLIGHTED = {
  remarkPlugins: [remarkGfm, remarkCjkStrong],
  rehypePlugins: [rehypeHighlight],
  urlTransform: urlTransformAllowDataImage,
  components: MD_COMPONENTS
}

function MessageTextImpl({
  children,
  highlight = true
}: {
  children: string
  highlight?: boolean
}): JSX.Element {
  const [highlightLocked, setHighlightLocked] = useState(highlight)

  useEffect(() => {
    if (highlight) setHighlightLocked(true)
  }, [highlight])

  const md = highlight || highlightLocked ? MD_HIGHLIGHTED : MD_PLAIN
  return (
    <div className="prose-forge text-zinc-200">
      <ReactMarkdown {...md}>{children}</ReactMarkdown>
    </div>
  )
}

const MessageText = memo(MessageTextImpl)
export default MessageText

/** 单行渲染抽成 memo 组件：流式期间父级每帧重渲染，但只有最后一行在变——
 *  其余行 memo 命中，跳过整条 unified/remark 管线（否则 200 行思考块 ×
 *  每帧全量重解析，是流式卡顿的主要来源之一）。 */
const InlineLine = memo(function InlineLine({ line }: { line: string }): JSX.Element {
  return (
    <div>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkStrong]}
        allowedElements={['strong', 'em', 'code', 'a', 'del']}
        unwrapDisallowed
        urlTransform={urlTransformAllowDataImage}
        components={MD_COMPONENTS}
      >
        {line || ' '}
      </ReactMarkdown>
    </div>
  )
})

/** 轻量行内 markdown（2026-08，思考块/译文用）：只渲染 加粗/斜体/行内代码/
 *  链接/删除线，不做段落级排版——思考是写给自己的推理，full markdown 不值
 *  那个成本。按行切开渲染，保留换行结构。 */
export const InlineMarkdown = memo(function InlineMarkdown({
  children
}: {
  children: string
}): JSX.Element {
  return (
    <>
      {children.split('\n').map((line, i) => (
        <InlineLine key={i} line={line} />
      ))}
    </>
  )
})
