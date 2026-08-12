import { app } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { kimiHome } from './kimiHome'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { resolveClaudeCommand } from './agent/ClaudeBackend'
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

type ServerName = 'tran-browser' | 'tran-desktop'

const BROWSER_SERVER_NAME: ServerName = 'tran-browser'
const DESKTOP_SERVER_NAME: ServerName = 'tran-desktop'

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

/** 本进程内已同步给 Claude Code 的条目（序列化后比对）。Claude 那边的配置
 *  位置不归我们管，读不到现状，只能靠这个避免重复起子进程。 */
const claudeSynced = new Map<ServerName, string>()

function upsert(name: ServerName, desired: McpServerEntry): void {
  withMcpConfig((servers) => {
    if (JSON.stringify(servers[name]) === JSON.stringify(desired)) return false
    servers[name] = desired
    log('mcp', `registered ${name}（command=${desired.command}）`)
    return true
  })
  const fingerprint = JSON.stringify(desired)
  if (claudeSynced.get(name) !== fingerprint) {
    claudeSynced.set(name, fingerprint)
    void claudeMcpAdd(name, desired)
  }
}

/** 反注册（开关关闭时）。条目不存在则无操作。 */
export function unregisterMcpServer(name: ServerName): void {
  withMcpConfig((servers) => {
    if (!(name in servers)) return false
    delete servers[name]
    log('mcp', `unregistered ${name}`)
    return true
  })
  if (claudeSynced.has(name)) claudeSynced.delete(name)
  void claudeMcpRemove(name)
}

// ---------- Claude Code 侧的注册 ----------

/**
 * Claude Code 不读 kimi 的 mcp.json，它有自己的一套配置（位置随版本变，
 * Windows 上未必是 ~/.claude.json）。所以这里不去猜文件路径，直接调它自己的
 * `claude mcp add/remove --scope user` ——官方接口，格式与位置都由 CLI 负责。
 *
 * 全部 best-effort：没装 Claude Code、或用户没登录，都只记一行日志，绝不能
 * 让「浏览器控制」这个开关因为另一个后端不在而失败。
 */
function runClaudeCli(args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const { command, prefixArgs } = resolveClaudeCommand()
    execFile(
      command,
      [...prefixArgs, ...args],
      { windowsHide: true, timeout: 20_000 },
      (error, _stdout, stderr) => {
        if (error) {
          log('mcp', `claude ${label} 未生效（可忽略，若未安装 Claude Code）：${(stderr || error.message).trim().slice(0, 200)}`)
        } else {
          log('mcp', `claude ${label} ok`)
        }
        resolvePromise()
      }
    )
  })
}

async function claudeMcpRemove(name: ServerName): Promise<void> {
  // 条目不存在时 CLI 会以非 0 退出——这在「本来就没注册过」时是正常的，
  // runClaudeCli 只记日志不抛。
  await runClaudeCli(['mcp', 'remove', '--scope', 'user', name], `mcp remove ${name}`)
}

async function claudeMcpAdd(name: ServerName, entry: McpServerEntry): Promise<void> {
  // add 遇到重名会失败，所以先 remove 再 add —— 这就是幂等 upsert。
  await claudeMcpRemove(name)
  const envArgs = Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await runClaudeCli(
    ['mcp', 'add', '--scope', 'user', name, ...envArgs, '--', entry.command, ...entry.args],
    `mcp add ${name}`
  )
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

/**
 * 桌面控制：注册 tran-desktop。
 * @param displayIndex 分屏控制的目标显示器序号；null = 不限制。
 * @param tokenFile 桥的配对文件（桌面进程借它上报活动，点亮屏幕光晕）。
 */
export function registerMcpDesktopServer(displayIndex: number | null, tokenFile: string): void {
  upsert(DESKTOP_SERVER_NAME, {
    type: 'stdio',
    command: process.execPath,
    args: [scriptPath('mcp-desktop.js')],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TRAN_BRIDGE_TOKEN_FILE: tokenFile,
      ...(displayIndex === null ? {} : { TRAN_DESKTOP_DISPLAY: String(displayIndex) })
    }
  })
}
