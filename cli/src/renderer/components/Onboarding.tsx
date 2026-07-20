import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'

export default function Onboarding(): JSX.Element {
  const startSession = useSessionStore((s) => s.startSession)
  const showBlockingOverlay = useUiStore((s) => s.showBlockingOverlay)
  const hideBlockingOverlay = useUiStore((s) => s.hideBlockingOverlay)
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const pick = async (): Promise<void> => {
    const overlayId = showBlockingOverlay('正在等待资源管理器响应...')
    let dir: string | null = null
    try {
      dir = await window.api.pickDirectory()
    } finally {
      hideBlockingOverlay(overlayId)
    }
    if (!dir) return
    setCwd(dir)
  }

  const start = async (): Promise<void> => {
    setError(null)
    const cleanCwd = cwd.trim()
    if (!cleanCwd) {
      setError('请先选择一个工作目录。')
      return
    }
    setSubmitting(true)
    try {
      // Persist the picked directory as the first project (and last-used), so
      // the app auto-enters it next launch instead of showing onboarding again.
      await window.api.addProject(cleanCwd)
      await startSession({ cwd: cleanCwd })
      // startSession() sets meta → App switches to the main view and unmounts us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-transparent px-6">
      <div className="w-full max-w-lg rounded-2xl border border-border-subtle bg-bg-panel p-8 shadow-2xl">
        <div className="mb-1 text-2xl font-semibold text-zinc-100">Tran</div>
        <div className="mb-6 text-sm text-zinc-400">
          本地 CLI Agent 的桌面客户端（当前内置 Kimi 后端）。选择一个项目文件夹即可开始。
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          工作目录
        </label>
        <div className="mb-4 flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={'C:\\Projects\\path'}
            className="flex-1 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-accent"
          />
          <button
            onClick={pick}
            className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 hover:bg-bg-hover"
          >
            浏览…
          </button>
        </div>

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
