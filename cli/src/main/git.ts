import { spawn } from 'node:child_process'
import type { GitBranchInfo, GitCommit, GitStatus } from '../shared/ipc'
import { log } from './logger'

/** Run a git command. Returns { stdout, stderr } or throws on non-zero exit. */
function runGit(cwd: string, args: string[], timeout = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`git ${args.join(' ')} timed out after ${timeout}ms`))
    }, timeout)

    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: out.trim(), stderr: err.trim() })
      else {
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
    await runGit(cwd, ['rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

/** Get current branch name, or null if detached/not a repo. */
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
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
    const { stdout } = await runGit(cwd, ['branch', '--format=%(refname:short)'])
    return stdout.split('\n').filter(Boolean).map((name) => ({
      name,
      current: name === current
    }))
  } catch {
    return []
  }
}

/** Switch to a branch (checkout). */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  await runGit(cwd, ['checkout', branch])
}

/** Create a new branch. */
export async function createBranch(cwd: string, name: string): Promise<void> {
  await runGit(cwd, ['branch', name])
}

/** Delete a local branch (force if requested). */
export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  await runGit(cwd, ['branch', force ? '-D' : '-d', name])
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
    const { stdout } = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
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
 *  source-paths (a second NUL token) and classify per the XY status pair. */
export async function getStatus(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = {
    staged: [], unstaged: [], untracked: [], conflicts: [],
    clean: true, ahead: null, behind: null
  }
  try {
    const { stdout } = await runGit(cwd, ['status', '--porcelain', '-z'])
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
    const { ahead, behind } = await getAheadBehind(cwd)
    return { staged, unstaged, untracked, conflicts, clean, ahead, behind }
  } catch {
    return empty
  }
}

/** git add (paths or '.' for all). */
export async function add(cwd: string, paths?: string[]): Promise<void> {
  const args = ['add']
  if (paths && paths.length > 0) args.push(...paths)
  else args.push('.')
  await runGit(cwd, args)
}

/** git commit with message. */
export async function commit(cwd: string, message: string): Promise<void> {
  const status = await getStatus(cwd)
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
    const { stdout } = await runGit(cwd, ['log', `--max-count=${limit}`, '--format=' + fmt])
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
    const { stdout } = await runGit(cwd, ['stash', 'list'])
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
  await runGit(cwd, ['revert', '--no-edit', commitHash])
}

/** Unified diff of unstaged changes; pass staged=true for already-staged
 *  changes, and paths to limit to specific files. Returns the raw diff text. */
export async function diff(
  cwd: string,
  opts: { staged?: boolean; paths?: string[] } = {}
): Promise<string> {
  const args = ['diff']
  if (opts.staged) args.push('--cached')
  if (opts.paths && opts.paths.length) args.push('--', ...opts.paths)
  const { stdout } = await runGit(cwd, args)
  return stdout
}

/** git fetch — update remote-tracking refs without merging. */
export async function fetch(cwd: string): Promise<{ stdout: string; stderr: string }> {
  return runGit(cwd, ['fetch'], 60_000)
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
