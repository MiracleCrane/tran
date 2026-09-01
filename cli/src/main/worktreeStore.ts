import { app } from 'electron'
import { join } from 'node:path'
import { log } from './logger'
import { readJsonSafe, writeFileAtomic } from './atomicWrite'
import { normalizeCwdForCompare } from '../shared/paths'
import * as git from './git'
import type { WorktreeRecord } from '../shared/ipc'

/**
 * worktree 台账（2026-09-01 Codex 化第 4 期，逐线程 opt-in 的 git worktree
 * 隔离）：git.ts 负责纯 git 操作，这里登记「哪个 worktree 属于哪个项目/
 * 会话」——userData/worktrees.json，键 = 归一化 worktree 路径。
 *
 * sessionKey 在会话 init 拿到 sdkSessionId 后才存在（懒创建语义），由渲染层
 * 经 forge:worktreeBindSession 回填；从没发过消息的懒会话条目 sessionKey
 * 为空，属正常。
 *
 * 读盘失败走只读防线（与 session-projects.json 同一约定：空表写回等于把
 * 台账一次性抹掉）。
 */

let cache: Record<string, WorktreeRecord> | null = null
let loadFailed = false

function storePath(): string {
  return join(app.getPath('userData'), 'worktrees.json')
}

function keyOf(path: string): string {
  return normalizeCwdForCompare(path)
}

function load(): Record<string, WorktreeRecord> {
  if (cache) return cache
  const read = readJsonSafe<unknown>(storePath())
  if (read.status === 'failed') {
    log('worktrees', `worktrees.json 读取失败，本次运行不再写入：${read.error.message}`)
    cache = {}
    loadFailed = true
    return cache
  }
  const raw = read.status === 'ok' ? read.value : null
  if (read.status === 'ok' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    log('worktrees', 'worktrees.json 内容不是对象，本次运行不再写入')
    cache = {}
    loadFailed = true
    return cache
  }
  // 逐条校验形状：坏条目丢弃而不是连累整张表。
  const out: Record<string, WorktreeRecord> = {}
  for (const [key, entry] of Object.entries((raw as Record<string, unknown> | null) ?? {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const r = entry as Record<string, unknown>
    if (typeof r.path !== 'string' || typeof r.repoRoot !== 'string' || typeof r.branch !== 'string') continue
    if (typeof r.projectId !== 'string') continue
    out[key] = {
      path: r.path,
      repoRoot: r.repoRoot,
      projectId: r.projectId,
      branch: r.branch,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : 0,
      ...(typeof r.sessionKey === 'string' ? { sessionKey: r.sessionKey } : {})
    }
  }
  cache = out
  return cache
}

function save(): void {
  if (loadFailed) return
  try {
    writeFileAtomic(storePath(), JSON.stringify(load(), null, 1))
  } catch (error) {
    log('worktrees', `save failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 存档损坏（只读模式）时抛错：让渲染层知道登记没成功（同 sessionProjects）。 */
function assertWritable(): void {
  if (loadFailed) {
    throw new Error('worktree 台账文件损坏，本次运行该功能只读（重启 Tran 可尝试重建）')
  }
}

/** 全量台账（渲染层徽章/删除联动用）。返回拷贝，外部改不动缓存。 */
export function listWorktreeRecords(): WorktreeRecord[] {
  return Object.values(load()).map((r) => ({ ...r }))
}

/** 建 worktree 并登记台账。git 成功但台账写不进去（只读模式）时抛错——
 *  目录已落盘，由用户手工处置或下次启动的僵尸清理由 git 侧兜底（目录本身
 *  仍在 git worktree list 里，不会被误清）。 */
export async function createWorktreeRecord(
  repoRoot: string,
  projectId: string,
  name: string
): Promise<WorktreeRecord> {
  const { path, branch } = await git.createWorktree(repoRoot, name)
  assertWritable()
  const now = Date.now()
  const record: WorktreeRecord = { path, repoRoot, projectId, branch, createdAt: now, lastUsedAt: now }
  load()[keyOf(path)] = record
  save()
  log('worktrees', `创建 worktree：${path}（${branch}，项目 ${projectId}）`)
  return { ...record }
}

/** 删 worktree 并清台账。git 侧拒绝（未提交改动且非 force）时台账保留。 */
export async function removeWorktreeRecord(path: string, opts: { force?: boolean } = {}): Promise<void> {
  const store = load()
  const entry = store[keyOf(path)]
  if (!entry) throw new Error(`该目录不在 worktree 台账中：${path}`)
  await git.removeWorktree(entry.repoRoot, entry.path, opts)
  assertWritable()
  delete store[keyOf(path)]
  save()
  log('worktrees', `删除 worktree：${entry.path}`)
}

/** 会话 init 拿到 sdkSessionId 后回填 sessionKey + 刷新 lastUsedAt。
 *  条目可能已被删/从未登记（并行时序），静默跳过——回填是尽力而为。 */
export function bindWorktreeSession(path: string, sessionKey: string): void {
  const store = load()
  const entry = store[keyOf(path)]
  if (!entry) return
  entry.sessionKey = sessionKey
  entry.lastUsedAt = Date.now()
  save()
}

/** 启动时清僵尸台账（挂 main/index.ts 启动清理块）：台账有、
 *  `git worktree list` 没有的条目（用户手工删了目录 / git worktree prune 过）。
 *  仓库本身读不了（已删除/暂时不可达）时该仓库的条目整条保留——读不出来
 *  不等于不存在，不抹数据。只读模式（存档损坏）下整体跳过。 */
export async function pruneWorktreeRecords(): Promise<void> {
  if (loadFailed) return
  try {
    const store = load()
    const entries = Object.entries(store)
    if (!entries.length) return
    const byRepo = new Map<string, Array<[string, WorktreeRecord]>>()
    for (const kv of entries) {
      const list = byRepo.get(kv[1].repoRoot) ?? []
      list.push(kv)
      byRepo.set(kv[1].repoRoot, list)
    }
    let dropped = 0
    for (const [repoRoot, list] of byRepo) {
      let live: Set<string>
      try {
        live = new Set((await git.listWorktrees(repoRoot)).map((w) => keyOf(w.path)))
      } catch (error) {
        log('worktrees', `僵尸清理跳过 ${repoRoot}（worktree list 失败：${error instanceof Error ? error.message : String(error)}）`)
        continue
      }
      for (const [key] of list) {
        if (!live.has(key)) {
          delete store[key]
          dropped++
        }
      }
    }
    if (dropped > 0) {
      save()
      log('worktrees', `清理 ${dropped} 条僵尸 worktree 台账`)
    }
  } catch (error) {
    // 清理失败不影响启动，残留条目下轮再清。
    log('worktrees', `僵尸清理失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
