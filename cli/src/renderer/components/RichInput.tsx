import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CompositionEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * 富文本输入框：把 `/命令` 就地渲染成内联胶囊（Codex 那种观感），其余照常是
 * 可编辑文本。
 *
 * ## 关键设计：字符串仍然是唯一真值
 *
 * 这里**没有**文档模型。DOM 里的胶囊只是 `/skill:handoff` 这段字符的一种
 * 画法，序列化时原样还原成那段字符。所以上游的 `text: string`、草稿、排队、
 * Ctrl+S 插队、Swarm 前缀拼接全都不用动——这是把"换地基"降级成"换画法"的
 * 唯一办法，也是我敢做这件事的前提。
 *
 * ## 输入法（这是整件事最大的风险）
 *
 * textarea 之所以从来不出问题，是因为组词全程由浏览器原生处理。contenteditable
 * 一旦在组词期间被 JS 改 DOM，光标会跳、拼音会重复上屏、候选框会错位——而且
 * 这些**没有一行代码能事后补救**。
 *
 * 所以这里立了三条死规矩：
 *   1. `composingRef` 期间**绝不**碰 DOM（不重排、不重新分词、不同步 props）；
 *   2. 只在「值真的和 DOM 不一致」时才重排，正常打字一律不动；
 *   3. 重排后按字符偏移把光标放回去，而不是靠 DOM 节点引用（节点已经换了）。
 *
 * CDP 的合成事件绕过输入法，测不出这些——只能真人打中文验。
 */

export interface RichInputProps {
  value: string
  onChange: (next: string) => void
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void
  onSelectionChange?: (caret: number) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
  /** 命令名 → 显示名。命中的才画成胶囊，其余保持纯文本。 */
  resolveCommand: (name: string) => { label: string } | null
}

/** 只认**行首**的命令：句子中间的 `/` 是路径分隔符，不该被吃掉。 */
const COMMAND_RE = /^\/([^\s/]+)/

/**
 * URL 分词（2026-08-27 用户要求：输入框里的链接要画成消息气泡同款——图标 +
 * 蓝字，但保持普通可编辑文本）。字符类排除空白、引号、尖括和中英文成对括号/
 * 句读（它们永远属于句子不属于链接）；ASCII 句读尾巴（.,;:!?)）在分词后修剪，
 * 因为它们也可能合法出现在 URL 中间，不能进排除类。已知局限：不以这些标点
 * 结尾的怪 URL 照单全收；以 `)` 合法结尾的 URL（维基百科式）会被吃掉尾巴。
 */
const URL_RE = /https?:\/\/[^\s<>"'（）【】《》「」『』。，、；：？！…]+/g
const URL_TAIL_RE = /[.,;:!?)]+$/

interface Segment {
  kind: 'text' | 'command' | 'link'
  text: string
  label?: string
}

/** 把一段纯文本按 URL 拆成 text/link 段（URL 不含空白，所以 link 段永无换行）。 */
function splitLinks(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0].replace(URL_TAIL_RE, '')
    if (!url) continue
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    out.push({ kind: 'link', text: url })
    last = m.index + url.length
    // 让被剪掉的句读尾巴重新参与扫描（它们不会是 URL 开头，只是别跳过）。
    URL_RE.lastIndex = last
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

export function tokenize(value: string, resolve: RichInputProps['resolveCommand']): Segment[] {
  const m = COMMAND_RE.exec(value)
  if (!m) return splitLinks(value)
  const hit = resolve(m[1] ?? '')
  if (!hit) return splitLinks(value)
  const rest = value.slice(m[0].length)
  const segments: Segment[] = [{ kind: 'command', text: m[0], label: hit.label }]
  // 命令胶囊后面跟的文本照常链接化（行首 URL 走不到这里，天然是 link）。
  if (rest) segments.push(...splitLinks(rest))
  return segments
}

