import { Fragment, memo, useMemo, useState } from 'react'
import CodeBlock, { highlightLines } from './CodeBlock'

type Mode = 'unified' | 'split'

/** 行内差异的一段：changed 的片段加深底色。 */
interface Seg {
  text: string
  changed: boolean
}

interface Row {
  /** null = 空占位（对齐用） */
  left: string | null
  right: string | null
  /** hunk 头（@@）整行渲染 */
  hunk?: string
  /** 行号（缺省表示该侧无此行） */
  leftNo?: number
  rightNo?: number
  /** 行内差异（仅在 left/right 成对且相似时计算） */
  leftSegs?: Seg[]
  rightSegs?: Seg[]
}

/** 把一行切成词/符号 token —— 按空白与标识符边界切，比逐字符更贴合阅读。 */
function tokenize(line: string): string[] {
  return line.match(/(\s+|[A-Za-z0-9_$]+|.)/g) ?? []
}

/** 经典 LCS 表（token 级）。行长做了上限保护，超长行退化为整行标记。 */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** 行内 diff：返回两侧的分段。相同片段 changed=false，改动片段 changed=true。 */
const MAX_INLINE_TOKENS = 400

function inlineDiff(left: string, right: string): { left: Seg[]; right: Seg[] } | null {
  const a = tokenize(left)
  const b = tokenize(right)
  // 超长行算 LCS 代价是 O(n·m)，直接放弃行内标注（整行仍有底色）。
  if (a.length > MAX_INLINE_TOKENS || b.length > MAX_INLINE_TOKENS) return null

  const table = lcsTable(a, b)
  const leftSegs: Seg[] = []
  const rightSegs: Seg[] = []
  const push = (segs: Seg[], text: string, changed: boolean): void => {
    const last = segs[segs.length - 1]
    if (last && last.changed === changed) last.text += text
    else segs.push({ text, changed })
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(leftSegs, a[i], false)
      push(rightSegs, b[j], false)
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push(leftSegs, a[i], true)
      i++
    } else {
      push(rightSegs, b[j], true)
      j++
    }
  }
  while (i < a.length) push(leftSegs, a[i++], true)
  while (j < b.length) push(rightSegs, b[j++], true)
  return { left: leftSegs, right: rightSegs }
}

/** 两行的相似度（0~1），用于决定删除行与新增行是否该配成一对。
 *  接收预先 tokenize 好的结果，避免在 O(dels×adds) 的配对循环里反复分词。 */
function similarityTok(a: string, ta: string[], b: string, tb: string[]): number {
  if (a === b) return 1
  if (!a.trim() || !b.trim()) return 0
  if (ta.length > MAX_INLINE_TOKENS || tb.length > MAX_INLINE_TOKENS) return 0
  const common = lcsTable(ta, tb)[0][0]
  return (2 * common) / (ta.length + tb.length)
}

/** 贪心配对的规模上限：删除块×新增块超过它（整文件重写级别的 diff）时，
 *  逐对算 LCS 会把主线程冻住，退化为按下标硬配对。 */
const MAX_PAIRING_CELLS = 2500

/** 低于此相似度就不配对——宁可分别显示为「纯删除」「纯新增」，也不要把两行
 *  毫不相干的代码摆在一起假装是「改动前后」。 */
const PAIR_THRESHOLD = 0.35

function parseHunkStarts(header: string): { left: number; right: number } | null {
  const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(header)
  if (!m) return null
  return { left: Number(m[1]), right: Number(m[2]) }
}

/**
 * 把 diff 文本切成行（拆分视图用）。
 *
 * 与旧实现的区别：删除块与新增块不再按下标硬配对（那是注释里写明的
 * `no LCS — a simple heuristic`，稍复杂的改动就会把不相干的两行摆成一对），
 * 改为按相似度贪心匹配，并给配上对的行算行内差异。
 */
