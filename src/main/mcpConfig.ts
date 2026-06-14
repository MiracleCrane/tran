import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
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
  const root = existsSync(path) ? readJson(path) : {}
  const servers = locateServers(root, args.cwd, args.scope)
  servers[args.name] = args.config
  writeJson(path, root)
  log('mcp', `saved server="${args.name}" scope=${args.scope} path=${path}`)
}

export function deleteMcpServer(args: {
  cwd: string
  scope: McpScope
  name: string
}): boolean {
  const path = pathFor(args.cwd, args.scope)
  if (!existsSync(path)) return false
  const root = readJson(path)
  const servers = locateServers(root, args.cwd, args.scope)
  if (!(args.name in servers)) return false
  delete servers[args.name]
  writeJson(path, root)
  log('mcp', `deleted server="${args.name}" scope=${args.scope} path=${path}`)
  return true
}
