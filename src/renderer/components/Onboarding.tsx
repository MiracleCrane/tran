import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { Provider } from '../../shared/ipc'

export default function Onboarding(): JSX.Element {
  const startSession = useSessionStore((s) => s.startSession)
  const [cwd, setCwd] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const [list, active] = await Promise.all([
          window.api.listProviders(),
          window.api.getActiveProvider()
        ])
        setProviders(list)
        setSelectedId(active?.id ?? list[0]?.id ?? '')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  const selected = providers.find((p) => p.id === selectedId) ?? null

  const pick = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setCwd(dir)
  }

  const start = async (): Promise<void> => {
    setError(null)
    if (!cwd.trim()) {
      setError('请先选择一个工作目录。')
      return
    }
    if (!selected) {
      setError('请选择一个运营商。')
      return
    }
    setSubmitting(true)
    try {
      // Make the chosen provider active before spawning, so its env/model apply.
      await window.api.setActiveProvider(selected.id)
      // Persist the picked directory as the first project (and last-used), so
      // the app auto-enters it next launch instead of showing onboarding again.
      await window.api.addProject(cwd.trim())
      await startSession({ cwd: cwd.trim(), model: selected.model })
      // startSession() sets meta → App switches to the main view and unmounts us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg-base px-6">
      <div className="w-full max-w-lg rounded-2xl border border-border-subtle bg-bg-panel p-8 shadow-2xl">
        <div className="mb-1 text-2xl font-semibold text-zinc-100">Forge</div>
        <div className="mb-6 text-sm text-zinc-400">
          Claude Agent 的桌面客户端。选择一个项目文件夹即可开始。
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          工作目录
        </label>
        <div className="mb-4 flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\项目\路径"
            className="flex-1 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-accent"
          />
          <button
            onClick={pick}
            className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 hover:bg-bg-hover"
          >
            浏览…
          </button>
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          运营商
        </label>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="mb-2 w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent"
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.baseUrl} · {p.baseUrl} · {p.model}
            </option>
          ))}
        </select>
        <p className="mb-5 text-xs text-zinc-500">
          进入后可从左侧「运营商」添加更多配置并自由切换。当前所选的地址与密钥会用于本次会话。
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={start}
          disabled={submitting}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? '正在启动…' : '开始会话'}
        </button>
      </div>
    </div>
  )
}