function toRows(lines: string[]): Row[] {
  const rows: Row[] = []
  const isFileHdr = (l: string): boolean => l.startsWith('+++') || l.startsWith('---')
  let leftNo = 0
  let rightNo = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('@@')) {
      const starts = parseHunkStarts(line)
      if (starts) {
        leftNo = starts.left
        rightNo = starts.right
      }
      rows.push({ left: null, right: null, hunk: line })
      i++
      continue
    }
    if (isFileHdr(line)) {
      i++
      continue
    }
    if (line.startsWith('-')) {
      const dels: string[] = []
      while (i < lines.length && lines[i].startsWith('-') && !isFileHdr(lines[i])) {
        dels.push(lines[i].slice(1))
        i++
      }
      const adds: string[] = []
      while (i < lines.length && lines[i].startsWith('+') && !isFileHdr(lines[i])) {
        adds.push(lines[i].slice(1))
        i++
      }
      const usedAdds = new Set<number>()
      const pairFor = new Map<number, number>()
      const oversized = dels.length * adds.length > MAX_PAIRING_CELLS
      if (oversized) {
        // 超大改动块：贪心配对每对都要建 LCS 表，代价不可接受，按下标硬配对。
        const n = Math.min(dels.length, adds.length)
        for (let d = 0; d < n; d++) {
          usedAdds.add(d)
          pairFor.set(d, d)
        }
      } else {
        // 贪心配对：每个删除行找剩余新增行里最像的一个，够相似才配。
        // tokenize 结果在循环外缓存，避免同一行被反复分词。
        const delToks = dels.map(tokenize)
        const addToks = adds.map(tokenize)
        for (let d = 0; d < dels.length; d++) {
          let best = -1
          let bestScore = PAIR_THRESHOLD
          for (let k = 0; k < adds.length; k++) {
            if (usedAdds.has(k)) continue
            const score = similarityTok(dels[d], delToks[d], adds[k], addToks[k])
            if (score > bestScore) {
              bestScore = score
              best = k
            }
          }
          if (best >= 0) {
            usedAdds.add(best)
            pairFor.set(d, best)
          }
        }
      }
      const emittedAdds = new Set<number>()
      for (let d = 0; d < dels.length; d++) {
        const k = pairFor.get(d)
        if (k === undefined) {
          rows.push({ left: dels[d], right: null, leftNo: leftNo++ })
          continue
        }
        // 配对行之间补上跳过的纯新增行，保持原有顺序观感。
        for (let p = 0; p < k; p++) {
          if (!usedAdds.has(p) && !emittedAdds.has(p)) {
            rows.push({ left: null, right: adds[p], rightNo: rightNo++ })
            emittedAdds.add(p)
          }
        }
        // 退化模式下也跳过行内 diff：逐对 LCS 同样是冻结主线程的来源。
        const inline = oversized ? null : inlineDiff(dels[d], adds[k])
        rows.push({
          left: dels[d],
          right: adds[k],
          leftNo: leftNo++,
          rightNo: rightNo++,
          ...(inline ? { leftSegs: inline.left, rightSegs: inline.right } : {})
        })
        emittedAdds.add(k)
      }
      for (let k = 0; k < adds.length; k++) {
        if (!emittedAdds.has(k)) rows.push({ left: null, right: adds[k], rightNo: rightNo++ })
      }
      continue
    }
    if (line.startsWith('+')) {
      while (i < lines.length && lines[i].startsWith('+') && !isFileHdr(lines[i])) {
        rows.push({ left: null, right: lines[i].slice(1), rightNo: rightNo++ })
        i++
      }
      continue
    }
    const ctx = line.startsWith(' ') ? line.slice(1) : line
    rows.push({ left: ctx, right: ctx, leftNo: leftNo++, rightNo: rightNo++ })
    i++
  }
  return rows
}

