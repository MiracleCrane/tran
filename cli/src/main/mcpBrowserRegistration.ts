import { app } from 'electron'
import { join } from 'node:path'
import { kimiHome } from './kimiHome'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'

/**
 * 控制类插件（浏览器控制 / 桌面控制）在 kimi mcp.json 里的注册管理。
 *
 * 「插件开关」的实现本体：开 = upsert 对应的 MCP server 条目（kimi 会话
 * 启动时装载工具），关 = 删除条目（工具消失）。注册均为幂等，安装路径
 * 变动（升级/换目录）时 Tran 启动自动修正。
 *
 * command 用 Tran 自己（打包后是 Tran.exe，dev 是 node_modules 的
 * electron.exe）+ ELECTRON_RUN_AS_NODE=1 跑打包出的单文件 js——用户机器
 * 不一定有 node，Electron 即 Node。
 */

const BROWSER_SERVER_NAME = 'tran-browser'
const DESKTOP_SERVER_NAME = 'tran-desktop'

interface McpServerEntry {
  type: string
  command: string
  args: string[]
  env: Record<string, string>
}

function scriptPath(bundleName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, bundleName)
    : join(app.getAppPath(), 'out', 'mcp', bundleName)
}

/** 读-改-写 mcp.json 的公共壳。文件损坏时放弃（绝不覆盖 kimi 共用配置）。
 *  mutate 返回 false 表示无需写盘。 */
function withMcpConfig(mutate: (servers: Record<string, unknown>) => boolean): void {
  const path = join(kimiHome(), 'mcp.json')
  try {
    const read = readJsonSafe<Record<string, unknown>>(path)
    if (read.status === 'failed') {
      log('mcp', `mcp.json 无法读取，放弃修改（避免覆盖）：${read.error.message}`)
      return
    }
    const root = read.status === 'ok' ? read.value : {}
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      log('mcp', 'mcp.json 不是对象，放弃修改')
      return
    }
    if (!root['mcpServers'] || typeof root['mcpServers'] !== 'object') root['mcpServers'] = {}
    if (!mutate(root['mcpServers'] as Record<string, unknown>)) return
    writeJsonAtomic(path, root)
  } catch (error) {
    log('mcp', `修改 mcp.json 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function upsert(name: string, desired: McpServerEntry): void {
  withMcpConfig((servers) => {
    if (JSON.stringify(servers[name]) === JSON.stringify(desired)) return false
    servers[name] = desired
    log('mcp', `registered ${name}（command=${desired.command}）`)
    return true
  })
}

/** 反注册（开关关闭时）。条目不存在则无操作。 */
export function unregisterMcpServer(name: 'tran-browser' | 'tran-desktop'): void {
  withMcpConfig((servers) => {
    if (!(name in servers)) return false
    delete servers[name]
    log('mcp', `unregistered ${name}`)
    return true
  })
}

/** 浏览器控制：注册 tran-browser（需要桥的配对文件路径）。 */
export function registerMcpBrowserServer(tokenFile: string): void {
  upsert(BROWSER_SERVER_NAME, {
    type: 'stdio',
    command: process.execPath,
    args: [scriptPath('mcp-browser.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', TRAN_BRIDGE_TOKEN_FILE: tokenFile }
  })
}

/** 桌面控制：注册 tran-desktop（自包含，不依赖桥）。 */
export function registerMcpDesktopServer(): void {
  upsert(DESKTOP_SERVER_NAME, {
    type: 'stdio',
    command: process.execPath,
    args: [scriptPath('mcp-desktop.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
}