/**
 * DOM → 字符串。胶囊还原成它代表的原始字符（data-raw）。
 *
 * 换行的正字是 <br>，但对块级元素兜底（2026-08-26 用户：「换行每次发出去就
 * 没了」）：浏览器默认 Enter、撤销、execCommand 都可能在根下留下 <div>/<p>，
 * 旧版只当普通元素递归，换行就此丢失。规则：
 *   - 进入 <div>/<p> 时先补一个 '\n'——块边界本身就是一次换行；例外两种：
 *     它前面没有任何内容（根的开头，补了会多出空行），或前一个兄弟已是 <br>
 *     （块本来就会另起一行，再补就叠行）；
 *   - 整块只含一个 <br> 的（浏览器表示空行的标准画法 <div><br></div>）不再
 *     递归，边界的那个 '\n' 已经代表这个空行，再递归会叠出第二个。
 */
function serialize(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) return
    const raw = node.dataset.raw
    if (raw !== undefined) {
      out += raw
      return
    }
    if (node.tagName === 'BR') {
      out += '\n'
      return
    }
    if (node.tagName === 'DIV' || node.tagName === 'P') {
      const atStart = !node.previousSibling && out.length === 0
      const prev = node.previousSibling
      const afterBr = prev instanceof HTMLElement && prev.tagName === 'BR'
      if (!atStart && !afterBr) out += '\n'
      const only = node.childNodes.length === 1 ? node.firstChild : null
      if (only instanceof HTMLElement && only.tagName === 'BR') return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return out
}

/** 当前光标在**字符串**里的偏移（重排后要按它把光标放回去）。 */
function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  const frag = pre.cloneContents()
  const holder = document.createElement('div')
  holder.appendChild(frag)
  return serialize(holder).length
}

/** 把光标放到字符偏移处（胶囊是原子的，落在它内部就贴到它后面）。 */
function placeCaret(root: HTMLElement, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  let remaining = offset
  const range = document.createRange()
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (remaining <= len) {
        range.setStart(node, remaining)
        return true
      }
      remaining -= len
      return false
    }
    if (!(node instanceof HTMLElement)) return false
    const raw = node.dataset.raw
    if (raw !== undefined) {
      if (remaining <= raw.length) {
        range.setStartAfter(node)
        return true
      }
      remaining -= raw.length
      return false
    }
    if (node.tagName === 'BR') {
      if (remaining <= 1) {
        range.setStartAfter(node)
        return true
      }
      remaining -= 1
      return false
    }
    for (const child of Array.from(node.childNodes)) if (walk(child)) return true
    return false
  }
  const ok = walk(root)
  if (!ok) range.selectNodeContents(root)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * 胶囊悬停气泡。原生 title= 全 app 禁用（2026-08-25 用户嫌丑，统一走 HoverTip），
 * 但这里的胶囊是 render() 手写出来的命令式 DOM、包不进 React 组件——于是按
 * HoverTip 的同一套视觉与定位规则（深色玻璃、默认上方、贴顶 72px 翻下、
 * ~120ms 淡入、滚动即收）手写一个等价气泡。模块级单例：同时只有一个输入框。
 */
let chipTipEl: HTMLDivElement | null = null

function hideChipTip(): void {
  chipTipEl?.remove()
  chipTipEl = null
  window.removeEventListener('scroll', hideChipTip, true)
}

function showChipTip(chip: HTMLElement, text: string): void {
  hideChipTip()
  const rect = chip.getBoundingClientRect()
  const below = rect.top < 72
  // max-w-md = 448px，左边往屏内 clamp 一档防出屏（同 HoverTip）。
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 456))
  const tip = document.createElement('div')
  tip.className =
    'pointer-events-none fixed z-[100] max-w-md whitespace-normal rounded-lg border border-white/10 ' +
    'bg-zinc-900/95 px-2.5 py-1.5 text-left text-xs text-zinc-300 shadow-xl backdrop-blur ' +
    `transition duration-[120ms] ease-out opacity-0 ${below ? '-translate-y-1' : 'translate-y-1'}`
  tip.textContent = text
  tip.style.left = `${left}px`
  if (below) tip.style.top = `${rect.bottom + 6}px`
  else tip.style.bottom = `${window.innerHeight - rect.top + 6}px`
  document.body.appendChild(tip)
  chipTipEl = tip
  // 挂载后下一帧再转正透明度/位移，做出 ~120ms 淡入（同 HoverTip）。
  requestAnimationFrame(() => {
    if (chipTipEl !== tip) return
    tip.classList.remove('opacity-0', '-translate-y-1', 'translate-y-1')
    tip.classList.add('translate-y-0', 'opacity-100')
  })
  window.addEventListener('scroll', hideChipTip, true)
}

