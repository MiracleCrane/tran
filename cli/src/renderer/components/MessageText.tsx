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
import { showInlineContextMenu } from './InlineContextMenu'
import HoverTip from './HoverTip'
import { LinkIcon } from './LinkIcon'

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
      // 原生 title 换成 HoverTip（2026-08-26：右键菜单上线，提示里补「右键复制」；
      // 原生 title 样式丑，用户此前已嫌过原生悬停提示）。
      <HoverTip tip={`预览 ${path}；Ctrl+点击在资源管理器中显示；右键复制路径`} tipClassName="break-all">
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
          onContextMenu={(event) => {
            // 整颗 pill 是 button，选不中文字；右键给复制入口（2026-08-26 用户：
            // 「让我没办法复制这个链接里面的文字」）。复制的是用户看到的原始文本
            // （含 :line 行号），不是 preview 用的归一化路径。
            const cwd = useSessionStore.getState().meta?.cwd ?? ''
            showInlineContextMenu(event, [
              { label: '复制路径', action: () => void navigator.clipboard.writeText(text).catch(() => {}) },
              {
                label: '预览',
                action: () => openPathPreview(cwd, path, useUiStore.getState().openAttachmentPreview)
              },
              {
                label: '在资源管理器中显示',
                action: () => void window.api.revealInExplorer(cwd, path)
              }
            ])
          }}
          className="mx-0.5 inline rounded bg-white/[0.07] px-1 font-mono text-[0.85em] text-zinc-200 transition hover:bg-white/[0.14] hover:underline"
        >
          {text}
        </button>
      </HoverTip>
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

  const external = isExternalHref(href)
  // 裸 URL（文本即链接本身，GFM autolink 的产物）：显示成「图标 + 短文本」——
  // 去协议头、超 56 字符中间省略，完整 URL 留在悬停提示（2026-08-17 用户：
  // 「链接为什么不是图标+展示文字的形式」）。markdown 自带文字的链接不动。
  // 注意 href 可能已 URL 编码（全角括号等），判定前 decode 一份对照。
  const hrefNorm = external ? normalizeExternalHref(href) : href
  let hrefDecoded = hrefNorm
  try {
    hrefDecoded = decodeURIComponent(hrefNorm)
  } catch { /* 非法编码就保留原样 */ }
  const bare =
    external &&
    typeof children === 'string' &&
    [hrefNorm, hrefDecoded, hrefNorm.replace(/^https?:\/\//, ''), hrefDecoded.replace(/^https?:\/\//, '')].includes(
      children
    )
  // GFM autolink 会把紧跟的全角标点吞进链接（「…v1.1.18（exe」），既难看、点开
  // 还是 404：裸链接在首个全角括号处截断，标点起回到正文。
  let linkTarget = href
  let trailing: string | null = null
  if (bare) {
    linkTarget = children as string
    const m = linkTarget.match(/[（）【】《》「」『』]/)
    if (m && m.index !== undefined && m.index > 0) {
      trailing = linkTarget.slice(m.index)
      linkTarget = linkTarget.slice(0, m.index)
    }
  }

  // 同 CodeRenderer：store 状态点击时现取，不做渲染期订阅。
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!linkTarget || event.defaultPrevented || event.button !== 0) return

    event.preventDefault()

    if (linkTarget.startsWith('#')) return
    if (isExternalHref(linkTarget)) {
      window.open(normalizeExternalHref(linkTarget), '_blank', 'noopener,noreferrer')
      return
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(linkTarget) && !linkTarget.toLowerCase().startsWith('file:')) return

    const path = hrefToPreviewPath(linkTarget)
    if (!path) return
    const cwd = useSessionStore.getState().meta?.cwd ?? ''
    if (event.ctrlKey) {
      void window.api.revealInExplorer(cwd, path)
      return
    }
    openPathPreview(cwd, path, useUiStore.getState().openAttachmentPreview)
  }

  /** 外链使用主题安全的站点图标；请求失败时仍保留清晰的本地图标。 */
  return (
    <>
      <a
        {...props}
        href={linkTarget}
        onClick={handleClick}
        onContextMenu={(event) => {
          // 外链右键菜单（2026-08-26 用户：链接整段可点，「没办法复制这个链接里面
          // 的文字」）。只挂外链；file/路径类链接左键是预览，右键行为需求未提，不动。
          if (!external || !linkTarget) return
          const fullHref = normalizeExternalHref(linkTarget)
          showInlineContextMenu(event, [
            { label: '复制链接', action: () => void navigator.clipboard.writeText(fullHref).catch(() => {}) },
            {
              label: '打开链接',
              action: () => window.open(fullHref, '_blank', 'noopener,noreferrer')
            }
          ])
        }}
        title={title}
        className="text-[#3d9bff] no-underline transition hover:brightness-125"
      >
        {external && <LinkIcon href={href} />}
        {bare ? shortenUrlForDisplay(linkTarget) : children}
      </a>
      {trailing}
    </>
  )
}

/** 裸 URL 的展示文本：去协议头，超 56 字符中间打省略（保留 host 和尾段）。 */
function shortenUrlForDisplay(text: string): string {
  const bare = text.replace(/^https?:\/\//, '')
  if (bare.length <= 56) return bare
  let host = bare
  let rest = ''
  const slash = bare.indexOf('/')
  if (slash > 0) {
    host = bare.slice(0, slash)
    rest = bare.slice(slash)
  }
  const budget = 56 - host.length - 1
  if (budget < 10) return `${host}…`
  return `${host}${rest.slice(0, Math.ceil(budget / 2))}…${rest.slice(-Math.floor(budget / 2))}`
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
 *  那个成本。按行切开渲染，保留换行结构。外包 prose-forge：加粗等样式都挂在
 *  .prose-forge 选择器下，裸渲染时加粗不可见（用户实测反馈"加粗没了"）。 */
export const InlineMarkdown = memo(function InlineMarkdown({
  children
}: {
  children: string
}): JSX.Element {
  return (
    <div className="prose-forge">
      {children.split('\n').map((line, i) => (
        <InlineLine key={i} line={line} />
      ))}
    </div>
  )
})
