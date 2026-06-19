import { Fragment, memo, useState } from 'react'

type Mode = 'unified' | 'split'

interface Row {
  /** null = empty cell (for alignment) */
  left: string | null
  right: string | null
  /** hunk header (@@) rendered full-width */
  hunk?: string
}

/** Pair consecutive `-`/`+` runs into side-by-side rows (no LCS — a simple
 *  heuristic that lines up a deletion run with the following addition run). */
function toSplitRows(lines: string[]): Row[] {
  const rows: Row[] = []
  let i = 0
  const isFileHdr = (l: string): boolean => l.startsWith('+++') || l.startsWith('---')
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('@@')) {
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
      const max = Math.max(dels.length, adds.length)
      for (let k = 0; k < max; k++) {
        rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
      }
      continue
    }
    if (line.startsWith('+')) {
      // additions with no preceding deletions
      while (i < lines.length && lines[i].startsWith('+') && !isFileHdr(lines[i])) {
        rows.push({ left: null, right: lines[i].slice(1) })
        i++
      }
      continue
    }
    // context line (leading space or empty)
    const ctx = line.startsWith(' ') ? line.slice(1) : line
    rows.push({ left: ctx, right: ctx })
    i++
  }
  return rows
}

const DiffView = memo(function DiffView({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const looksLikeDiff = lines.some(
    (l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')
  )
  const [mode, setMode] = useState<Mode>('unified')

  if (!looksLikeDiff) {
    return <pre className="overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-300">{text}</pre>
  }

  return (
    <div className="relative overflow-auto rounded bg-[#0b0c10]">
      <div className="sticky top-0 z-10 flex justify-end bg-[#0b0c10]/90 px-2 py-1">
        <div className="inline-flex rounded border border-border-subtle bg-bg-elev text-[10px]">
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
        <pre className="px-2.5 pb-2.5 text-xs leading-relaxed">
          {lines.map((line, i) => {
            let cls = 'text-zinc-400'
            if (line.startsWith('+++') || line.startsWith('---'))
              cls = 'text-zinc-300 font-semibold'
            else if (line.startsWith('@@')) cls = 'text-blue-400'
            else if (line.startsWith('+')) cls = 'bg-green-950/30 text-green-300'
            else if (line.startsWith('-')) cls = 'bg-red-950/30 text-red-300'
            return (
              <div key={i} className={`px-1 ${cls}`}>
                {line || ' '}
              </div>
            )
          })}
        </pre>
      ) : (
        <div className="grid grid-cols-2 pb-2.5 text-xs leading-relaxed">
          {toSplitRows(lines).map((r, i) =>
            r.hunk ? (
              <div key={i} className="col-span-2 px-2 py-0.5 text-blue-400">
                {r.hunk}
              </div>
            ) : (
              <Fragment key={i}>
                <div
                  className={`whitespace-pre-wrap break-all px-2 ${
                    r.left == null
                      ? 'bg-bg-base/40'
                      : r.left === r.right
                        ? 'text-zinc-500'
                        : 'bg-red-950/30 text-red-300'
                  }`}
                >
                  {r.left ?? ''}
                </div>
                <div
                  className={`whitespace-pre-wrap break-all px-2 ${
                    r.right == null
                      ? 'bg-bg-base/40'
                      : r.left === r.right
                        ? 'text-zinc-500'
                        : 'bg-green-950/30 text-green-300'
                  }`}
                >
                  {r.right ?? ''}
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
