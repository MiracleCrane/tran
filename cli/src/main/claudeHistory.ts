import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './logger'
import { normalizeCwdForCompare } from '../shared/paths'
import type { SessionListItem } from '../shared/ipc'

/**
 * Claude Code 的会话历史（磁盘直读）。
 *
 * 实测（v2.1.220）落盘布局：
 *
 *   ~/.claude/projects/<cwd 编码>/<session-uuid>.jsonl
 *
 * 目录名就是把 cwd 里的 `/` 全换成 `-`：
 *   /tmp/a/b            → -tmp-a-b
 *   /home/user/tran     → -home-user-tran
 *
 * ⚠️ Windows 路径的编码规则**未实测**（本机是 Linux）。按同样规则推断
 * `D:\proj\foo` → `D--proj-foo`（盘符冒号也换成 `-`），因此下面同时按
 * 「正反斜杠都换成 `-`」和「去掉盘符冒号」两种候选去找，命中哪个用哪个。
 * 若你在 Windows 上发现历史列表为空，把实际目录名贴出来即可对齐。
 *
 * jsonl 每行一个事件，type 有 user / assistant / attachment / queue-operation
 * 等；带 cwd、timestamp、sessionId。列表摘要取第一条 external 用户消息。
 */

const MAX_SCAN_LINES = 400
const SUMMARY_MAX = 80

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** cwd → 目录名的候选（Windows 编码未实测，给多个候选）。 */
function encodedDirCandidates(cwd: string): string[] {
  const slashed = cwd.replace(/\\/g, '/')
  const base = slashed.replace(/\//g, '-')
  const noColon = base.replace(/:/g, '')
  const colonDashed = base.replace(/:/g, '-')
  return [...new Set([base, noColon, colonDashed])]
}

function firstUserText(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n', MAX_SCAN_LINES)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (entry.type !== 'user' || entry.userType !== 'external') continue
      const message = entry.message as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
      if (Array.isArray(content)) {
        for (const part of content) {
          const rec = part as { type?: string; text?: string }
          // tool_result 也是 user 消息，不能当摘要。
          if (rec?.type === 'text' && typeof rec.text === 'string') {
            return rec.text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
          }
        }
      }
    }
  } catch (error) {
    log('claude-history', `读取失败 ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return ''
}

/** 列出某工作目录下的 Claude Code 会话（按最近修改倒序）。 */
export function listClaudeSessions(
  cwd: string,
  opts: { limit?: number; offset?: number; scope?: 'project' | 'all' } = {}
): SessionListItem[] {
  const root = projectsRoot()
  if (!existsSync(root)) return []

  const wanted = new Set(encodedDirCandidates(cwd))
  const all = opts.scope === 'all'
  const items: SessionListItem[] = []

  let dirs: string[]
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  for (const dir of dirs) {
    if (!all && !wanted.has(dir)) continue
    const dirPath = join(root, dir)
    let files: string[]
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const full = join(dirPath, file)
      let lastModified = 0
      let size = 0
      try {
        const st = statSync(full)
        lastModified = st.mtimeMs
        size = st.size
      } catch {
        continue
      }
      // 空壳会话（只有 queue-operation 之类的元事件）不进列表。
      if (size < 200) continue
      const summary = firstUserText(full)
      if (!summary) continue
      items.push({
        sessionId: file.replace(/\.jsonl$/, ''),
        agentBackend: 'claude',
        summary,
        lastModified,
        cwd
      })
    }
  }

  items.sort((a, b) => b.lastModified - a.lastModified)
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50
  return items.slice(offset, offset + limit)
}

/** 会话文件路径（删除/读取用）。找不到返回 null。 */
export function claudeSessionPath(sessionId: string, cwd: string): string | null {
  const root = projectsRoot()
  for (const dir of encodedDirCandidates(cwd)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  // 兜底：跨目录找（cwd 编码规则在 Windows 上未实测，别因为编码不对就说没有）。
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const candidate = join(root, d.name, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 同 cwd 归一化比较（供调用方判断会话是否属于当前项目）。 */
export function sameProject(a: string, b: string): boolean {
  return normalizeCwdForCompare(a) === normalizeCwdForCompare(b)
}
