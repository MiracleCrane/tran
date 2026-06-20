/**
 * WSL Claude settings read/write — macOS stubs.
 *
 * See wslClaude.ts header: WSL is Windows-only. On macOS Claude's settings live
 * directly at ~/.claude/settings.json and are read/written by the native
 * providers.ts path (readWindowsClaudeSettings/writeWindowsClaudeSettings — the
 * name is historical; it's just filesystem I/O). These stubs keep the imported
 * signatures intact for providers.ts compilation and are never invoked at
 * runtime on macOS.
 */

export function readWslClaudeSettings(): Record<string, unknown> {
  return {}
}

export function writeWslClaudeSettings(_data: Record<string, unknown>): void {
  /* no-op */
}
