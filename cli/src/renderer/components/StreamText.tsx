import { memo, useLayoutEffect, useRef, useState } from 'react'

interface StreamTextProps {
  text: string
  /** True while this message is still streaming; once false the component
   *  switches to static rendering (no gradient mask, no animations). */
  streaming?: boolean
}

interface RevealTail {
  start: number
  end: number
}

/** Lightweight wrapper for streaming text. Only the newly appended tail gets
 *  the reveal animation; already-rendered text stays static so the whole
 *  message does not flicker on every token update. */
const StreamText = memo(function StreamText({
  text,
  streaming = true
}: StreamTextProps): JSX.Element {
  const previousTextRef = useRef(text)
  const [revealTail, setRevealTail] = useState<RevealTail | null>(null)

  useLayoutEffect(() => {
    if (!streaming) {
      previousTextRef.current = text
      setRevealTail(null)
      return
    }

    const previous = previousTextRef.current
    if (text.length > previous.length && text.startsWith(previous)) {
      setRevealTail({ start: previous.length, end: text.length })
    } else if (text !== previous) {
      setRevealTail(null)
    }
    previousTextRef.current = text
  }, [text, streaming])

  if (!streaming || text.length === 0) {
    return <>{text}</>
  }

  if (!revealTail || revealTail.start >= text.length) {
    return <>{text}</>
  }

  const stable = text.slice(0, revealTail.start)
  const incoming = text.slice(revealTail.start)

  return (
    <>
      {stable}
      <span key={`${revealTail.start}:${revealTail.end}`} className="stream-text-reveal-new">
        {incoming}
      </span>
    </>
  )
})

export default StreamText
