import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Height-only collapse via `grid-rows 0fr↔1fr` (no max-height guessing). The
 *  inner overflow-hidden clips children mid-tween. Always mounted, so BOTH
 *  expand and collapse animate — unlike a mount-rendered popover, which can
 *  only animate on open. This is the single primitive behind every disclosure
 *  in the app (nav, dropdowns, selects). */
export default function Collapse({
  open,
  children,
  className
}: {
  open: boolean
  children: ReactNode
  className?: string
}): JSX.Element {
  const previousOpen = useRef(open)
  const [motion, setMotion] = useState<'opening' | 'closing' | null>(null)

  useLayoutEffect(() => {
    if (previousOpen.current === open) return

    setMotion(open ? 'opening' : 'closing')
    previousOpen.current = open

    const timeout = window.setTimeout(() => setMotion(null), 1000)
    return () => window.clearTimeout(timeout)
  }, [open])

  return (
    <div
      className={`liquid-collapse grid ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      } ${open ? 'is-open' : ''} ${motion ? `is-${motion}` : ''} ${className ?? ''}`}
    >
      <div className="liquid-collapse-body min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
