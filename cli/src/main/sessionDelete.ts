import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { log } from './logger'

/** 会话永久删除（真删除、不留备份）。
 *
 *  kimi 会话存储结构（实测）：
 *  - ~/.kimi-code/sessions/wd_<项目>_<hash>/session_<uuid>/  —— 每会话一个目录
 *    （内含 agents/、state.json 等）
 *  - ~/.kimi-code/session_index.jsonl —— 索引，每行 {sessionId, sessionDir, workDir}
 *
 *  删除 = 移除索引对应行（整文件重写）+ 删除 sessionDir。
 *  安全约束：sessionDir 必须 resolve 在 ~/.kimi-code/sessions/ 内（防路径穿越），
 *  且目录 basename 必须等于 sessionId；索引里查不到时按目录名约定兜底扫描。 */

interface DeleteResult {
  ok: boolean
  error?: string
}

function sessionsRoot(): string {
  return resolve(join(homedir(), '.kimi-code', 'sessions'))
}

function indexPath(): string {
  return join(homedir(), '.kimi-code', 'session_index.jsonl')
}

/** 校验目标目录解析后确实在 sessions 根目录内，返回 resolved 路径或 null。 */
function safeResolveSessionDir(sessionId: string, dir: string): string | null {
  const resolvedDir = resolve(dir)
  const root = sessionsRoot()
  if (resolvedDir === root || !resolvedDir.startsWith(root + sep)) {
    log('session-delete', `refuse path outside sessions root: ${resolvedDir}`)
    return null
  }
  if (basename(resolvedDir) !== sessionId) {
    log('session-delete', `refuse dir name mismatch: ${resolvedDir} != ${sessionId}`)
    return null
  }
  return resolvedDir
}

function deleteDir(sessionId: string, dir: string): string | null {
  const resolvedDir = safeResolveSessionDir(sessionId, dir)
  if (!resolvedDir) return '路径校验失败，拒绝删除'
  try {
    rmSync(resolvedDir, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function deleteKimiSession(sessionId: string): DeleteResult {
  // sessionId 形式校验（kimi 生成的固定格式，防注入）。
  if (!/^session_[\w-]+$/.test(sessionId)) return { ok: false, error: '非法会话 ID' }

  // 1) 索引：移除对应行并拿到 sessionDir（整文件重写，先写临时文件再 rename）。
  let sessionDir: string | null = null
  try {
    const lines = readFileSync(indexPath(), 'utf8').split(/\r?\n/)
    const kept: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: { sessionId?: unknown; sessionDir?: unknown } | null = null
      try {
        entry = JSON.parse(trimmed) as { sessionId?: unknown; sessionDir?: unknown }
      } catch {
        entry = null
      }
      if (entry?.sessionId === sessionId) {
        if (typeof entry.sessionDir === 'string') sessionDir = entry.sessionDir
        continue // 移除该行
      }
      kept.push(trimmed)
    }
    const tmp = `${indexPath()}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, indexPath())
  } catch (error) {
    return { ok: false, error: `索引更新失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 2) 索引里没有 sessionDir 时按目录约定兜底（sessions/wd_*/sessionId）。
  if (!sessionDir) {
    try {
      for (const wd of readdirSync(sessionsRoot(), { withFileTypes: true })) {
        if (!wd.isDirectory()) continue
        const candidate = join(sessionsRoot(), wd.name, sessionId)
        if (existsSync(candidate)) {
          sessionDir = candidate
          break
        }
      }
    } catch {
      /* 根目录不可读就放弃兜底 */
    }
  }

  // 3) 删目录（严格路径校验）；索引行已移除，目录不存在也视为成功。
  if (sessionDir && existsSync(sessionDir)) {
    const error = deleteDir(sessionId, sessionDir)
    if (error) return { ok: false, error: `删除会话目录失败：${error}` }
  }
  log('session-delete', `deleted ${sessionId}`)
  return { ok: true }
}
