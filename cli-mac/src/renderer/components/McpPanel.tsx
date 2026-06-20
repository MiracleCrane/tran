import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import McpServerFormModal from './McpServerFormModal'
import type { McpServerEntry, McpServerStatusKind, McpScope } from '../../shared/ipc'
import { RefreshIcon, ToolPanelAlert, ToolPanelButton } from './ToolPanelChrome'

const STATUS_META: Record<McpServerStatusKind, { label: string; dot: string; text: string }> = {
  connected: { label: '已连接', dot: 'bg-emerald-500', text: 'text-emerald-400' },
  pending: { label: '连接中', dot: 'bg-amber-500 animate-pulse', text: 'text-amber-400' },
  failed: { label: '连接失败', dot: 'bg-red-500', text: 'text-red-400' },
  'needs-auth': { label: '需要授权', dot: 'bg-sky-500', text: 'text-sky-400' },
  disabled: { label: '已禁用', dot: 'bg-zinc-600', text: 'text-zinc-500' }
}

const SCOPE_LABEL: Record<string, string> = {
  project: '项目',
  user: '用户',
  local: '本地',
  claudeai: 'Claude.ai',
  managed: '托管'
}

function transportLabel(s: McpServerEntry): string {
  const t = s.config?.type
  if (t === 'stdio') return '本地 · stdio'
  if (t === 'sse') return '远程 · SSE'
  if (t === 'http') return '远程 · HTTP'
  if (t === 'claudeai-proxy') return 'Claude.ai 代理'
  return '—'
}

/** System-managed scopes can't be edited or deleted from the UI. */
function isEditable(scope: string | undefined): boolean {
  return scope !== 'claudeai' && scope !== 'managed'
}

function scopeOf(s: McpServerEntry): McpScope {
  return s.scope === 'project' || s.scope === 'local' ? s.scope : 'user'
}

