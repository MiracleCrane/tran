import { createReadStream, existsSync } from 'node:fs'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { HistoryMessage, SessionListItem } from '../shared/ipc'
import { localSessionTitle, manualSessionTitle } from './sessionTitles'
import { aiSessionTitle } from './aiTitles'
import { log } from './logger'

/**
 * Claude Code 的历史会话（侧栏列表用）。
 *
 * Claude Code 把每个会话写成一个 JSONL：
 *   <配置目录>/projects/<cwd 的 slug>/<sessionId>.jsonl
 * 每行一条记录，带 `cwd` / `gitBranch` / `sessionId`，第一条 user 记录就是
 * 用户的开场白——正好够拼出侧栏条目。
 *
 * 之前 Tran 只读 kimi 的历史，Claude Code 会话根本进不了侧栏：关掉 Tran 那段
 * 对话就再也找不回来，也没法 resume（--resume 的能力一直都在，只是没有入口）。
 */

/** 配置目录：CLAUDE_CONFIG_DIR 优先（实测装机会把它设成机器级环境变量，
 *  硬猜 ~/.claude 会全盘落空），否则退回 ~/.claude。 */
export function claudeConfigHome(): string {
  const fromEnv = process.env['CLAUDE_CONFIG_DIR']
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.claude')
}

function projectsRoot(): string {
  return join(claudeConfigHome(), 'projects')
}

/** cwd → 目录名。实测规则：路径分隔符与盘符冒号一律换成 `-`
 *  （`C:\LegacyD\project\tran` → `C--LegacyD-project-tran`）。 */
function slugForCwd(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').replace(/[\\/:]/g, '-')
}

/** 头部够拿到 cwd 与开场白就行；整份读进来在长会话上是几十 MB。 */
const HEAD_BYTES = 96 * 1024

interface HeadInfo {
  cwd?: string
  gitBranch?: string
  summary?: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const b = raw as Record<string, unknown>
    if (b && b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
  }
  return parts.join('\n')
}

/** 这条 user 记录能不能当标题：排除侧链（子 agent）、meta 记录，以及
 *  本地命令注入的那些外壳文本——它们不是用户说的话。 */
function usableUserText(rec: Record<string, unknown>): string | null {
  if (rec['type'] !== 'user') return null
  if (rec['isSidechain'] === true || rec['isMeta'] === true) return null
  const message = rec['message'] as Record<string, unknown> | undefined
  if (!message) return null
  const text = textFromContent(message['content']).trim()
  if (!text) return null
  if (text.startsWith('<')) return null // <local-command-*> / <command-name> 之类
  if (text.startsWith('Caveat:')) return null
  return text
}

async function readHead(file: string): Promise<HeadInfo> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return {}
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // 最后一行多半被截断，直接丢。
    if (lines.length > 1) lines.pop()
    const info: HeadInfo = {}
    for (const line of lines) {
      if (!line.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        // 单行超过窗口（大附件）会解析失败，跳过继续找。
        continue
      }
      if (!info.cwd && typeof rec['cwd'] === 'string') info.cwd = rec['cwd']
      if (!info.gitBranch && typeof rec['gitBranch'] === 'string' && rec['gitBranch']) {
        info.gitBranch = rec['gitBranch'] as string
      }
      if (!info.summary) {
        const text = usableUserText(rec)
        if (text) info.summary = text.replace(/\s+/g, ' ').slice(0, 80)
      }
      if (info.cwd && info.summary) break
    }
    return info
  } catch {
    return {}
  } finally {
    await handle.close().catch(() => {})
  }
}

interface Candidate {
  sessionId: string
  file: string
  lastModified: number
}

async function collectCandidates(dirs: string[]): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        const s = await stat(file)
        // 空壳（只写了几行 queue-operation 就退出的）不值一个侧栏条目。
        if (!s.isFile() || s.size < 512) continue
        out.push({ sessionId: name.slice(0, -'.jsonl'.length), file, lastModified: s.mtimeMs })
      } catch {
        /* 文件正被写/已被删，跳过 */
      }
    }
  }
  return out
}

export interface ClaudeSessionListOptions {
  limit: number
  offset: number
  scope: 'project' | 'all'
}