/**
 * 一行的正文渲染。三种形态，优先级从高到低：
 *
 * 1. **有词级分段**（成对改动的行）→ 按分段渲染，改动片段加深底色。这时
 *    **不上语法高亮**：分段是按字符切的，会把语法 token 拦腰截断，两套着色
 *    叠在一起只会更难读；而在一对改动行上，"改了哪几个词"比"这是个关键字"
 *    重要得多。
 * 2. **有语法高亮 HTML**（上下文行、纯增/纯删行）→ 用高亮结果。
 * 3. 都没有 → 纯文本。
 *
 * html 来自 hljs（自带转义）+ highlightLines 的标签配平，不含用户输入的原始
 * 尖括号，dangerouslySetInnerHTML 在这里是安全的（与 CodeBlock 同源）。
 */
function LineText({
  segs,
  text,
  tone,
  html
}: {
  segs?: Seg[]
  text: string
  tone: 'del' | 'add' | 'ctx'
  html?: string
}): JSX.Element {
  if (segs && tone !== 'ctx') {
    return (
      <>
        {segs.map((seg, i) =>
          seg.changed ? (
            <span key={i} className={tone === 'del' ? 'rounded-sm bg-red-500/25' : 'rounded-sm bg-green-500/25'}>
              {seg.text}
            </span>
          ) : (
            <Fragment key={i}>{seg.text}</Fragment>
          )
        )}
      </>
    )
  }
  if (html !== undefined) return <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
  return <>{text || ' '}</>
}

const NO_COL = 'select-none pr-2 text-right text-[10px] text-zinc-600 tabular-nums'
/** 行号槽与代码之间的分界：行号紧贴代码没有分隔线看着突兀（2026-08 用户反馈）。
 *  加在最靠右的那个行号格上——统一视图是第二列（第一列是旧行号/占位），
 *  分栏视图是每栏唯一的那列。 */
const GUTTER_END = 'border-r border-white/[0.08] mr-1'

/** kimi Read 工具的行前缀：`行号\t内容`。 */
const NUMBERED_LINE_RE = /^(\d+)\t(.*)$/

interface NumberedLine {
  no: number | null
  text: string
}

/** 识别「带行号的文件内容」（Read 工具结果）：非空行里 ≥70% 带 `数字\t` 前缀
 *  才算——阈值防误伤（普通文本恰好一两行以数字+制表符开头不至于被拆）。 */
function toNumberedLines(lines: string[]): NumberedLine[] | null {
  const nonEmpty = lines.filter((l) => l.trim())
  if (nonEmpty.length < 3) return null
  const matched = nonEmpty.filter((l) => NUMBERED_LINE_RE.test(l)).length
  if (matched / nonEmpty.length < 0.7) return null
  return lines.map((l) => {
    const m = NUMBERED_LINE_RE.exec(l)
    return m ? { no: Number(m[1]), text: m[2] } : { no: null, text: l }
  })
}

