import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { GitBranchInfo, GitCommit, GitFileChange, GitStatus, GitWorkingChanges } from '../shared/ipc'
import { normalizeCwdForCompare } from '../shared/paths'
import { log } from './logger'

/**
 * 单次 git 调用的输出上限。
 *
 * `git diff` 的体量完全由仓库决定：重新生成的 lockfile、误提交的构建产物、
 * 压缩包，随手就是几十上百 MB。全量缓冲会在主进程里堆成同样大的字符串，
 * 再原样过 IPC 塞给渲染层——主进程内存暴涨、序列化把界面卡死。
 * 超限即停读并标记截断：diff 视图本来也只看前面几屏。
 */
const MAX_GIT_OUTPUT_CHARS = 2 * 1024 * 1024
const TRUNCATION_NOTICE = '\n[输出超过 2MB，已截断]'

/** 只读查询（status/diff/log…）加 --no-optional-locks：默认的 git status 会
 *  顺手刷新并**写**索引，Tran 在旁边轮询时会和 agent 自己跑的 git 抢
 *  index.lock，让 agent 侧报 "Unable to create '.git/index.lock': File exists"。
 *  这个全局选项让只读命令不碰锁。 */
const READ_ONLY_GIT_FLAGS = ['--no-optional-locks']

/** Run a git command. Returns { stdout, stderr } or throws on non-zero exit. */
function runGit(cwd: string, args: string[], timeout = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let out = ''
    let err = ''
    let truncated = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`git ${args.join(' ')} timed out after ${timeout}ms`))
    }, timeout)

    // setEncoding 让 Node 用 StringDecoder 处理跨 chunk 的 UTF-8 多字节边界：
    // 逐 chunk d.toString() 时，中文路径/内容恰好切在边界上必出 U+FFFD 乱码。
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (out.length >= MAX_GIT_OUTPUT_CHARS) return
      out += d
      if (out.length >= MAX_GIT_OUTPUT_CHARS) {
        out = out.slice(0, MAX_GIT_OUTPUT_CHARS) + TRUNCATION_NOTICE
        truncated = true
        // 上游还在写就让它写完（提前关管道会给 git 一个 EPIPE/非零退出），
        // 只是不再往缓冲里堆。
      }
    })
    child.stderr.on('data', (d: string) => {
      if (err.length < 64 * 1024) err += d
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: out.trim(), stderr: err.trim() })
      else if (truncated) {
        // 已经截断说明拿到的内容够用了：此时的非零退出码多半来自下游写管道
        // 失败之类的次要原因，不该让整个 diff 视图报错。
        resolve({ stdout: out.trim(), stderr: err.trim() })
      } else {
        const details = [err.trim(), out.trim()].filter(Boolean).join('\n')
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${details}`))
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/** Check if a directory is a git repo. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/** Get current branch name, or null if detached/not a repo. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout === 'HEAD' ? null : stdout || null
  } catch (e: unknown) {
    log('git', `getCurrentBranch failed cwd=${cwd}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/** List all local branches. */
export async function listBranches(cwd: string): Promise<GitBranchInfo[]> {
  try {
    const current = await getCurrentBranch(cwd)
    const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'branch', '--format=%(refname:short)'])
    return stdout.split('\n').filter(Boolean).map((name) => ({
      name,
      current: name === current
    }))
  } catch {
    return []
  }
}

/**
 * 拒绝以 `-` 开头的 ref：git 会把它当成选项而不是分支名/提交号
 * （如 `-D`、`--upload-pack=...`）。spawn 不经 shell，所以这不是 shell 注入，
 * 但仍是实打实的参数注入。
 *
 * 不用 `--` 分隔是因为各子命令语义不一致——`git checkout -- <name>` 表示
 * 「从索引恢复该路径的文件」，而不是切分支，加上去会直接改坏功能
 * （已用 git 2.43 实测）。校验入参是唯一对所有子命令都安全的做法。
 */
function assertRef(value: string, label: string): string {
  const ref = value.trim()
  if (!ref) throw new Error(`${label}不能为空`)
  if (ref.startsWith('-')) throw new Error(`${label}不能以 - 开头：${ref}`)
  return ref
}

