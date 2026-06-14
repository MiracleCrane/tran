import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import ProviderFormModal from './ProviderFormModal'
import type { Provider } from '../../shared/ipc'

const AUTH_LABEL: Record<string, string> = {
  bearer: 'Bearer Token',
  apikey: 'API Key'
}

function blankProvider(): Provider {
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: 'https://api.anthropic.com',
    token: '',
    authType: 'bearer',
    model: 'claude-opus-4-8'
  }
}

export default function ProvidersPanel(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const starting = useSessionStore((s) => s.starting)
  const switchProvider = useSessionStore((s) => s.switchProvider)

  const [providers, setProviders] = useState<Provider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, active] = await Promise.all([
        window.api.listProviders(),
        window.api.getActiveProvider()
      ])
      setProviders(list)
      setActiveId(active?.id ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, starting])

  const doSwitch = async (id: string): Promise<void> => {
    if (id === activeId || starting || switching) return
    setError(null)
    setSwitching(true)
    try {
      await switchProvider(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSwitching(false)
      void refresh()
    }
  }

  const doDelete = async (p: Provider): Promise<void> => {
    if (providers.length <= 1) return
    try {
      const list = await window.api.deleteProvider(p.id)
      setProviders(list)
      // If we deleted the active one, main reassigned active — refresh.
      const active = await window.api.getActiveProvider()
      setActiveId(active?.id ?? null)
      if (p.id === activeId) await doSwitch(active?.id ?? list[0]?.id ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const openAdd = (): void => {
    setEditing(blankProvider())
    setFormOpen(true)
  }
  const openEdit = (p: Provider): void => {
    setEditing({ ...p })
    setFormOpen(true)
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">运营商</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              保存多个 API 配置,自由切换。切换时会写回 Claude 的原生配置并重开会话。
            </p>
          </div>
          <button
            onClick={openAdd}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110"
          >
            + 添加运营商
          </button>
        </div>

        {(starting || switching) && (
          <div className="mb-4 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm text-amber-300/90">
            正在应用运营商切换…
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {providers.length === 0 && (
          <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center text-sm text-zinc-400">
            还没有运营商配置。
          </div>
        )}

        <div className="space-y-2">
          {providers.map((p) => {
            const active = p.id === activeId
            return (
              <div
                key={p.id}
                className={`flex items-start gap-4 rounded-xl border px-4 py-3 transition ${
                  active
                    ? 'border-accent/50 bg-bg-panel'
                    : 'border-border-subtle bg-bg-panel'
                }`}
              >
                <div
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                    active ? 'bg-accent' : 'bg-zinc-700'
                  }`}
                  title={active ? '当前运营商' : '点击切换'}
                />
                <button
                  onClick={() => void doSwitch(p.id)}
                  disabled={active || starting || switching}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">
                      {p.name || p.baseUrl}
                    </span>
                    {active && (
                      <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                    <span className="truncate font-mono">{p.baseUrl}</span>
                    <span className="text-zinc-700">·</span>
                    <span>{AUTH_LABEL[p.authType]}</span>
                    <span className="text-zinc-700">·</span>
                    <span className="font-mono">{p.model}</span>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => openEdit(p)}
                    className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => void doDelete(p)}
                    disabled={providers.length <= 1}
                    className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    title={providers.length <= 1 ? '至少保留一个运营商' : '删除'}
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <p className="mt-4 text-[11px] text-zinc-600">
          切换会把所选运营商的地址与密钥写入 <code className="text-zinc-500">~/.claude/settings.json</code>,
          并在每次起会话时注入子进程环境,确保立即生效。
        </p>
      </div>

      {formOpen && editing && (
        <ProviderFormModal
          provider={editing}
          isEdit={!!providers.find((p) => p.id === editing.id)}
          onClose={() => {
            setFormOpen(false)
            setEditing(null)
          }}
          onSaved={() => {
            setFormOpen(false)
            setEditing(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
