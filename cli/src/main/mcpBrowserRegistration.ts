import { app } from 'electron'
import { join } from 'node:path'
import { kimiHome } from './kimiHome'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'

/**
 * 把 tran-browser MCP server 幂等注册进 kimi 的 mcp.json，kimi 会话由此
 * 获得浏览器工具（经 BrowserBridge → Chrome 扩展）。
 *
 * command 用 Tran 自己（打包后是 Tran.exe，dev 是 node_modules 的
 * electron.exe）+ ELECTRON_RUN_AS_NODE=1 跑打包出的 mcp-browser.js——
 * 用户机器不一定有 node，Electron 即 Node。安装路径变动（升级/换目录）
 * 时 Tran 启动会重新 upsert 修正路径。
 */

const SERVER_NAME = 'tran-browser'

interface McpServerEntry {
  type: string
  command: string
  args: string[]
  env: Record<string, string>
}

function desiredEntry(tokenFile: string): McpServerEntry {
  const script = app.isPackaged
    ? join(process.resourcesPath, 'mcp-browser.js')
    : join(app.getAppPath(), 'out', 'mcp', 'mcp-browser.js')
  return {
    type: 'stdio',
    command: process.execPath,
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1', TRAN_BRIDGE_TOKEN_FILE: tokenFile }
  }
}

/** 启动时调用。只在条目缺失或内容变化时写盘；文件损坏时放弃（绝不覆盖
 *  kimi 共用的配置文件）。失败只记日志，不影响主流程。 */
export function registerMcpBrowserServer(tokenFile: string): void {
  const path = join(kimiHome(), 'mcp.json')
  try {
    const read = readJsonSafe<Record<string, unknown>>(path)
    if (read.status === 'failed') {
      log('mcp', `mcp.json 无法读取，放弃注册 ${SERVER_NAME}（避免覆盖）：${read.error.message}`)
      return
    }
    const root = read.status === 'ok' ? read.value : {}
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      log('mcp', `mcp.json 不是对象，放弃注册 ${SERVER_NAME}`)
      return
    }
    if (!root['mcpServers'] || typeof root['mcpServers'] !== 'object') root['mcpServers'] = {}
    const servers = root['mcpServers'] as Record<string, unknown>
    const desired = desiredEntry(tokenFile)
    if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(desired)) return
    servers[SERVER_NAME] = desired
    writeJsonAtomic(path, root)
    log('mcp', `registered ${SERVER_NAME} in ${path}（command=${desired.command}）`)
  } catch (error) {
    log('mcp', `注册 ${SERVER_NAME} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
