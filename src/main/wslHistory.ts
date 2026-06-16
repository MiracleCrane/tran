import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix as pathPosix } from 'node:path'
import type { HistoryMessage, SessionListItem, SessionListOptions } from '../shared/ipc'
import { log } from './logger'
import { fromWslPath, toWslPath } from './wslClaude'

interface WslTranscriptFile {
  path: string
  mtimeMs: number
  size: number
}

type RawTranscriptEntry = Record<string, unknown>

interface FoldedSession {
  sessionId: string
  summary: string
  lastModified: number
  cwd?: string
  gitBranch?: string
  isSidechain?: boolean
}

const TRANSCRIPT_FIND_SCRIPT = [
  'root="$HOME/.claude/projects"',
  '[ -d "$root" ] || exit 0',
  "find \"$root\" -type f -name '*.jsonl' ! -path '*/subagents/*' -exec stat -c '%Y\\t%s\\t%n' {} \\; 2>/dev/null"
].join('\n')

function runWslText(args: string[], input?: string, timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('wsl.exe command timed out')))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      finish(() => reject(error))
    })
    child.on('exit', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout)
          return
        }
        const detail = stderr.trim() || signal || `exit code ${code ?? 'unknown'}`
        reject(new Error(`wsl.exe failed: ${detail}`))
      })
    })

    child.stdin.end(input)
  })
}

async function runWslShell(script: string, env: Record<string, string> = {}): Promise<string> {
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`)
  return runWslText(['--exec', 'env', ...envArgs, 'sh', '-lc', script])
}

function sessionIdFromPath(path: string): string | null {
  const filename = pathPosix.basename(path)
  if (!filename.endsWith('.jsonl')) return null
  const sessionId = filename.slice(0, -'.jsonl'.length)
  return sessionId || null
}

function isSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')
}

function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  const converted = toWslPath(value)
  if (!converted) return undefined
  let normalized = converted.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
  if (/^\/mnt\/[a-z]\//i.test(normalized)) return normalized.toLowerCase()
  return normalized
}

function sameWslPath(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeComparablePath(a)
  const right = normalizeComparablePath(b)
  return !!left && !!right && left === right
}

function parseTranscriptFiles(stdout: string): WslTranscriptFile[] {
  const files: WslTranscriptFile[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let [mtimeRaw, sizeRaw, ...pathParts] = line.split('\t')
    if (!pathParts.length) {
      ;[mtimeRaw, sizeRaw, ...pathParts] = line.split('\\t')
    }
    if (!pathParts.length) {
      const match = line.match(/^(\d+(?:\.\d+)?)\s+(\d+)\s+(.+)$/)
      if (!match) continue
      ;[, mtimeRaw, sizeRaw] = match
      pathParts = [match[3]]
    }
    const path = pathParts.join('\t')
    if (!path) continue
    const mtimeSeconds = Number(mtimeRaw)
    const size = Number(sizeRaw)
    files.push({
      path,
      mtimeMs: Number.isFinite(mtimeSeconds) ? mtimeSeconds * 1000 : 0,
      size: Number.isFinite(size) ? size : 0
    })
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files
}

async function listWslTranscriptFiles(): Promise<WslTranscriptFile[]> {
  const stdout = await runWslShell(TRANSCRIPT_FIND_SCRIPT)
  return parseTranscriptFiles(stdout)
}

async function readWslFile(path: string): Promise<string> {
  return runWslText(['--exec', 'cat', '--', path], undefined, 30000)
}

function parseJsonLines(text: string): RawTranscriptEntry[] {
  const entries: RawTranscriptEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object') entries.push(parsed as RawTranscriptEntry)
    } catch {
      /* skip corrupt or partial lines */
    }
  }
  return entries
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function textFromUserMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() || undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as { type?: unknown; text?: unknown }
    if (block.type === 'tool_result') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('').trim()
  return text || undefined
}

function foldSession(file: WslTranscriptFile, entries: RawTranscriptEntry[]): FoldedSession | null {
  const sessionId = entries
    .map((entry) => asString(entry.sessionId) ?? asString(entry.session_id))
    .find(Boolean) ?? sessionIdFromPath(file.path)
  if (!sessionId) return null

  let customTitle: string | undefined
  let aiTitle: string | undefined
  let lastPrompt: string | undefined
  let summaryHint: string | undefined
  let firstPrompt: string | undefined
  let cwd: string | undefined
  let gitBranch: string | undefined
  let createdAt: number | undefined
  let isSidechain = false

  for (const entry of entries) {
    if (entry.isSidechain === true) isSidechain = true
    cwd ??= asString(entry.cwd)
    gitBranch = asString(entry.gitBranch) ?? gitBranch
    const timestamp = asString(entry.timestamp)
    if (createdAt === undefined && timestamp) {
      const parsed = Date.parse(timestamp)
      if (!Number.isNaN(parsed)) createdAt = parsed
    }

    customTitle = asString(entry.customTitle) ?? customTitle
    aiTitle = asString(entry.aiTitle) ?? aiTitle
    summaryHint = asString(entry.summary) ?? summaryHint
    lastPrompt = asString(entry.lastPrompt) ?? lastPrompt

    if (!firstPrompt && entry.type === 'user') {
      firstPrompt = textFromUserMessage(entry.message)
    }
  }

  const summary = customTitle ?? aiTitle ?? lastPrompt ?? summaryHint ?? firstPrompt ?? ''
  return {
    sessionId,
    summary,
    lastModified: file.mtimeMs || createdAt || Date.now(),
    ...(cwd ? { cwd } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(isSidechain ? { isSidechain } : {})
  }
}

function entryParentToolUseId(entry: RawTranscriptEntry): string | null {
  return (
    asString(entry.parent_tool_use_id) ??
    asString(entry.parentToolUseId) ??
    asString(entry.parentToolUseID) ??
    null
  )
}

function toHistoryMessages(entries: RawTranscriptEntry[], fallbackSessionId: string): HistoryMessage[] {
  const messages: HistoryMessage[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const sessionId = asString(entry.session_id) ?? asString(entry.sessionId) ?? fallbackSessionId
    messages.push({
      type: entry.type,
      uuid: asString(entry.uuid) ?? `${sessionId}-${i}`,
      session_id: sessionId,
      message: entry.message ?? {},
      parent_tool_use_id: entryParentToolUseId(entry)
    })
  }
  return messages
}

async function readSessionEntries(file: WslTranscriptFile): Promise<RawTranscriptEntry[]> {
  return parseJsonLines(await readWslFile(file.path))
}

async function findSessionFile(sessionId: string, cwd: string): Promise<WslTranscriptFile | null> {
  if (!isSafeSessionId(sessionId)) return null
  const targetCwd = toWslPath(cwd)
  const files = (await listWslTranscriptFiles()).filter((file) => sessionIdFromPath(file.path) === sessionId)
  for (const file of files) {
    const folded = foldSession(file, await readSessionEntries(file))
    if (!targetCwd || sameWslPath(folded?.cwd, targetCwd)) return file
  }
  return targetCwd ? null : (files[0] ?? null)
}

export async function listWslSessions(cwd: string, opts?: SessionListOptions): Promise<SessionListItem[]> {
  const targetCwd = toWslPath(cwd)
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : 50
  const offset = opts?.offset && opts.offset > 0 ? opts.offset : 0
  const end = offset + limit
  const out: SessionListItem[] = []
  let matched = 0

  try {
    for (const file of await listWslTranscriptFiles()) {
      const folded = foldSession(file, await readSessionEntries(file))
      if (!folded || folded.isSidechain) continue
      if (targetCwd && !sameWslPath(folded.cwd, targetCwd)) continue
      if (matched++ < offset) continue
      if (out.length >= limit) break
      out.push({
        sessionId: folded.sessionId,
        summary: folded.summary,
        lastModified: folded.lastModified,
        cwd: fromWslPath(folded.cwd),
        gitBranch: folded.gitBranch
      })
      if (matched >= end && out.length >= limit) break
    }
  } catch (err) {
    log('wsl-history', `list sessions failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return out
}

