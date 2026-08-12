import type { JSX } from 'react'

/**
 * 设置项说明文字的轻量 Markdown 渲染。
 *
 * 设置里的说明此前是纯文本直出，写在里面的 `代码`、**强调**、换行全部原样
 * 显示成字面量（用户反馈「md 也没有渲染」）。这里不引整套 markdown 管线：
 * 设置说明只需要三种记号，正则一次成型比挂 remark 便宜得多，也不会把
 * 标题/列表/图片那些说明里根本不该出现的东西放进来。
 *
 * 支持：`行内代码`、**加粗**、空行分段、单换行即换行。
 */

type Segment = { kind: 'text' | 'code' | 'strong'; value: string }

/** 一次扫描切出 `code` 与 **strong**；两者不嵌套（说明文字里没有这种需求）。 */
function tokenize(line: string): Segment[] {
  const out: Segment[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push({ kind: 'text', value: line.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'code', value: m[1] })
    else out.push({ kind: 'strong', value: m[2] ?? '' })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ kind: 'text', value: line.slice(last) })
  return out
}

export default function SettingText({
  children,
  className = ''
}: {
  children: string
  className?: string
}): JSX.Element {
  const paragraphs = children.split(/\n{2,}/)
  return (
    <div className={`space-y-1.5 ${className}`}>
      {paragraphs.map((para, pi) => (
        <p key={pi} className="text-[11px] leading-relaxed text-zinc-500">
          {para.split('\n').map((line, li) => (
            <span key={li}>
              {li > 0 && <br />}
              {tokenize(line).map((seg, si) =>
                seg.kind === 'code' ? (
                  <code
                    key={si}
                    className="rounded bg-bg-elev px-1 py-px font-mono text-[10.5px] text-zinc-300"
                  >
                    {seg.value}
                  </code>
                ) : seg.kind === 'strong' ? (
                  <strong key={si} className="font-medium text-zinc-300">
                    {seg.value}
                  </strong>
                ) : (
                  <span key={si}>{seg.value}</span>
                )
              )}
            </span>
          ))}
        </p>
      ))}
    </div>
  )
}