const DiffView = memo(function DiffView({ text, lang }: { text: string; lang?: string }): JSX.Element {
  const lines = useMemo(() => text.split('\n'), [text])
  const looksLikeDiff = useMemo(
    () => lines.some((l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')),
    [lines]
  )
  const [mode, setMode] = useState<Mode>('unified')
  const rows = useMemo(() => (looksLikeDiff ? toRows(lines) : []), [lines, looksLikeDiff])

  /**
   * 语法高亮：把 diff 还原成"旧文件"和"新文件"两份完整文本各高亮一次，再按行
   * 切回来。**必须整份高亮**——逐行单独高亮会丢掉跨行语境（块注释、模板字符串
   * 里的每一行都会被当成独立代码，着色全错）。
   * 语言认不出（lang 为空/未注册）或文本过大时返回 null，渲染层退回纯文本。
   */
  const highlighted = useMemo(() => {
    if (!looksLikeDiff || !lang) return null
    const oldText: string[] = []
    const newText: string[] = []
    for (const r of rows) {
      if (r.hunk) continue
      if (r.left !== null) oldText.push(r.left)
      if (r.right !== null) newText.push(r.right)
    }
    const left = highlightLines(oldText.join('\n'), lang)
    const right = highlightLines(newText.join('\n'), lang)
    if (!left && !right) return null
    // 行号是 1 起的连续序列，直接按顺序回填：第 n 个非 hunk 的左侧行取 left[n]。
    const leftByRow = new Map<number, string>()
    const rightByRow = new Map<number, string>()
    let li = 0
    let ri = 0
    rows.forEach((r, idx) => {
      if (r.hunk) return
      if (r.left !== null) {
        if (left && li < left.length) leftByRow.set(idx, left[li])
        li++
      }
      if (r.right !== null) {
        if (right && ri < right.length) rightByRow.set(idx, right[ri])
        ri++
      }
    })
    return { leftByRow, rightByRow }
  }, [rows, lang, looksLikeDiff])

  if (!looksLikeDiff) {
    // Read 工具的文件内容：每行自带「行号\t」前缀（kimi Read 的原始格式）。
    // 直接当普通文本渲染时行号和代码糊在一起、没有分界，看着很突兀
    // （2026-08 用户反馈）。识别出来拆成「行号槽 + 分割线 + 高亮代码」。
    const numbered = toNumberedLines(lines)
    if (numbered) {
      const content = numbered.map((n) => n.text).join('\n')
      const highlightedLines = lang ? highlightLines(content, lang) : null
      return (
        <div className="overflow-auto rounded bg-[#0b0c10] p-2.5 font-mono text-xs leading-relaxed text-zinc-300">
          {numbered.map((n, i) => (
            <div key={i} className="flex">
              <span className={`${NO_COL} ${GUTTER_END} w-10 shrink-0`}>{n.no ?? ''}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pl-1 pr-2">
                {highlightedLines && i < highlightedLines.length ? (
                  <span dangerouslySetInnerHTML={{ __html: highlightedLines[i] || '&nbsp;' }} />
                ) : (
                  n.text || ' '
                )}
              </span>
            </div>
          ))}
        </div>
      )
    }
    // 非 diff 输出：按推断语言高亮（识别不了走纯文本，>50KB 跳过高亮）。
    return (
      <CodeBlock
        text={text}
        lang={lang}
        className="overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-300"
      />
    )
  }

  const added = rows.filter((r) => r.left === null && r.right !== null).length
  const removed = rows.filter((r) => r.right === null && r.left !== null).length
  const changed = rows.filter((r) => r.leftSegs !== undefined).length

  return (
    <div className="relative h-full overflow-auto rounded bg-[#0b0c10]">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#0b0c10]/95 px-2 py-1 backdrop-blur-sm">
        <span className="text-[10px] tabular-nums text-zinc-600">
          <span className="text-green-400">+{added + changed}</span>{' '}
          <span className="text-red-400">-{removed + changed}</span>
        </span>
        <div className="ml-auto inline-flex rounded border border-border-subtle bg-bg-elev text-[10px]">
          <button
            onClick={() => setMode('unified')}
            className={`rounded-l px-2 py-0.5 transition ${
              mode === 'unified' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            统一
          </button>
          <button
            onClick={() => setMode('split')}
            className={`rounded-r px-2 py-0.5 transition ${
              mode === 'split' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            拆分
          </button>
        </div>
      </div>

      {mode === 'unified' ? (
        <div className="pb-2.5 font-mono text-xs leading-relaxed">
          {rows.map((r, i) => {
            if (r.hunk) {
              return (
                <div key={i} className="bg-blue-950/20 px-2 py-0.5 text-blue-400">
                  {r.hunk}
                </div>
              )
            }
            // 成对改动在统一视图里拆成一删一增两行，各自带行内高亮。
            const out: JSX.Element[] = []
            if (r.left !== null) {
              out.push(
                <div key={`${i}-l`} className="flex bg-red-950/25">
                  <span className={`${NO_COL} w-10 shrink-0`}>{r.leftNo ?? ''}</span>
                  <span className={`${GUTTER_END} w-10 shrink-0`} />
                  <span className="shrink-0 select-none px-1 text-red-400">-</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-red-200">
                    <LineText
                      segs={r.leftSegs}
                      text={r.left}
                      tone="del"
                      {...(highlighted?.leftByRow.has(i) ? { html: highlighted.leftByRow.get(i) } : {})}
                    />
                  </span>
                </div>
              )
            }
            if (r.right !== null && r.right !== r.left) {
              out.push(
                <div key={`${i}-r`} className="flex bg-green-950/25">
                  <span className="w-10 shrink-0" />
                  <span className={`${NO_COL} ${GUTTER_END} w-10 shrink-0`}>{r.rightNo ?? ''}</span>
                  <span className="shrink-0 select-none px-1 text-green-400">+</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-green-200">
                    <LineText
                      segs={r.rightSegs}
                      text={r.right}
                      tone="add"
                      {...(highlighted?.rightByRow.has(i) ? { html: highlighted.rightByRow.get(i) } : {})}
                    />
                  </span>
                </div>
              )
            }
            if (r.left !== null && r.left === r.right) {
              return (
                <div key={i} className="flex">
                  <span className={`${NO_COL} w-10 shrink-0`}>{r.leftNo ?? ''}</span>
                  <span className={`${NO_COL} w-10 shrink-0`}>{r.rightNo ?? ''}</span>
                  <span className="shrink-0 select-none px-1 text-zinc-700"> </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 text-zinc-400">
                    <LineText
                      text={r.left}
                      tone="ctx"
                      {...(highlighted?.leftByRow.has(i) ? { html: highlighted.leftByRow.get(i) } : {})}
                    />
                  </span>
                </div>
              )
            }
            return <Fragment key={i}>{out}</Fragment>
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 pb-2.5 font-mono text-xs leading-relaxed">
          {rows.map((r, i) =>
            r.hunk ? (
              <div key={i} className="col-span-2 bg-blue-950/20 px-2 py-0.5 text-blue-400">
                {r.hunk}
              </div>
            ) : (
              <Fragment key={i}>
                <div
                  className={`flex min-w-0 ${
                    r.left === null
                      ? 'bg-bg-base/40'
                      : r.left === r.right
                        ? ''
                        : 'bg-red-950/25'
                  }`}
                >
                  <span className={`${NO_COL} w-10 shrink-0`}>{r.leftNo ?? ''}</span>
                  <span
                    className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 ${
                      r.left === null ? '' : r.left === r.right ? 'text-zinc-500' : 'text-red-200'
                    }`}
                  >
                    {r.left === null ? (
                      ''
                    ) : (
                      <LineText
                        segs={r.leftSegs}
                        text={r.left}
                        tone={r.left === r.right ? 'ctx' : 'del'}
                        {...(highlighted?.leftByRow.has(i) ? { html: highlighted.leftByRow.get(i) } : {})}
                      />
                    )}
                  </span>
                </div>
                <div
                  className={`flex min-w-0 border-l border-white/[0.06] ${
                    r.right === null
                      ? 'bg-bg-base/40'
                      : r.left === r.right
                        ? ''
                        : 'bg-green-950/25'
                  }`}
                >
                  <span className={`${NO_COL} w-10 shrink-0`}>{r.rightNo ?? ''}</span>
                  <span
                    className={`min-w-0 flex-1 whitespace-pre-wrap break-all pr-2 ${
                      r.right === null ? '' : r.left === r.right ? 'text-zinc-500' : 'text-green-200'
                    }`}
                  >
                    {r.right === null ? (
                      ''
                    ) : (
                      <LineText
                        segs={r.rightSegs}
                        text={r.right}
                        tone={r.left === r.right ? 'ctx' : 'add'}
                        {...(highlighted?.rightByRow.has(i) ? { html: highlighted.rightByRow.get(i) } : {})}
                      />
                    )}
                  </span>
                </div>
              </Fragment>
            )
          )}
        </div>
      )}
    </div>
  )
})

export default DiffView
