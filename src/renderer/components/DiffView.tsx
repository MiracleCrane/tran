/** Renders text as a colorized unified diff when it looks like one, else plain. */
export default function DiffView({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const looksLikeDiff = lines.some(
    (l) => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@')
  )

  if (!looksLikeDiff) {
    return <pre className="overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs text-zinc-300">{text}</pre>
  }

  return (
    <pre className="overflow-auto rounded bg-[#0b0c10] p-2.5 text-xs leading-relaxed">
      {lines.map((line, i) => {
        let cls = 'text-zinc-400'
        if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-zinc-300 font-semibold'
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
  )
}
