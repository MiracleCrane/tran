export function isWslProjectPath(
  path: string | undefined,
  options: { includePosixAbsolute?: boolean } = {}
): boolean {
  const trimmed = path?.trim()
  if (!trimmed) return false

  const normalized = trimmed.replace(/\\/g, '/')
  if (/^\/\/wsl(?:\$|\.localhost)(?:\/|$)/i.test(normalized)) return true

  return (
    options.includePosixAbsolute === true &&
    /^\/(?:home|root|mnt|workspace|workspaces|var|etc|usr|opt|tmp)(?:\/|$)/.test(normalized)
  )
}