function render(root: HTMLElement, segments: Segment[]): void {
  // 重排会 replaceChildren 把胶囊换掉，悬停中的气泡先收掉，免得残留在屏上。
  hideChipTip()
  root.replaceChildren()
  for (const seg of segments) {
    if (seg.kind === 'command') {
      const chip = document.createElement('span')
      chip.dataset.raw = seg.text
      chip.contentEditable = 'false'
      chip.className = 'rich-input-chip'
      chip.addEventListener('mouseenter', () => showChipTip(chip, seg.text))
      chip.addEventListener('mouseleave', hideChipTip)
      // Codex 式：小立方体图标 + 蓝色文字，裸排版无胶囊底框。
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('fill', 'none')
      icon.setAttribute('class', 'rich-input-chip-icon')
      for (const d of ['M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z', 'M4 7.5 12 12l8-4.5', 'M12 12v9']) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        p.setAttribute('d', d)
        p.setAttribute('stroke', 'currentColor')
        p.setAttribute('stroke-width', '1.7')
        p.setAttribute('stroke-linejoin', 'round')
        icon.appendChild(p)
      }
      chip.appendChild(icon)
      chip.appendChild(document.createTextNode(seg.label ?? seg.text))
      root.appendChild(chip)
      continue
    }
    if (seg.kind === 'link') {
      // URL 是普通可编辑文本，只套一个着色 span（图标由 CSS ::before 画，
      // 不占 DOM 节点，光标进出自如）。不加 data-raw：textContent 即原文，
      // serialize 的文本节点遍历天然还原。
      const link = document.createElement('span')
      link.className = 'rich-input-link'
      link.appendChild(document.createTextNode(seg.text))
      root.appendChild(link)
      continue
    }
    // 换行拆成文本 + <br>：contenteditable 里直接塞 \n 不会换行。
    const parts = seg.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) root.appendChild(document.createElement('br'))
      if (part) root.appendChild(document.createTextNode(part))
    })
  }
}

