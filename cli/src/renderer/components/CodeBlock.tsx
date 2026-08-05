import { memo, useMemo } from 'react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github-dark.css'

/** 工具输出代码高亮（IDE 风）：highlight.js 按需注册语言（控制包体），
 *  主题 github-dark + styles.css 紫色系微调。超过 50KB 跳过高亮（性能闸）。 */

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const HIGHLIGHT_MAX_CHARS = 50 * 1024

const EXT_LANG: Record<string, string> = {
  java: 'java',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  md: 'markdown',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'bash',
  bat: 'bash',
  cmd: 'bash'
}

/** 按文件路径的扩展名推断语言；识别不了返回 undefined（走纯文本）。 */
export function langForPath(path: string): string | undefined {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return EXT_LANG[ext]
}

/** 按工具类型/输入路径推断语言：Bash/terminal→bash、patch→diff、
 *  读写文件按扩展名；识别不了返回 undefined（走纯文本）。 */
export function langForTool(name: string, input: unknown): string | undefined {
  if (name === 'Bash' || name === 'terminal') return 'bash'
  if (name === 'patch') return 'diff'
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const inp = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const path = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.path === 'string' ? inp.path : ''
  return langForPath(path)
}

/** hljs 高亮后按行切分（供 DiffView 逐行渲染）。
 *
 *  直接 `html.split('\n')` 是错的：hljs 的 `<span>` 会跨行，切开后每行的标签
 *  不闭合，浏览器会把后续内容全吞进上一行的 span 里。这里维护一个开标签栈，
 *  每到换行就把当前所有 span 关掉、下一行再原样重开。 */
export function highlightLines(text: string, lang: string | undefined): string[] | null {
  if (!lang || !hljs.getLanguage(lang) || text.length > HIGHLIGHT_MAX_CHARS) return null
  let html: string
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
  } catch {
    return null
  }
  const lines: string[] = []
  const open: string[] = []
  let cur = ''
  let i = 0
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      const end = html.indexOf('>', i)
      if (end < 0) {
        cur += html.slice(i)
        break
      }
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('</')) open.pop()
      else if (!tag.endsWith('/>')) open.push(tag)
      cur += tag
      i = end + 1
      continue
    }
    if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
      i++
      continue
    }
    cur += ch
    i++
  }
  lines.push(cur + '</span>'.repeat(open.length))
  return lines
}

const CodeBlock = memo(function CodeBlock({
  text,
  lang,
  className
}: {
  text: string
  lang?: string
  className?: string
}): JSX.Element {
  const html = useMemo(() => {
    if (!lang || !hljs.getLanguage(lang) || text.length > HIGHLIGHT_MAX_CHARS) return null
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [text, lang])

  return (
    <pre className={className}>
      {html ? (
        <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        text
      )}
    </pre>
  )
})

export default CodeBlock
