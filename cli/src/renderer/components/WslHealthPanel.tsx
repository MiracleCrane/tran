import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { HealthCheckItem, WslHealthReport } from '../../shared/ipc'

const STATE_STYLE: Record<HealthCheckItem['state'], { dot: string; text: string; label: string }> = {
  pass: { dot: 'bg-emerald-400', text: 'text-emerald-300', label: 'OK' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-300', label: 'WARN' },
  fail: { dot: 'bg-red-400', text: 'text-red-300', label: 'FAIL' }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}

export default function WslHealthPanel(): JSX.Element {
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const [report, setReport] = useState<WslHealthReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runCheck = async (): Promise<void> => {
    if (!cwd) return
    if (typeof window.api.runWslHealthCheck !== 'function') {
      setError('WSL 检查 IPC 尚未加载。请重启 Tran/Electron 窗口，让 preload 更新生效。')
      return
    }
    setError(null)
    setLoading(true)
    try {
      setReport(await window.api.runWslHealthCheck(cwd))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const repair = async (): Promise<void> => {
    if (!cwd) return
    if (typeof window.api.repairWslEnvironment !== 'function') {
      setError('修复 IPC 尚未加载。请重启 Tran/Electron 窗口，让 preload 更新生效。')
      return
    }
    setError(null)
    setRepairing(true)
    try {
      setReport(await window.api.repairWslEnvironment(cwd))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRepairing(false)
    }
  }

  useEffect(() => {
    void runCheck()
  }, [cwd])

  const failing = report?.checks.some((item) => item.state === 'fail' || item.state === 'warn') ?? false

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">WSL 健康检查</h1>
            <p className="mt-1 text-xs text-zinc-500">
              检查默认 WSL、Claude Code、~/.claude 配置和当前工作目录映射。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={loading || repairing}
              className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
            >
              {loading ? '检查中...' : '重新检查'}
            </button>
            <button
              type="button"
              onClick={() => report && copyText(report.diagnostics)}
              disabled={!report}
              className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
            >
              复制诊断
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-sm text-amber-200">
            {error}
          </div>
        )}

        {report && (
          <div className="glass-panel-soft rounded-2xl p-4">
            <div className="mb-3 grid gap-2 text-[11px] text-zinc-500 sm:grid-cols-2">
              <div>
                <span className="text-zinc-600">Windows cwd</span>
                <div className="truncate font-mono text-zinc-300" title={report.cwd}>{report.cwd}</div>
              </div>
              <div>
                <span className="text-zinc-600">WSL cwd</span>
                <div className="truncate font-mono text-zinc-300" title={report.cwdWsl}>{report.cwdWsl ?? 'unmapped'}</div>
              </div>
            </div>

            <div className="space-y-2">
              {report.checks.map((item) => {
                const style = STATE_STYLE[item.state]
                return (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200">{item.label}</span>
                        <span className={`text-[10px] font-medium ${style.text}`}>{style.label}</span>
                      </div>
                      <div className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-zinc-500">
                        {item.detail}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {failing && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void repair()}
                  disabled={repairing}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-60"
                >
                  {repairing ? '修复中...' : '修复基础配置'}
                </button>
                <button
                  type="button"
                  onClick={() => copyText(report.diagnostics)}
                  className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-bg-hover"
                >
                  复制诊断日志
                </button>
              </div>
            )}
          </div>
        )}

        {!report && (
          <div className="glass-panel-soft rounded-2xl p-8 text-center text-sm text-zinc-500">
            {loading ? '正在检查 WSL...' : '暂无检查结果。'}
          </div>
        )}
      </div>
    </div>
  )
}
