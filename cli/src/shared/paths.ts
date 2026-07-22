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

/** Windows 路径归一化（比较用）：正斜杠、去尾斜杠、小写。
 *  kimi session/list 返回 `C:/project/...`，渲染层 cwd 常是反斜杠形式。 */
export function normalizeCwdForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
