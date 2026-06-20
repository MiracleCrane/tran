import { useEffect, useRef, useState, type ReactNode } from 'react'
import Collapse from './Collapse'

export interface DisclosureOption {
  value: string
  label: string
}

const DISCLOSURE_CLOSE_ELEVATION_MS = 560

/** A selector whose OWN frame enlarges in place — the trigger and the option
 *  list live in one glass-panel-soft frame; opening it grows that same frame
 *  (height-tween + spring, options stagger in). The frame is absolutely
 *  positioned and floats OVER surrounding content, so nothing gets shoved up
 *  or down — an invisible placeholder reserves just the trigger's footprint in
 *  the flow. NOT a second popover frame attached to a separate trigger.
 *  placement="top" (Composer, window bottom) grows upward; else downward. */
export default function DisclosureSelect({
  value,
  options,
  onChange,
  triggerLeading,
  className,
  placement = 'bottom',
  disabled = false,
  title
}: {
  value: string
  options: DisclosureOption[]
  onChange: (value: string) => void
  triggerLeading?: ReactNode
  /** Extra classes on the wrapping (relative) element, e.g. a width. */
  className?: string
  placement?: 'bottom' | 'top'
  disabled?: boolean
  title?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [elevated, setElevated] = useState(false)
  const elevationTimerRef = useRef<number | null>(null)
  const current = options.find((o) => o.value === value)
  const label = current?.label ?? value

  useEffect(() => {
    if (disabled) {
      setOpen(false)
      setElevated(false)
      return
    }

    if (elevationTimerRef.current !== null) {
      window.clearTimeout(elevationTimerRef.current)
      elevationTimerRef.current = null
    }

    if (open) {
      setElevated(true)
      return
    }

    elevationTimerRef.current = window.setTimeout(() => {
      elevationTimerRef.current = null
      setElevated(false)
    }, DISCLOSURE_CLOSE_ELEVATION_MS)

    return () => {
      if (elevationTimerRef.current !== null) {
        window.clearTimeout(elevationTimerRef.current)
        elevationTimerRef.current = null
      }
    }
  }, [disabled, open])

  const optionsList = (
    <Collapse open={open}>
      <div className="pt-0.5">
        {options.map((o, i) => {
          const active = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              style={{
                transitionDelay: open ? `${i * 40}ms` : '0ms',
                opacity: open ? 1 : 0,
                transform: open ? 'translateY(0)' : 'translateY(-6px)'
              }}
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-xs transition-all duration-[360ms] ease-spring ${
                active ? 'glass-active text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-accent' : 'bg-transparent'}`} />
              <span className="truncate">{o.label}</span>
            </button>
          )
        })}
      </div>
    </Collapse>
  )

  return (
    <div className={`relative ${elevated ? 'z-[80]' : 'z-auto'} ${className ?? ''}`}>
      {/* The one frame. Absolute so enlarging it overlaps content instead of
          shoving it; trigger + options share it, so opening reads as the frame
          itself growing, not a second frame appearing. */}
      <div
        className={`glass-panel-soft disclosure-select-panel absolute inset-x-0 rounded-2xl p-1.5 ${
          elevated ? 'z-[90]' : 'z-50'
        } ${disabled ? 'opacity-60' : ''} ${placement === 'top' ? 'bottom-0' : 'top-0'}`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {placement === 'top' ? optionsList : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          title={title}
          className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-300"
          aria-expanded={open}
        >
          {triggerLeading}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            className={`shrink-0 text-zinc-500 transition-transform duration-[360ms] ease-spring ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {placement === 'bottom' ? optionsList : null}
      </div>

      {/* click-outside catcher (below the floating frame) */}
      {open && <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />}

      {/* Invisible placeholder: reserves the frame's COLLAPSED footprint in
          the flow (the absolute frame doesn't, by itself). Matches the
          frame's padding + a one-line trigger so heights line up. */}
      <div className="invisible" aria-hidden>
        <div className="glass-panel-soft rounded-2xl p-1.5">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
            {triggerLeading ? <span className="w-[14px]" /> : null}
            <span className="flex-1 truncate">{label}</span>
            <span className="w-[13px]" />
          </div>
        </div>
      </div>
    </div>
  )
}
