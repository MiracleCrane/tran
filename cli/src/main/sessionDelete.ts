import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { log } from './logger'
import { kimiHome, kimiSessionIndexPath, kimiSessionsRoot } from './kimiHome'

/** 会话永久删除（真删除、不留备份）。
 *
 *  kimi 会话存储结构（实测）：
 *  - $KIMI_CODE_HOME/sessions/wd_<项目>_<hash>/session_<uuid>/ —— 每会话一个目录
 *    （内含 agents/、state.json 等）
 *  - $KIMI_CODE_HOME/session_index.jsonl —— 索引，每行 {sessionId, sessionDir, workDir}
 *
 *  路径一律走 kimiHome()：写死 ~/.kimi-code 会在 home 被 KIMI_CODE_HOME 重定向
 *  时操作到一份过期副本——全程不报错，却对 kimi 正在用的数据毫无影响，表现就是
 *  「删除会话删不掉」（见 kimiHome.ts）。
 *
 *  删除 = 移除索引对应行（整文件重写）+ 删除 sessionDir。
 *  安全约束：sessionDir 必须 resolve 在 sessions 根内（防路径穿越），且目录
 *  basename 必须等于 sessionId；索引里查不到时按目录名约定兜底扫描。 */

interface DeleteResult {
  ok: boolean
  error?: string
  /** 索引与目录都找不到（区别于真失败）：用于触发旧 home 回退。 */
  notFound?: boolean
}

function sessionsRoot(home: string): string {
  return resolve(join(home, 'sessions'))
}

function indexPath(home: string): string {
  return join(home, 'session_index.jsonl')
}