export async function listClaudeSessions(
  cwd: string,
  opts: ClaudeSessionListOptions
): Promise<SessionListItem[]> {
  const root = projectsRoot()
  if (!existsSync(root)) return []

  let dirs: string[]
  if (opts.scope === 'project') {
    const dir = join(root, slugForCwd(cwd))
    if (!existsSync(dir)) return []
    dirs = [dir]
  } else {
    try {
      const entries = await readdir(root, { withFileTypes: true })
      dirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
    } catch {
      return []
    }
  }

  const candidates = (await collectCandidates(dirs)).sort((a, b) => b.lastModified - a.lastModified)
  // 只对真正要展示的那一页读文件头：全量读在会话攒到几百个时是明显卡顿。
  const page = candidates.slice(opts.offset, opts.offset + opts.limit)

  const items: SessionListItem[] = []
  for (const c of page) {
    const head = await readHead(c.file)
    // 一条 user 记录都没有的（纯 queue-operation 空壳）不进列表。
    if (!head.summary) continue
    // 标题优先级与 kimi 侧保持一致：手动重命名 > AI 命名 > 本地记录 > 开场白。
    // 不这么叠的话，用户在侧栏重命名一条 Claude 会话，刷新就被开场白顶回去。
    const displayTitle =
      manualSessionTitle(c.sessionId) ??
      aiSessionTitle(c.sessionId) ??
      localSessionTitle(c.sessionId) ??
      head.summary
    items.push({
      sessionId: c.sessionId,
      agentBackend: 'claude',
      summary: displayTitle,
      lastModified: c.lastModified,
      ...(head.cwd ? { cwd: head.cwd } : {}),
      ...(head.gitBranch ? { gitBranch: head.gitBranch } : {})
    })
  }
  log('claude-history', `listed ${items.length} sessions (scope=${opts.scope})`)
  return items
}

/** 找到某条会话的 jsonl。projects 下按 cwd 分目录，会话可能在任意一个。 */
async function findSessionFile(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{16,64}$/.test(sessionId)) return null
  const root = projectsRoot()
  if (!existsSync(root)) return null
  let dirs: string[]
  try {
    const entries = await readdir(root, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
  } catch {
    return null
  }
  for (const dir of dirs) {
    const file = join(dir, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

/** 回放上限：再长的会话也只渲染最近这么多条，够翻阅又不至于把渲染层压垮。 */
const MAX_REPLAY = 400

/**
 * 读回一条 Claude Code 会话的消息（侧栏点开时的历史回放）。
 *
 * `claude --resume` 只恢复上下文、不重放消息，所以不自己读这个文件的话，点开
 * 一条历史会话是**空白**的——列表有了、进去什么都没有。
 *
 * jsonl 每行的形状与 HistoryMessage 几乎一一对应，挑出 user/assistant 即可。
 * 侧链（子 agent）记录跳过：它们在 Tran 里由工具卡片承载，混进主流水会重复。
 */
export async function readClaudeSessionMessages(sessionId: string): Promise<HistoryMessage[]> {
  const file = await findSessionFile(sessionId)
  if (!file) return []
  const out: HistoryMessage[] = []
  try {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const type = rec['type']
      if (type !== 'user' && type !== 'assistant') continue
      if (rec['isSidechain'] === true || rec['isMeta'] === true) continue
      if (!rec['message']) continue
      out.push({
        type,
        uuid: typeof rec['uuid'] === 'string' ? rec['uuid'] : `${sessionId}-${out.length}`,
        session_id: sessionId,
        message: rec['message'],
        parent_tool_use_id:
          typeof rec['parentToolUseID'] === 'string' ? (rec['parentToolUseID'] as string) : null
      })
      // 边读边裁，长会话（实测有 18MB 的）不必整份留在内存里。
      if (out.length > MAX_REPLAY * 2) out.splice(0, out.length - MAX_REPLAY)
    }
  } catch (error) {
    log('claude-history', `read messages failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const messages = out.length > MAX_REPLAY ? out.slice(-MAX_REPLAY) : out
  log('claude-history', `replayed ${messages.length} messages for ${sessionId}`)
  return messages
}

/**
 * 永久删除一条 Claude Code 会话（侧栏的「删除」）。
 *
 * 之前这条路只走 deleteKimiSession——对 Claude 的 id 当然找不到东西，删完刷新
 * 那一行又回来了。
 *
 * 路径校验从严：只删 projects 根目录下、文件名恰好是 `<sessionId>.jsonl` 的
 * 文件。sessionId 必须长得像 UUID，杜绝 `..` 之类的穿越。
 */
export async function deleteClaudeSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const file = await findSessionFile(sessionId)
  if (!file) return { ok: false, error: '没有找到这条 Claude Code 会话' }
  try {
    await rm(file)
    log('claude-history', `deleted session ${sessionId}`)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
