import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'
import type { McpScope, McpServerConfigInput } from '../shared/ipc'

/**
 * Persists MCP servers to the same config files `claude mcp` uses, since the
 * Agent SDK has no API for writing them (only dynamic per-session injection).
 *
 *   user    → ~/.claude.json            top-level mcpServers
 *   local   → ~/.claude.json            projects[cwd].mcpServers
 *   project → {cwd}/.mcp.json           mcpServers
 *
 * Each operation is a read-modify-write that only touches the target `mcpServers`
 * subtree, leaving every other key in the file untouched.
 */

function userConfigPath(): string {
  return join(homedir(), '.claude.json')
}

function projectConfigPath(cwd: string): string {
  return join(cwd, '.mcp.json')
}

/**
 * 读出待改写的配置根对象。
 *
 * 这里绝不能把「读取/解析失败」降级成空对象：saveMcpServer 是
 * 读-改-写，空对象会让随后的写入把整个文件（~/.claude.json 与 claude CLI
 * 共用，含认证、projects、历史）替换成只剩一个 mcpServers 的内容。
 * 解析失败时抛错，让调用方放弃写入。
 */
function readRoot(path: string): Record<string, unknown> {
  const result = readJsonSafe<Record<string, unknown>>(path)
  if (result.status === 'missing') return {}
  if (result.status === 'failed') {
    throw new Error(`配置文件无法读取，已放弃写入以免覆盖既有内容：${path}（${result.error.message}）`)
  }
  const value = result.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`配置文件不是 JSON 对象，已放弃写入以免覆盖既有内容：${path}`)
  }
  return value
}

/** Resolve (creating as needed) the `mcpServers` object for the given scope
 *  within `root`, mutating root in place. */
function locateServers(
  root: Record<string, unknown>,
  cwd: string,
  scope: McpScope
): Record<string, unknown> {
  if (scope === 'local') {
    if (!root['projects'] || typeof root['projects'] !== 'object') root['projects'] = {}
    const projects = root['projects'] as Record<string, unknown>
    if (!projects[cwd] || typeof projects[cwd] !== 'object') projects[cwd] = {}
    const proj = projects[cwd] as Record<string, unknown>
    if (!proj['mcpServers'] || typeof proj['mcpServers'] !== 'object') proj['mcpServers'] = {}
    return proj['mcpServers'] as Record<string, unknown>
  }
  // user and project both use a top-level mcpServers (project uses a separate file)
  if (!root['mcpServers'] || typeof root['mcpServers'] !== 'object') root['mcpServers'] = {}
  return root['mcpServers'] as Record<string, unknown>
}

function pathFor(cwd: string, scope: McpScope): string {
  return scope === 'project' ? projectConfigPath(cwd) : userConfigPath()
}

export function saveMcpServer(args: {
  cwd: string
  scope: McpScope
  name: string
  config: McpServerConfigInput
}): void {
  const path = pathFor(args.cwd, args.scope)
  const root = readRoot(path)
  const servers = locateServers(root, args.cwd, args.scope)
  servers[args.name] = args.config
  writeJsonAtomic(path, root)
  log('mcp', `saved server="${args.name}" scope=${args.scope} path=${path}`)
}

export function deleteMcpServer(args: {
  cwd: string
  scope: McpScope
  name: string
}): boolean {
  const path = pathFor(args.cwd, args.scope)
  if (!existsSync(path)) return false
  const root = readRoot(path)
  const servers = locateServers(root, args.cwd, args.scope)
  if (!(args.name in servers)) return false
  delete servers[args.name]
  writeJsonAtomic(path, root)
  log('mcp', `deleted server="${args.name}" scope=${args.scope} path=${path}`)
  return true
}
