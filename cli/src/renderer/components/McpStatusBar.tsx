import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
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
  const parts = [server.name, server.status]
  if (server.toolCount !== undefined) parts.push(`${server.toolCount} tools`)
  else if (server.tools) parts.push(`${server.tools.length} tools`)
  if (server.config?.type) parts.push(`(${server.config.type})`)
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
  const [refreshing, setRefreshing] = useState(false)

  if (!servers || servers.length === 0) return null

  const refresh = (): void => {
    if (!sessionId || refreshing) return
    setRefreshing(true)
    // 重查走主进程隐藏 /mcp 轮，结果经 system/mcp_servers 异步推送回来；
    // 转圈只给最短视觉反馈。
    void window.api.refreshMcpServers(sessionId).catch(() => {})
    window.setTimeout(() => setRefreshing(false), 1500)
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-2 px-6 pb-1.5 text-[11px] text-zinc-500">
      <span className="shrink-0 font-medium uppercase tracking-wide text-zinc-600">MCP</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
        {servers.map((server) => (
          <span
            key={server.name}
            className="flex min-w-0 items-center gap-1.5"
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
        className="shrink-0 rounded-md p-1 text-zinc-600 transition hover:bg-white/[0.06] hover:text-zinc-300"
      >
        <RefreshIcon spinning={refreshing} />
      </button>
    </div>
  )
}