/** Switch to a branch (checkout). */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await runGit(cwd, ['checkout', assertRef(branch, '分支名')])
}

/** Create a new branch. */
export async function createBranch(cwd: string, name: string): Promise<void> {
  await runGit(cwd, ['branch', assertRef(name, '分支名')])
}

/** Delete a local branch (force if requested). */
export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  await runGit(cwd, ['branch', force ? '-D' : '-d', assertRef(name, '分支名')])
}

/** git pull. */
export async function pull(cwd: string): Promise<{ stdout: string; stderr: string }> {
  return runGit(cwd, ['pull'], 30_000)
}

/** git push. */
export async function push(cwd: string): Promise<{ stdout: string; stderr: string }> {
  return runGit(cwd, ['push'], 30_000)
}

/** Count commits the local branch is ahead/behind its upstream. Returns nulls
 *  when there is no upstream (detached HEAD, local-only branch, …). */
async function getAheadBehind(cwd: string): Promise<{ ahead: number | null; behind: number | null }> {
  try {
    // left = upstream-only (we are behind), right = HEAD-only (we are ahead)
    const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
    const [behind, ahead] = stdout.split(/\s+/).map((n) => Number(n))
    return {
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null
    }
  } catch {
    return { ahead: null, behind: null }
  }
}

/** Get working tree status, parsed from porcelain -z. Unlike the line-based
 *  form, -z never quotes paths (so spaces / special chars survive intact) and
 *  puts each entry behind a NUL — which is what lets us also read rename
 *  source-paths (a second NUL token) and classify per the XY status pair.
 *
 *  抛错版本：调用方要么容错（getStatus 的轮询），要么需要区分"干净"和
 *  "读不出来"（commit 的前置检查）。 */
async function readStatus(cwd: string): Promise<Omit<GitStatus, 'ahead' | 'behind'>> {
  const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'status', '--porcelain', '-z'])
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []
  const conflicts: string[] = []

  // -z separates entries with NUL. A rename/copy entry occupies TWO tokens
  // (new path, then source path); every other entry is a single token.
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry) continue
    const x = entry[0] // index (staged) status
    const y = entry[1] // worktree (unstaged) status
    const path = entry.slice(3)
    if ((x === 'R' || x === 'C') && i + 1 < tokens.length) i++ // consume source-path token

    if (x === '?' && y === '?') {
      untracked.push(path)
    } else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      conflicts.push(path)
    } else {
      // A file can be both staged and unstaged (e.g. MM) — check each side.
      if (x !== ' ' && x !== '?') staged.push(path)
      if (y !== ' ' && y !== '?') unstaged.push(path)
    }
  }

  const clean = !staged.length && !unstaged.length && !untracked.length && !conflicts.length
  return { staged, unstaged, untracked, conflicts, clean }
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = {
    staged: [], unstaged: [], untracked: [], conflicts: [],
    clean: true, ahead: null, behind: null
  }
  try {
    const status = await readStatus(cwd)
    const { ahead, behind } = await getAheadBehind(cwd)
    return { ...status, ahead, behind }
  } catch {
    return empty
  }
}

/** git add (paths or '.' for all). */
export async function add(cwd: string, paths?: string[]): Promise<void> {
  const args = ['add']
  // `--` 把路径与选项分开：文件名以 `-` 开头（`-foo.txt`、agent 生成的临时文件）
  // 会被 git 当成选项解析。add 的 `--` 语义就是「后面全是路径」，加上是安全的
  // （不同于 checkout —— 那里 `--` 会把切分支变成恢复文件，见 assertRef 注释）。
  if (paths && paths.length > 0) args.push('--', ...paths)
  else args.push('.')
  await runGit(cwd, args)
}

