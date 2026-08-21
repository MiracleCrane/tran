import { useEffect, useMemo, useState } from 'react'

const ICON_CLASS =
  'mr-0.5 inline-block h-[0.95em] w-[0.95em] shrink-0 align-[-0.1em] text-zinc-400'

function normalizedUrl(href: string): URL | null {
  try {
    return new URL(href.startsWith('//') ? `https:${href}` : href)
  } catch {
    return null
  }
}

function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'github.com' || host.endsWith('.github.com')
}

function remoteFaviconUrl(url: URL): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const favicon = new URL('https://www.google.com/s2/favicons')
  favicon.searchParams.set('domain', url.origin)
  favicon.searchParams.set('sz', '32')
  return favicon.toString()
}

function GitHubIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={ICON_CLASS}
      aria-hidden
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5a13.4 13.4 0 0 0-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  )
}

function ExternalLinkIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={ICON_CLASS}
      aria-hidden
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}

/** Theme-safe icon for an external Markdown link.
 *
 * Known dark-mode-sensitive providers use bundled vector icons. Other HTTP(S)
 * sites use Google's normalized favicon service and fall back to a bundled
 * external-link glyph, so an unavailable or low-quality site icon never leaves
 * an empty slot in the transcript.
 */
export function LinkIcon({ href }: { href: string }): JSX.Element {
  const target = useMemo(() => normalizedUrl(href), [href])
  const faviconUrl = useMemo(() => target ? remoteFaviconUrl(target) : null, [target])
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [faviconUrl])

  if (target && isGitHubHost(target.hostname)) return <GitHubIcon />
  if (!faviconUrl || failed) return <ExternalLinkIcon />

  return (
    <img
      src={faviconUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${ICON_CLASS} rounded-[2px]`}
    />
  )
}