export async function getWslSessionMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]> {
  try {
    const file = await findSessionFile(sessionId, cwd)
    if (!file) return []
    return toHistoryMessages(await readSessionEntries(file), sessionId).slice(0, 500)
  } catch (err) {
    log('wsl-history', `get messages failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export async function renameWslSession(sessionId: string, title: string, cwd: string): Promise<void> {
  const trimmed = title.trim()
  if (!trimmed || !isSafeSessionId(sessionId)) return
  const file = await findSessionFile(sessionId, cwd)
  if (!file) throw new Error(`WSL session not found: ${sessionId}`)
  const entry = {
    type: 'custom-title',
    customTitle: trimmed,
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString()
  }
  await runWslText(['--exec', 'sh', '-c', 'cat >> "$1"', 'sh', file.path], `${JSON.stringify(entry)}\n`)
}

export async function deleteWslSession(sessionId: string, cwd: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) return
  const file = await findSessionFile(sessionId, cwd)
  if (!file) return
  const sidecarDir = file.path.slice(0, -'.jsonl'.length)
  await runWslText(['--exec', 'rm', '-f', '--', file.path])
  await runWslText(['--exec', 'rm', '-rf', '--', sidecarDir])
}

export async function getWslSubagentMessages(
  sessionId: string,
  agentId: string,
  cwd: string
): Promise<HistoryMessage[]> {
  if (!isSafeAgentId(agentId)) return []
  try {
    const file = await findSessionFile(sessionId, cwd)
    if (!file) return []
    const subagentPath = `${file.path.slice(0, -'.jsonl'.length)}/subagents/agent-${agentId}.jsonl`
    const entries = parseJsonLines(await readWslFile(subagentPath))
    return toHistoryMessages(entries, sessionId).slice(0, 500)
  } catch (err) {
    log('wsl-history', `get subagent messages failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