/** 校验目标目录解析后确实在 sessions 根目录内，返回 resolved 路径或 null。 */
function safeResolveSessionDir(home: string, sessionId: string, dir: string): string | null {
  const resolvedDir = resolve(dir)
  const root = sessionsRoot(home)
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

async function deleteDir(home: string, sessionId: string, dir: string): Promise<string | null> {
  const resolvedDir = safeResolveSessionDir(home, sessionId, dir)
  if (!resolvedDir) return '路径校验失败，拒绝删除'
  try {
    // 异步删：大转录目录 rmSync 会把主进程冻住几秒（UI 全卡）。
    await rm(resolvedDir, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function deleteKimiSessionFrom(home: string, sessionId: string): Promise<DeleteResult> {
  // 1) 索引：移除对应行并拿到 sessionDir（整文件重写，先写临时文件再 rename）。
  let sessionDir: string | null = null
  let removedIndexLine = false
  try {
    const lines = readFileSync(indexPath(home), 'utf8').split(/\r?\n/)
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
        removedIndexLine = true
        continue // 移除该行
      }
      kept.push(trimmed)
    }
    const tmp = `${indexPath(home)}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, indexPath(home))
  } catch (error) {
    return { ok: false, error: `索引更新失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 2) 索引里没有 sessionDir 时按目录约定兜底（sessions/wd_*/sessionId）。
  if (!sessionDir) {
    try {
      for (const wd of readdirSync(sessionsRoot(home), { withFileTypes: true })) {
        if (!wd.isDirectory()) continue
        const candidate = join(sessionsRoot(home), wd.name, sessionId)
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
  let removedDir = false
  if (sessionDir && existsSync(sessionDir)) {
    const error = await deleteDir(home, sessionId, sessionDir)
    if (error) return { ok: false, error: `删除会话目录失败：${error}` }
    removedDir = true
  }

  // 索引里没有、目录也找不到 = 这个 home 下压根没有这个会话，什么都没删掉。
  // 以前这里照样返回成功，UI 提示"已删除"而列表纹丝不动（session/list 走的是
  // 真 home），用户只能反复点删除——必须如实报错，别再假装成功。
  if (!removedIndexLine && !removedDir) {
    log('session-delete', `not found in ${sessionsRoot(home)}: ${sessionId}`)
    return { ok: false, notFound: true, error: `会话不在当前 kimi 数据目录中，未删除任何内容（${sessionsRoot(home)}）` }
  }
  log('session-delete', `deleted ${sessionId} from ${home}`)
  return { ok: true }
}

export async function deleteKimiSession(sessionId: string): Promise<DeleteResult> {
  // sessionId 形式校验（kimi 生成的固定格式，防注入）。
  if (!/^session_[\w-]+$/.test(sessionId)) return { ok: false, error: '非法会话 ID' }

  const result = await deleteKimiSessionFrom(kimiHome(), sessionId)
  if (!result.notFound) return result
  // 旧 home 回退（2026-08-14 实测）：KIMI_CODE_HOME 重定向之前创建的会话还在
  // 默认的 ~/.kimi-code 里，kimi 的 session/list 两个 home 都会列，但上面的
  // 删除只查新 home——表现为「归档里删不掉」。当前 home 明确找不到时再去旧
  // home 试；顺序不能反（新 home 是 kimi 正在写的真值）。
  const legacy = join(homedir(), '.kimi-code')
  if (resolve(legacy) === resolve(kimiHome())) return result
  const legacyResult = await deleteKimiSessionFrom(legacy, sessionId)
  // 两个 home 都没有 = 已经不在了——归档页清理残留条目靠的就是「再删一次」，
  // 报失败会让幽灵条目永远挂着（2026-08-14：旧 home 删过的会话在归档页再删
  // 又报"删除失败"）。kimi 只读这两个 home，缺席即目标态达成，按成功返回。
  if (legacyResult.notFound) {
    log('session-delete', `absent in both homes, treat as deleted: ${sessionId}`)
    return { ok: true }
  }
  return legacyResult
}

/** 孤儿目录清扫：删除 sessions 根下**不在索引里**的 session_* 目录。
 *
 *  来源：Tran 删除空壳后，仍在跑的 kimi ACP 进程会异步重建目录壳（只有空的
 *  agents/ 子目录，无 state.json、无索引行）；进程被强杀时也会留下残骸。
 *  这些目录不进 session/list（kimi 按索引列举），对 UI 不可见，但会占磁盘。
 *
 *  安全约束：只删 mtime 超过 1 小时的目录——kimi 先建目录后写索引，新目录
 *  可能还没来得及入索引，时间窗兜底避免误删别的 kimi 实例的活跃会话。 */
export async function sweepOrphanSessionDirs(maxAgeMs = 60 * 60 * 1000): Promise<void> {
  try {
    const indexed = new Set<string>()
    try {
      for (const line of readFileSync(kimiSessionIndexPath(), 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed) as { sessionId?: unknown }
          if (typeof entry.sessionId === 'string') indexed.add(entry.sessionId)
        } catch { /* 跳过坏行 */ }
      }
    } catch (error) {
      // 索引读不到（Windows 上杀软/备份占用导致 EBUSY/EPERM 很常见）绝不能
      // 当成"空索引"：那会把所有超过时间窗的正常会话目录都当孤儿真删。
      // 与 settings.ts 同一防线：读失败禁止任何破坏性写/删，放弃本次清扫。
      log('session-delete', `sweep skipped, index unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const cutoff = Date.now() - maxAgeMs
    let swept = 0
    // 孤儿清扫只动当前 home（重定向后 kimi 正在写的那一份）。
    const root = resolve(kimiSessionsRoot())
    for (const wd of readdirSync(root, { withFileTypes: true })) {
      if (!wd.isDirectory()) continue
      const wdDir = join(root, wd.name)
      for (const entry of readdirSync(wdDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^session_[\w-]+$/.test(entry.name)) continue
        if (indexed.has(entry.name)) continue
        const dir = join(wdDir, entry.name)
        try {
          if (statSync(dir).mtimeMs > cutoff) continue
          await rm(dir, { recursive: true, force: true })
          swept++
        } catch { /* 单个失败不阻塞整体清扫 */ }
      }
    }
    if (swept) log('session-delete', `swept ${swept} orphan session dir(s)`)
  } catch (error) {
    log('session-delete', `sweep failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