export default function RichInput({
  value,
  onChange,
  onKeyDown,
  onPaste,
  onSelectionChange,
  placeholder,
  className,
  ariaLabel,
  resolveCommand
}: RichInputProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  /**
   * 组词中（用 state 而不是只用 ref：占位符要靠它立刻消失）。
   *
   * 组词期间我们**故意不回写 value**（回写→重排→打断组词），于是 React 眼里
   * 输入框一直是空的，占位符不肯走；而占位符是 ::before 伪元素、占行内空间，
   * 正在组的拼音就被挤到它后面去了（实测：「给 Tran 发消息…ce'ui」）。
   *
   * 这里只改根节点上的一个属性，不碰任何子节点、不动选区，对输入法是安全的。
   */
  const [composing, setComposing] = useState(false)
  /** 最近一次由本组件写出去的值：用来判断 props 是不是"我们自己刚发出去的回声"。 */
  const lastEmittedRef = useRef<string>('')

  // 值变化时才重排 DOM；组词期间一律不碰（第 1 条死规矩）。
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    if (composingRef.current) return
    const segments = tokenize(value, resolveCommand)
    // 手敲即时胶囊化（2026-08-14 用户要求对齐 Codex）：值与 DOM 一致不代表
    // 结构一致——逐字敲出 '/handoff' 时值一路等于 DOM（都是自己刚发的回声），
    // 旧逻辑不重排，胶囊只有菜单选中/草稿恢复才出现。这里比对「行首命令是否
    // 已解析」与「首节点是否已是胶囊」，不一致就重排。重排只在命令命中/失效
    // 的翻转瞬间发生一次，正常逐字打字不受影响。
    const wantChip = segments[0]?.kind === 'command'
    const hasChip = root.firstElementChild?.classList.contains('rich-input-chip') ?? false
    // 链接化沿用同一「翻转才重排」模式（2026-08-27）：只比对 link 段的**个数**，
    // 不比对文本——在已有链接 span 里继续敲字符，链接个数不变，值又等于 DOM
    // （自己的回声），于是逐字打字绝不重排；只有「某处新长成/拆散了一个 URL」
    // （个数翻转）才重排一次完成图标化。
    // 2026-09-01 修「粘贴网址后再打字全变蓝」：光标停在链接 span 尾部时浏览器
    // 把新字符敲进 span 里，个数不变、serialize 又等于值（回声），永不重排，
    // 非 URL 文字就这么赖在蓝色 span 里。比对升级为 link 段的**文本**（个数是
    // 文本相等的子集）：敲进去的字符一旦不属于 URL（空格后的中文等），文本
    // 失配触发一次重排把它拆出去；继续敲 URL 字符则文本同步增长，不重排。
    const wantLinkText = segments
      .filter((s) => s.kind === 'link')
      .map((s) => s.text)
      .join(' ')
    const hasLinkText = [...root.querySelectorAll('.rich-input-link')].map((el) => el.textContent ?? '').join(' ')
    if (serialize(root) === value && wantChip === hasChip && wantLinkText === hasLinkText) return
    const caret = caretOffset(root)
    render(root, segments)
    if (document.activeElement === root) {
      // 外部改值（菜单选中命令/发送后清空/草稿恢复）：光标落**末尾**——停在
      // 旧偏移会把刚选中的命令重新识别成「正在输入 /xxx」，斜杠菜单关了又开，
      // 下一次回车被菜单吃掉、消息发不出去（2026-08-18 用户：「选中完还要再
      // 打下空格才行」）。只有自己打字的回声才按旧偏移放回去。
      const external = lastEmittedRef.current !== value
      const offset = external ? value.length : Math.min(caret ?? value.length, value.length)
      placeCaret(root, offset)
    }
  }, [value, resolveCommand])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    const onSel = (): void => {
      if (document.activeElement !== root) return
      const c = caretOffset(root)
      if (c !== null) onSelectionChange?.(c)
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [onSelectionChange])

  // 卸载时收掉可能还挂着的气泡（气泡挂在 body 上，不随组件树清理）。
  useEffect(() => hideChipTip, [])

  const emit = (): void => {
    const root = ref.current
    if (!root) return
    const next = serialize(root)
    lastEmittedRef.current = next
    onChange(next)
  }

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      // contenteditable 空的时候浏览器常留一个 <br>，`:empty` 选择器就失效了，
      // 占位符要么不显示、要么该消失时不消失。用值本身判断，别信 :empty。
      data-empty={value.length === 0 && !composing ? 'true' : undefined}
      className={className}
      onInput={() => {
        // 组词中间的每一帧都会触发 input，但此时**不能**回写 props（回写会
        // 触发重排，重排会打断组词）。等 compositionend 再统一发。
        if (composingRef.current) return
        emit()
      }}
      onCompositionStart={() => {
        composingRef.current = true
        setComposing(true)
      }}
      onCompositionEnd={(_e: CompositionEvent<HTMLDivElement>) => {
        composingRef.current = false
        setComposing(false)
        emit()
      }}
      onKeyDown={(event) => {
        // 组词期间的 Enter / 上下键属于输入法（选字、翻页），一律放行。
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        // Shift+Enter 手动插 <br>（2026-08-26 用户：「换行每次发出去就没了」）：
        // 浏览器默认行为是在 contenteditable 里拆 <div> 块，而 serialize 的换行
        // 正字是 <br>，换行在 emit 时就丢了。拦住默认行为、只插 <br>，保住
        // 「换行只有 <br> 一种画法」的不变量（render 写 '\n' 也是 <br>）。
        // Composer 本来就忽略 Shift+Enter，所以不再向上转发。
        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault()
          const root = ref.current
          const sel = window.getSelection()
          if (root && sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0)
            if (root.contains(range.startContainer)) {
              range.deleteContents()
              const br = document.createElement('br')
              range.insertNode(br)
              range.setStartAfter(br)
              range.collapse(true)
              sel.removeAllRanges()
              sel.addRange(range)
            }
          }
          emit()
          return
        }
        onKeyDown?.(event)
      }}
      onPaste={(event) => {
        if (onPaste) {
          onPaste(event)
          if (event.defaultPrevented) return
        }
        // 只收纯文本：contenteditable 默认会把 Word/网页的整段 HTML 塞进来。
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        if (text) document.execCommand('insertText', false, text)
      }}
    />
  )
}
