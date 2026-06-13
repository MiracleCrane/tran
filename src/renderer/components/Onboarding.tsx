import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
]

export default function Onboarding(): JSX.Element {
  const startSession = useSessionStore((s) => s.startSession)
  const [cwd, setCwd] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('claude-opus-4-8')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void window.api.getApiKey().then((k) => setApiKey(k ?? ''))
  }, [])

  const pick = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setCwd(dir)
  }

  const start = async (): Promise<void> => {
    setError(null)
    if (!cwd.trim()) {
      setError('Pick a working directory first.')
      return
    }
    setSubmitting(true)
    try {
      if (apiKey.trim()) await window.api.setApiKey(apiKey.trim())
      await startSession({ cwd: cwd.trim(), apiKey: apiKey.trim() || undefined, model })
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
          A desktop client for Claude Agent. Pick a project folder to begin.
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Working directory
        </label>
        <div className="mb-4 flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\path\to\project"
            className="flex-1 rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-accent"
          />
          <button
            onClick={pick}
            className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 hover:bg-bg-hover"
          >
            Browse…
          </button>
        </div>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Model
        </label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="mb-4 w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500">
          Anthropic API key <span className="normal-case text-zinc-600">(optional)</span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-ant-…"
          className="mb-1.5 w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-accent"
        />
        <p className="mb-5 text-xs text-zinc-500">
          Leave blank to use your existing Claude login (the SDK reuses your{' '}
          <code className="text-zinc-400">~/.claude</code> profile).
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
          {submitting ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </div>
  )
}