/** git commit with message. */
export async function commit(cwd: string, message: string): Promise<void> {
  // 走 readStatus（会抛）而不是 getStatus（吞错回空）：`git status` 失败时
  // getStatus 报的是"干净的空状态"，于是 index.lock 被 agent 占着的时候，
  // 用户看到的提示是"没有已暂存的改动"——完全指错方向。
  let status: Omit<GitStatus, 'ahead' | 'behind'>
  try {
    status = await readStatus(cwd)
  } catch (error) {
    throw new Error(
      `无法读取仓库状态，提交已中止：${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (status.conflicts.length > 0) {
    throw new Error('存在冲突文件，请先解决冲突后再提交。')
  }
  if (status.staged.length === 0) {
    throw new Error('没有已暂存的改动，请先暂存要提交的文件。')
  }
  await runGit(cwd, ['commit', '-m', message])
}

/** Get recent commits. */
export async function logCommits(cwd: string, limit = 20): Promise<GitCommit[]> {
  try {
    const fmt = '%H%n%h%n%s%n%an%n%at'
    const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'log', `--max-count=${limit}`, '--format=' + fmt])
    const lines: string[] = []
    for (const l of stdout.split('\n')) lines.push(l)

    const commits: GitCommit[] = []
    for (let i = 0; i + 4 < lines.length; i += 5) {
      commits.push({
        hash: lines[i],
        shortHash: lines[i + 1],
        message: lines[i + 2],
        author: lines[i + 3],
        date: Number(lines[i + 4]) * 1000 // unix seconds → ms
      })
    }
    return commits
  } catch {
    return []
  }
}

/** git stash operations. */
export async function stash(cwd: string, action = 'push', message?: string): Promise<string> {
  if (action === 'list') {
    const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'stash', 'list'])
    return stdout || ''
  }
  if (action === 'pop') {
    const { stdout } = await runGit(cwd, ['stash', 'pop'])
    return stdout
  }
  // push
  const args: string[] = ['stash', 'push']
  if (message) args.push('-m', message)
  const { stdout } = await runGit(cwd, args)
  return stdout
}

/** git revert a commit. */
export async function revert(cwd: string, commitHash: string): Promise<void> {
  await runGit(cwd, ['revert', '--no-edit', assertRef(commitHash, '提交号')])
}

/** Unified diff of unstaged changes; pass staged=true for already-staged
 *  changes, and paths to limit to specific files. Returns the raw diff text. */
export async function diff(
  cwd: string,
  opts: { staged?: boolean; paths?: string[] } = {}
): Promise<string> {
  const args = [...READ_ONLY_GIT_FLAGS, 'diff']
  if (opts.staged) args.push('--cached')
  if (opts.paths && opts.paths.length) args.push('--', ...opts.paths)
  const { stdout } = await runGit(cwd, args)
  return stdout
}

/** git fetch — update remote-tracking refs without merging. */
export async function fetch(cwd: string): Promise<{ stdout: string; stderr: string }> {
  return runGit(cwd, ['fetch'], 60_000)
}

/* ------------------------------------------------------------------ */
/* 会话级改动视图（Changes 面板）：工作区相对 HEAD 的全部改动聚合。       */
/* ------------------------------------------------------------------ */

/** 路径入参校验（渲染层回传的路径最终来自我们自己的 status 输出，但仍要挡
 *  以 - 开头的选项注入与 NUL；不做存在性检查——删除态的文件本来就不在）。 */
function assertPath(value: string): string {
  const p = value.trim()
  if (!p) throw new Error('路径不能为空')
  if (p.startsWith('-')) throw new Error(`路径不能以 - 开头：${p}`)
  if (p.includes('\0')) throw new Error('路径包含非法字符')
  return p
}

/** 把 repo 相对路径解析到 cwd 内的绝对路径；越界（../、绝对路径）直接拒绝。
 *  git 自己的命令天然被仓库边界约束，这层校验保护的是我们**自己**的 fs 读写。 */
function resolveInsideCwd(cwd: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error('只接受仓库内的相对路径')
  const abs = resolve(cwd, relPath)
  const root = resolve(cwd)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`路径越出项目目录：${relPath}`)
  return abs
}

/** HEAD 是否存在（空仓库首个 commit 之前没有）。 */
async function hasHead(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'rev-parse', '--verify', '-q', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * 空树对象的固定 hash（所有 git 仓库都一样）。
 *
 * 空仓库（还没有任何 commit）里没有 HEAD 可比：不给基准的话 `git diff` 比的是
 * 索引↔工作区,已暂存的文件会显示成"无改动"——而在用户眼里它们全都是新增的。
 * 拿空树当基准就能得到"相对于什么都没有"的 diff,正是这时候想看的东西。
 */
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** diff 的基准：有 HEAD 用 HEAD,空仓库用空树。 */
async function diffBase(cwd: string): Promise<string> {
  return (await hasHead(cwd)) ? 'HEAD' : EMPTY_TREE_HASH
}

/** 首 8KB 含 NUL 即视为二进制（与 git 同判据）。 */
async function sniffBinary(absPath: string): Promise<boolean> {
  const handle = await fsp.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/** 解析 `git status --porcelain -z`，每个文件归并成单条记录（MM 这类
 *  暂存+未暂存并存的只出一条）。与 readStatus 的分桶视角不同，这里是
 *  Changes 面板要的"文件清单"视角。 */
async function readChangeEntries(
  cwd: string
): Promise<Array<Pick<GitFileChange, 'path' | 'oldPath' | 'status'>>> {
  const { stdout } = await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'status', '--porcelain', '-z'])
  const entries: Array<Pick<GitFileChange, 'path' | 'oldPath' | 'status'>> = []
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    let oldPath: string | undefined
    if ((x === 'R' || x === 'C') && i + 1 < tokens.length) {
      oldPath = tokens[++i]
    }
    let status: GitFileChange['status']
    if (x === '?' && y === '?') status = 'untracked'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'conflicted'
    else if (x === 'R' || x === 'C') status = 'renamed'
    else if (x === 'A' || y === 'A') status = 'added'
    else if (x === 'D' || y === 'D') status = 'deleted'
    else status = 'modified'
    // 未跟踪目录（形如 `.temp/`）不进面板：目录条目点开没有 diff 可看，
    // 只会吃一条「加载失败」（2026-09-01 用户截图）。文件删除后目录条目
    // 自然消失，无需进一步处理。
    if (status === 'untracked' && path.endsWith('/')) continue
    entries.push({ path, ...(oldPath ? { oldPath } : {}), status })
  }
  return entries
}

/** 解析 `git diff --numstat -z` 输出 → path → {additions, deletions, binary}。
 *  -z 下重命名条目形如 `add\tdel\t\0old\0new\0`（路径域为空，后跟两个 NUL 段）。 */
function parseNumstat(stdout: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>()
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    if (!entry) continue
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry)
    if (!m) continue
    const additions = m[1] === '-' ? null : Number(m[1])
    const deletions = m[2] === '-' ? null : Number(m[2])
    let path = m[3]
    if (!path && i + 2 < tokens.length) {
      // 重命名：跳过 old，取 new
      i++
      path = tokens[++i]
    }
    if (path) map.set(path, { additions, deletions })
  }
  return map
}

/** 未跟踪文件的行数（作为"全新增"展示）。超 1MB 或二进制不数。 */
async function countUntrackedLines(absPath: string): Promise<{ additions: number | null; binary: boolean }> {
  try {
    const stat = await fsp.stat(absPath)
    if (!stat.isFile() || stat.size > 1024 * 1024) return { additions: null, binary: false }
    if (await sniffBinary(absPath)) return { additions: null, binary: true }
    if (stat.size === 0) return { additions: 0, binary: false }
    const text = await fsp.readFile(absPath, 'utf8')
    const lines = text.split('\n')
    return { additions: text.endsWith('\n') ? lines.length - 1 : lines.length, binary: false }
  } catch {
    return { additions: null, binary: false }
  }
}

/** 工作区改动聚合：status 清单 + numstat 行数（相对 HEAD，暂存/未暂存合并视角），
 *  未跟踪文件读盘数行。空仓库（无 HEAD）退化为相对空索引的 numstat。 */
export async function getWorkingChanges(cwd: string): Promise<GitWorkingChanges> {
  const entries = await readChangeEntries(cwd)
  let numstat = new Map<string, { additions: number | null; deletions: number | null }>()
  if (entries.some((e) => e.status !== 'untracked')) {
    try {
      const args = [...READ_ONLY_GIT_FLAGS, 'diff', '--numstat', '-z', '-M', await diffBase(cwd)]
      const { stdout } = await runGit(cwd, args)
      numstat = parseNumstat(stdout)
    } catch (e) {
      log('git', `numstat failed cwd=${cwd}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const files: GitFileChange[] = []
  for (const entry of entries) {
    if (entry.status === 'untracked') {
      let counted: { additions: number | null; binary: boolean } = { additions: null, binary: false }
      try {
        counted = await countUntrackedLines(resolveInsideCwd(cwd, entry.path))
      } catch {
        /* 越界/读失败 → 不数 */
      }
      files.push({ ...entry, additions: counted.additions, deletions: counted.additions === null ? null : 0, binary: counted.binary })
    } else {
      const stat = numstat.get(entry.path)
      files.push({
        ...entry,
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
        binary: stat ? stat.additions === null && stat.deletions === null : false
      })
    }
  }
  // 排序：冲突最前，其余按路径
  files.sort((a, b) => (a.status === 'conflicted' ? -1 : 0) - (b.status === 'conflicted' ? -1 : 0) || a.path.localeCompare(b.path))
  let totalAdditions = 0
  let totalDeletions = 0
  for (const f of files) {
    totalAdditions += f.additions ?? 0
    totalDeletions += f.deletions ?? 0
  }
  return { files, totalAdditions, totalDeletions }
}

/** 单文件相对基准（HEAD / 空树）的完整 diff。未跟踪文件合成 unified diff
 *  （git diff 不认识它们）；二进制/超大文件返回占位说明。
 *
 *  重命名要把**两个**路径都交给 git：只给新路径的话 pathspec 会把旧路径滤掉，
 *  rename 检测失效，一次重命名会显示成"整文件新增"。 */
export async function getFileDiff(
  cwd: string,
  relPath: string,
  opts: { untracked?: boolean; oldPath?: string } = {}
): Promise<string> {
  const p = assertPath(relPath)
  if (opts.untracked) {
    const abs = resolveInsideCwd(cwd, p)
    const stat = await fsp.stat(abs)
    if (!stat.isFile()) return `[${p} 不是普通文件]`
    if (stat.size > 512 * 1024) return `[新文件，${(stat.size / 1024).toFixed(0)} KB，过大不展示内容]`
    if (await sniffBinary(abs)) return `[新增二进制文件，${(stat.size / 1024).toFixed(1)} KB]`
    const text = await fsp.readFile(abs, 'utf8')
    const body = text.length ? text.split('\n') : []
    if (body.length && body[body.length - 1] === '') body.pop()
    const lines = body.map((l) => `+${l}`)
    return [`--- /dev/null`, `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines].join('\n')
  }
  const args = [...READ_ONLY_GIT_FLAGS, 'diff', '-M', await diffBase(cwd), '--', p]
  if (opts.oldPath) args.push(assertPath(opts.oldPath))
  const { stdout } = await runGit(cwd, args, 20_000)
  // 兜底（2026-08-19）：diff 为空不一定意味着"没差异"——gitignored/未跟踪文件
  // （如 .scratch 产物）git diff 根本不认识，返回空串。轮次卡/pill 点这种文件
  // 进面板曾因此什么都看不到。文件在磁盘且不在索引里 → 按未跟踪合成全量 diff。
  if (!stdout.trim()) {
    try {
      await runGit(cwd, [...READ_ONLY_GIT_FLAGS, 'ls-files', '--error-unmatch', '--', p])
    } catch {
      // 不在索引 = 未跟踪/被忽略：磁盘上有就合成，没有就真没有差异
      try {
        return await getFileDiff(cwd, relPath, { ...opts, untracked: true })
      } catch {
        return stdout
      }
    }
  }
  return stdout
}

/**
 * 还原单个文件。三种情况的手段完全不同，认错了要么报错要么留下半个状态：
 *
 * - **未跟踪**：磁盘上删掉（目录要递归）。HEAD 里没有它，checkout 无从谈起。
 * - **新增（已暂存）**：HEAD 里同样没有 —— `checkout HEAD -- <path>` 会报
 *   "pathspec did not match"。正确做法是先从索引撤下（`rm --cached`）再删文件。
 * - **重命名**：传进来的是新路径，HEAD 里只有旧路径。要把旧路径 checkout 回来，
 *   再把新路径从索引和磁盘上去掉，否则会剩下两份。
 *
 * 调用方（渲染层）负责确认弹窗——这是不可逆操作。
 */
export async function revertFile(
  cwd: string,
  relPath: string,
  untracked: boolean,
  opts: { status?: GitFileChange['status']; oldPath?: string } = {}
): Promise<void> {
  const p = assertPath(relPath)
  if (untracked || opts.status === 'untracked') {
    const abs = resolveInsideCwd(cwd, p)
    // 未跟踪条目可能是整个目录（git status 对未跟踪目录只给一条 `dir/`）。
    await fsp.rm(abs, { force: true, recursive: true })
    return
  }
  const head = await hasHead(cwd)

  if (opts.status === 'renamed' && opts.oldPath) {
    const old = assertPath(opts.oldPath)
    if (!head) throw new Error('仓库还没有任何提交，无法还原重命名')
    await runGit(cwd, ['checkout', head ? 'HEAD' : EMPTY_TREE_HASH, '--', old])
    // 新路径：从索引撤下并删除磁盘副本，否则旧新两份同时存在。
    await runGit(cwd, ['rm', '-f', '--quiet', '--', p]).catch(async () => {
      // 已被手工改动过时 rm 会拒绝，退回"撤索引 + 删文件"。
      await runGit(cwd, ['rm', '--cached', '--quiet', '--', p]).catch(() => undefined)
      await fsp.rm(resolveInsideCwd(cwd, p), { force: true, recursive: true })
    })
    return
  }

  if (opts.status === 'added' || !head) {
    // HEAD 里没有这个路径：撤索引 + 删磁盘文件。--cached 保证 rm 不会因为
    // 文件有未暂存改动而拒绝。
    await runGit(cwd, ['rm', '--cached', '--quiet', '--', p]).catch(() => undefined)
    await fsp.rm(resolveInsideCwd(cwd, p), { force: true, recursive: true })
    return
  }

  // `checkout HEAD -- <path>` 的语义正是「把该路径的索引与工作区都还原到 HEAD」；
  // `--` 在这里是安全且必要的（路径可能以任意字符开头）。
  try {
    await runGit(cwd, ['checkout', 'HEAD', '--', p])
  } catch (error) {
    // HEAD 里没有该路径（典型是 AA 冲突：双方都新增）——checkout 报 pathspec
    // 不匹配。这种情况的"还原"只能是撤索引 + 删文件。
    if (!/did not match|pathspec/i.test(error instanceof Error ? error.message : String(error))) throw error
    await runGit(cwd, ['rm', '--cached', '--quiet', '--', p]).catch(() => undefined)
    await fsp.rm(resolveInsideCwd(cwd, p), { force: true, recursive: true })
  }
}

/** Unstage paths (git reset). Omit paths to unstage everything back to HEAD. */
export async function reset(cwd: string, paths?: string[]): Promise<void> {
  const args = ['reset', '-q']
  if (paths && paths.length) args.push('--', ...paths)
  await runGit(cwd, args)
}

/** Push the current branch and set upstream (git push -u origin HEAD). */
export async function pushUpstream(cwd: string): Promise<{ stdout: string; stderr: string }> {
  return runGit(cwd, ['push', '-u', 'origin', 'HEAD'], 30_000)
}

/* ------------------------------------------------------------------ */
/* git worktree 隔离（2026-09-01 Codex 化第 4 期，逐线程显式 opt-in）。   */
/* 台账/落盘登记在 worktreeStore.ts，这里只做纯 git 操作。              */
/* ------------------------------------------------------------------ */

export interface GitWorktreeInfo {
  path: string
  /** 短分支名；detached HEAD 时为 null。 */
  branch: string | null
  head: string
}

/** worktree 落盘根：%LOCALAPPDATA%/Tran/worktrees/<repo-hash>/<name>/——
 *  放系统目录而不是仓库旁边，不污染用户的项目目录（Codex 同款思路）。
 *  LOCALAPPDATA 缺失（非 Windows）时回退 home 下的隐藏目录兜底。 */
function worktreeBaseDir(): string {
  const local = process.env.LOCALAPPDATA
  return local ? join(local, 'Tran', 'worktrees') : join(homedir(), '.tran-worktrees')
}

/** repoRoot 归一化路径的短 hash：同一仓库的 worktree 收进同一层目录，
 *  路径里又不出现可能很长的仓库全路径。 */
function repoHash(repoRoot: string): string {
  return createHash('sha1').update(normalizeCwdForCompare(repoRoot)).digest('hex').slice(0, 10)
}

/** worktree 名同时是目录末段与分支名（tran/<name>）的一段：只放行 ASCII
 *  安全字符，杜绝路径分隔符/「..」越出基目录，也保证 refname 合法。 */
function assertWorktreeName(name: string): string {
  const n = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) {
    throw new Error(`worktree 名称不合法（只允许字母/数字/._-，且以字母或数字开头）：${name}`)
  }
  return n
}

/** 在基目录下为 repoRoot 新建 worktree：git worktree add <path> -b tran/<name>（基于
 *  当前 HEAD）。
 *
 *  冲突策略（选定「追加序号」，不复用已有分支/目录）：复用会把新会话塞进
 *  另一个线程正在用的工作区，直接违背「逐线程隔离」的初衷。分支已存在或
 *  目录已存在时顺延 <name>-2、-3…，50 个空位都找不到就报错让用户换名。 */
export async function createWorktree(
  repoRoot: string,
  name: string
): Promise<{ path: string; branch: string }> {
  const baseName = assertWorktreeName(name)
  // 先确认真是 git 仓库（渲染层菜单已对非 git 项目隐藏入口，这里兜底）。
  if (!(await isGitRepo(repoRoot))) {
    throw new Error(`不是 git 仓库，无法创建 worktree：${repoRoot}`)
  }
  const base = join(worktreeBaseDir(), repoHash(repoRoot))
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? baseName : `${baseName}-${i}`
    const branch = `tran/${candidate}`
    const target = join(base, candidate)
    const branchExists = await runGit(repoRoot, [
      ...READ_ONLY_GIT_FLAGS, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`
    ]).then(() => true, () => false)
    const dirExists = await fsp.stat(target).then(() => true, () => false)
    if (branchExists || dirExists) continue
    await fsp.mkdir(base, { recursive: true })
    await runGit(repoRoot, ['worktree', 'add', target, '-b', branch], 30_000)
    return { path: target, branch }
  }
  throw new Error(`worktree 名称冲突过多（${baseName}…${baseName}-50 都被占用），换个名字再试`)
}

/** 删除 worktree。非 force 且工作区有未提交改动（含未跟踪文件）时拒绝并
 *  说明原因——用 readStatus（读不出来会抛）而不是 getStatus（吞错回"干净"），
 *  状态读不出来绝不能当成"干净"放行删除。
 *
 *  只许删 Tran 基目录之内的路径：这个入口背后跟着「删会话」联动，传错
 *  路径也不能伤及用户的普通检出。
 *
 *  分支 tran/<name> 刻意保留：worktree 删了提交还在分支上，用户随时能找回。 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const target = resolve(path)
  const base = resolve(worktreeBaseDir())
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`只允许删除 Tran 管理的 worktree（${base} 之内）：${path}`)
  }
  if (!opts.force) {
    let status: Omit<GitStatus, 'ahead' | 'behind'>
    try {
      status = await readStatus(target)
    } catch (error) {
      throw new Error(`无法读取 worktree 状态，删除已中止：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!status.clean) {
      throw new Error(
        `worktree 有未提交改动，未删除（暂存 ${status.staged.length}、未暂存 ${status.unstaged.length}` +
        `、未跟踪 ${status.untracked.length}、冲突 ${status.conflicts.length}）：${target}`
      )
    }
  }
  await runGit(repoRoot, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), target], 30_000)
}

/** git worktree list --porcelain：每块 worktree <path> / HEAD <sha> /
 *  branch refs/heads/<name>（detached 无 branch 行），空行分隔。 */
export async function listWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
  const { stdout } = await runGit(repoRoot, [...READ_ONLY_GIT_FLAGS, 'worktree', 'list', '--porcelain'])
  const out: GitWorktreeInfo[] = []
  let cur: Partial<GitWorktreeInfo> | null = null
  const flush = (): void => {
    if (cur?.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? '' })
    cur = null
  }
  for (const line of stdout.split('\n')) {
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      cur = { path: line.slice('worktree '.length) }
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length)
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  flush()
  return out
}
