import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function RefreshIcon({ spinning = false }: { spinning?: boolean }): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 ${spinning ? 'animate-spin' : ''}`}
      aria-hidden
    >
      <path
        d="M20 6v5h-5M4 18v-5h5M18.4 9A7 7 0 0 0 6.7 6.7L4 9.4M5.6 15A7 7 0 0 0 17.3 17.3L20 14.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ToolPanelHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-zinc-100">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function ToolPanelButton({
  variant = 'secondary',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger'
}): JSX.Element {
  const variantClass =
    variant === 'primary'
      ? 'bg-accent text-white hover:brightness-110'
      : variant === 'danger'
        ? 'border border-red-900/60 bg-red-950/50 text-red-300 hover:bg-red-950/70'
        : 'glass-control text-zinc-300 hover:bg-white/[0.08]'

  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variantClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function ToolPanelAlert({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warning' | 'error' | 'success'
  children: ReactNode
}): JSX.Element {
  const toneClass =
    tone === 'error'
      ? 'border-red-900/50 bg-red-950/30 text-red-300'
      : tone === 'warning'
        ? 'border-amber-900/40 bg-amber-950/20 text-amber-300/90'
        : tone === 'success'
          ? 'border-emerald-900/50 bg-emerald-950/20 text-emerald-300'
          : 'border-border-subtle bg-bg-panel text-zinc-300'

  return (
    <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${toneClass}`}>
      {children}
    </div>
  )
}
