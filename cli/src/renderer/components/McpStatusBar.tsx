import { useSessionStore } from '../store/sessionStore'
import { useTransientFlag } from '../hooks/useTransientFlag'
import type { McpServerEntry, McpServerStatusKind } from '../../shared/ipc'

/** MCP server 状态区（#15）：会话初始化时隐藏 /mcp 轮解析出的连接状态，
 *  对齐 kimi CLI 的信息密度（`yuque · connected · 19 tools (stdio)`）。
 *  以状态条形式挂在 Transcript 上方，不当普通 AI 消息。 */

const STATUS_DOT: Record<McpServerStatusKind, string> = {
  connected: 'bg-emerald-400',
  pending: 'bg-amber-400',
  failed: 'bg-red-400',
  'needs-auth': 'bg-amber-400',
  disabled: 'bg-zinc-600'
}

function serverLabel(server: McpServerEntry): string {
  // 降噪（2026-08）：connected 由状态点表达、stdio 是默认类型，都不写进文案；
  // 只有异常状态（pending/failed/needs-auth）和远程类型（sse/http）才值得占字。
  const parts = [server.name]
  if (server.status !== 'connected') parts.push(server.status)
  if (server.toolCount !== undefined) parts.push(`${server.toolCount} tools`)
  else if (server.tools) parts.push(`${server.tools.length} tools`)
  if (server.config?.type && server.config.type !== 'stdio') parts.push(`(${server.config.type})`)
  return parts.join(' · ')
}

const RefreshIcon = ({ spinning }: { spinning: boolean }): JSX.Element => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    className={spinning ? 'animate-spin' : undefined}
  >
    <path
      d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export default function McpStatusBar(): JSX.Element | null {
  const servers = useSessionStore((s) => s.mcpServers)
  const sessionId = useSessionStore((s) => s.meta?.sessionId)
  // 转圈 1.5s 自动停；useTransientFlag 内部管理定时器清理。
  const [refreshing, flashRefreshing] = useTransientFlag(1500)

  if (!servers || servers.length === 0) return null

  const refresh = (): void => {
    if (!sessionId || refreshing) return
    flashRefreshing()
    // 重查走主进程隐藏 /mcp 轮，结果经 system/mcp_servers 异步推送回来；
    // 转圈只给最短视觉反馈。
    void window.api.refreshMcpServers(sessionId).catch(() => {})
  }

  return (
    // 2026-08 重样式：服务器收成小胶囊 + 底部发丝分割线。之前是裸文本行直接
    // 压在对话内容上，和待办卡提示、消息正文三段糊在一起，边界感为零。
    <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-2 border-b border-white/[0.06] px-6 pb-2 pt-0.5 text-[11px] text-zinc-500">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {servers.map((server) => (
          <span
            key={server.name}
            className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.03] px-2 py-0.5"
            title={server.error ?? serverLabel(server)}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[server.status]}`} />
            <span className="truncate">{serverLabel(server)}</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={refresh}
        title="重新查询 MCP 状态"
        className="shrink-0 rounded-full p-1 text-zinc-600 transition hover:bg-white/[0.06] hover:text-zinc-300"
      >
        <RefreshIcon spinning={refreshing} />
      </button>
    </div>
  )
}
