import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { kimiHome } from './kimiHome'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'
import type { McpScope, McpServerConfigInput } from '../shared/ipc'

/**
 * 把 MCP 服务器持久化到 Kimi Code 实际读取的配置文件（GitHub #62）。
 *
 * 此前写的是 ~/.claude.json（旧 Claude 后端残留），Kimi Code 根本不读它。
 * Kimi 实际读取的是 $KIMI_CODE_HOME/mcp.json（未设 KIMI_CODE_HOME 时为
 * ~/.kimi-code/mcp.json，与 usageService.ts 的 credentials 路径同一套解析），
 * 文件形如 {"mcpServers": {"名字": {command,args,env}}}（本机实证）。
 *
 *   user    → $KIMI_CODE_HOME/mcp.json   顶层 mcpServers
 *   local   → $KIMI_CODE_HOME/mcp.json   顶层 mcpServers（Kimi 无 per-project
 *             概念，local 展平到顶层，与 user 落点相同）
 *   project → {cwd}/.mcp.json            顶层 mcpServers
 *             （注意：Kimi Code 未证实会读项目级 .mcp.json，此路径保留是为了
 *             兼容其他读取 .mcp.json 约定的工具；对 Kimi 可能不生效。）
 *
 * 每次操作都是读-改-写，只动目标 `mcpServers` 子树，文件里其余键原样保留。
 */

/** Kimi Code 的用户级 MCP 配置文件（home 解析见 kimiHome.ts）。 */
function userConfigPath(): string {
  return join(kimiHome(), 'mcp.json')
}

function projectConfigPath(cwd: string): string {
  return join(cwd, '.mcp.json')
}

/**
 * 读出待改写的配置根对象。
 *
 * 这里绝不能把「读取/解析失败」降级成空对象：saveMcpServer 是
 * 读-改-写，空对象会让随后的写入把整个文件（mcp.json 与 Kimi CLI 共用）
 * 替换成只剩一个 mcpServers 的内容。解析失败时抛错，让调用方放弃写入。
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

/** 取（必要时创建）root 顶层的 `mcpServers` 对象，原地修改 root。
 *  三个 scope 的目标文件虽不同，但结构一致：都是顶层 mcpServers。 */
function locateServers(root: Record<string, unknown>): Record<string, unknown> {
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
  const servers = locateServers(root)
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
  const servers = locateServers(root)
  if (!(args.name in servers)) return false
  delete servers[args.name]
  writeJsonAtomic(path, root)
  log('mcp', `deleted server="${args.name}" scope=${args.scope} path=${path}`)
  return true
}
