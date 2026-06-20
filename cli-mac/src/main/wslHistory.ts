import type { HistoryMessage, SessionListItem, SessionListOptions } from '../shared/ipc'

/**
 * WSL session history — macOS stubs.
 *
 * See wslClaude.ts header: WSL is Windows-only. On macOS Claude session
 * transcripts live directly at ~/.claude/projects/** and are read by the
 * Agent SDK's native listSessions/getSessionMessages path (not these helpers).
 * These stubs keep the imported signatures intact for ipc.ts compilation; they
 * are never invoked at runtime on macOS.
 */

export async function listWslSessions(
  _cwd: string,
  _opts?: SessionListOptions
): Promise<SessionListItem[]> {
  return []
}

export async function getWslSessionMessages(
  _sessionId: string,
  _cwd: string
): Promise<HistoryMessage[]> {
  return []
}

export async function renameWslSession(
  _sessionId: string,
  _title: string,
  _cwd: string
): Promise<void> {
  /* no-op */
}

export async function deleteWslSession(_sessionId: string, _cwd: string): Promise<void> {
  /* no-op */
}

export async function getWslSubagentMessages(
  _sessionId: string,
  _agentId: string,
  _cwd: string
): Promise<HistoryMessage[]> {
  return []
}