export default function McpPanel(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const starting = useSessionStore((s) => s.starting)
  const restartSession = useSessionStore((s) => s.restartSession)

  const [servers, setServers] = useState<McpServerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [formMode, setFormMode] = useState<'add' | 'edit' | null>(null)
  const [editing, setEditing] = useState<McpServerEntry | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<McpServerEntry | null>(null)
  const [viewing, setViewing] = useState<McpServerEntry | null>(null)
  const [copied, setCopied] = useState(false)
  const mcpAddCommand = meta?.agentBackend === 'hermes' ? 'hermes mcp add' : 'claude mcp add'

  const fetchServers = useCallback(async (): Promise<void> => {
    if (!meta) return
    setLoading(true)
    setError(null)
    try {
      const list = await window.api.listMcpServers(meta.sessionId)
      setServers(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [meta])

  const refreshServers = useCallback(async (): Promise<void> => {
    if (!meta) return
    setLoading(true)
    setError(null)
    try {
      const backend = meta.agentBackend ?? 'claude-code'
      if (backend === 'claude-code') {
        await restartSession()
        const nextMeta = useSessionStore.getState().meta
        if (nextMeta) {
          const list = await window.api.listMcpServers(nextMeta.sessionId)
          setServers(list)
        }
      } else {
        const list = await window.api.refreshMcpServers(meta.sessionId)
        setServers(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [meta, restartSession])

  // Initial load, plus re-fetch once the session finishes starting (the query
  // handle isn't usable until claude.exe has spawned).
  useEffect(() => {
    if (!starting) void fetchServers()
  }, [fetchServers, starting])

  // While any server is still connecting, poll until it settles.
  useEffect(() => {
    if (!servers.some((s) => s.status === 'pending')) return
    const t = setTimeout(() => void fetchServers(), 2000)
    return () => clearTimeout(t)
  }, [servers, fetchServers])

  const toggle = useCallback(
    async (server: McpServerEntry, next: boolean): Promise<void> => {
      if (!meta) return
      setToggling(server.name)
      // Optimistic: flip the switch locally so it feels instant.
      setServers((prev) =>
        prev.map((s) =>
          s.name === server.name ? { ...s, status: next ? 'pending' : 'disabled' } : s
        )
      )
      try {
        await window.api.toggleMcpServer(meta.sessionId, server.name, next)
        await new Promise((r) => setTimeout(r, 300))
        await fetchServers()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        await fetchServers() // revert the optimistic flip to the real state
      } finally {
        setToggling(null)
      }
    },
    [meta, fetchServers]
  )

  const openAdd = (): void => {
    setEditing(null)
    setFormMode('add')
  }
  const openEdit = (s: McpServerEntry): void => {
    setEditing(s)
    setFormMode('edit')
  }
  const handleSaved = (): void => {
    setFormMode(null)
    setEditing(null)
    void restartSession()
  }
  const handleDelete = async (): Promise<void> => {
    const s = confirmDelete
    if (!s || !meta) return
    try {
      await window.api.deleteMcpServer({ cwd: meta.cwd, scope: scopeOf(s), name: s.name })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setConfirmDelete(null)
    void restartSession()
  }

  const copyViewingJson = async (): Promise<void> => {
    if (!viewing) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(viewing.config ?? {}, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">MCP 服务器</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              本会话可用的工具服务器。开关状态会跨会话保留。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ToolPanelButton
              variant="primary"
              onClick={openAdd}
            >
              + 添加服务器
            </ToolPanelButton>
            <ToolPanelButton
              onClick={() => void refreshServers()}
              disabled={loading || starting}
            >
              <RefreshIcon spinning={loading || starting} />
              <span>{loading || starting ? '刷新中' : '刷新'}</span>
            </ToolPanelButton>
          </div>
        </div>

        {starting && (
          <ToolPanelAlert tone="warning">
            正在重开会话以应用配置更改…
          </ToolPanelAlert>
        )}

        {error && (
          <ToolPanelAlert tone="error">
            {error}
          </ToolPanelAlert>
        )}

        {loading && servers.length === 0 && (
          <div className="py-10 text-center text-sm text-zinc-500">正在加载服务器…</div>
        )}

        {!loading && servers.length === 0 && !error && (
          <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center">
            <div className="text-sm text-zinc-300">尚未配置 MCP 服务器</div>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-zinc-500">
              点击右上角「+ 添加服务器」,或使用{' '}
              <code className="rounded bg-bg-elev px-1 py-0.5 text-zinc-400">{mcpAddCommand}</code>{' '}
              命令添加。
            </p>
          </div>
        )}

        <div className="space-y-2">
          {servers.map((s) => {
            const enabled = s.status !== 'disabled'
            const statusMeta = STATUS_META[s.status]
            const scopeLabel = s.scope ? SCOPE_LABEL[s.scope] ?? s.scope : undefined
            const editable = isEditable(s.scope)
            const busy = toggling === s.name
            return (
              <div
                key={s.name}
                className="flex items-start gap-4 rounded-xl border border-border-subtle bg-bg-panel px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">{s.name}</span>
                    <span className={`inline-flex items-center gap-1.5 text-[11px] ${statusMeta.text}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${statusMeta.dot}`} />
                      {statusMeta.label}
                    </span>
                    {editable ? (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => setViewing(s)}
                          className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                        >
                          JSON
                        </button>
                        <button
                          onClick={() => openEdit(s)}
                          className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => setConfirmDelete(s)}
                          className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                        >
                          删除
                        </button>
                      </div>
                    ) : (
                      <div className="ml-auto flex items-center gap-1">
                        <button
                          onClick={() => setViewing(s)}
                          className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                        >
                          JSON
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                    <span>{transportLabel(s)}</span>
                    {scopeLabel && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span>{scopeLabel}</span>
                      </>
                    )}
                    {s.serverInfo && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span className="truncate">
                          {s.serverInfo.name} {s.serverInfo.version}
                        </span>
                      </>
                    )}
                    {s.config?.command && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span className="truncate font-mono">
                          {s.config.command}
                          {s.config.args?.length ? ' ' + s.config.args.join(' ') : ''}
                        </span>
                      </>
                    )}
                    {s.tools && s.tools.length > 0 && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span>{s.tools.length} 个工具</span>
                      </>
                    )}
                  </div>
                  {s.status === 'failed' && s.error && (
                    <div className="mt-1.5 truncate text-[11px] text-red-400/80" title={s.error}>
                      {s.error}
                    </div>
                  )}
                  {enabled && s.tools && s.tools.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.tools.slice(0, 12).map((t) => (
                        <span
                          key={t.name}
                          title={t.description}
                          className="rounded bg-bg-elev px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                        >
                          {t.name}
                        </span>
                      ))}
                      {s.tools.length > 12 && (
                        <span className="px-1 py-0.5 text-[10px] text-zinc-600">
                          +{s.tools.length - 12} 个
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`切换 ${s.name}`}
                  disabled={busy}
                  onClick={() => void toggle(s, !enabled)}
                  className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                    enabled ? 'bg-accent' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {formMode && meta && (
        <McpServerFormModal
          cwd={meta.cwd}
          mode={formMode}
          editing={editing}
          existingNames={servers.map((s) => s.name)}
          onClose={() => {
            setFormMode(null)
            setEditing(null)
          }}
          onSaved={handleSaved}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-zinc-100">删除服务器</h2>
            <p className="mt-2 text-sm text-zinc-400">
              确定要删除{' '}
              <span className="font-mono text-zinc-200">{confirmDelete.name}</span>{' '}
              吗?此操作会从配置文件移除,并重开会话以应用。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
              >
                取消
              </button>
              <button
                onClick={() => void handleDelete()}
                className="rounded-lg border border-red-900/60 bg-red-950/50 px-5 py-2 text-sm font-medium text-red-300 hover:bg-red-950/70"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-subtle bg-bg-panel shadow-2xl">
            <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
              <h2 className="truncate font-mono text-sm font-semibold text-zinc-100">
                {viewing.name}
              </h2>
              <span className="text-xs text-zinc-500">完整配置</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => void copyViewingJson()}
                  className="rounded-lg border border-border-subtle bg-bg-elev px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-bg-hover"
                >
                  {copied ? '已复制' : '复制'}
                </button>
                <button
                  onClick={() => setViewing(null)}
                  className="rounded-lg border border-border-subtle bg-bg-elev px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-bg-hover"
                >
                  关闭
                </button>
              </div>
            </div>
            <pre className="overflow-auto px-5 py-4 font-mono text-xs leading-relaxed text-zinc-300">
              {JSON.stringify(viewing.config ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
