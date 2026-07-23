/** AppLogo — the Tran app icon as an inline SVG, so every in-app logo
 *  (titlebar, sidebar brand, splash) matches the packaged taskbar icon
 *  exactly: near-black rounded square, white geometric "T", purple dot. */
export function AppLogo({ size = 32, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="48" height="48" rx="10.5" fill="#101014" />
      <rect x="14.64" y="13.44" width="14.88" height="4.32" rx="1.1" fill="#ffffff" />
      <rect x="19.73" y="13.44" width="4.7" height="18.24" rx="1.1" fill="#ffffff" />
      <circle cx="34.7" cy="14.06" r="2.64" fill="#8B5CF6" />
    </svg>
  )
}
