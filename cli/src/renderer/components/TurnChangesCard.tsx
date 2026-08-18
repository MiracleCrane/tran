import { useState } from 'react'
import type { TurnChangesItem } from '../types'
import { useSessionStore } from '../store/sessionStore'
import ConfirmDialog from './ConfirmDialog'

/**
 * 一轮对话的文件改动汇总卡（Codex 同款）：「已编辑 N 个文件 +X -Y」+ 文件列表，
 * 可整轮撤销、可打开改动面板审核。
 *
 * 出现时机：turn 结束（result）且这一轮确实动了文件。没动文件就不渲染——
 * 每轮都挂一张空卡片是噪声。
 */

const FILES_SHOWN = 3

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

function dirName(path: string): string {
  const parts = path.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

export default function TurnChangesCard({
  item,
  onReview
}: {
  item: TurnChangesItem
  onReview: (path?: string) => void
}): JSX.Element | null {
  // cwd 直接从 store 取：调用点在 Transcript 的行渲染函数里，那儿拿不到组件
  // 作用域的 cwd，与其把它一路透传下来，不如卡片自己订阅。
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reverted, setReverted] = useState(false)

  if (item.files.length === 0) return null
  const shown = expanded ? item.files : item.files.slice(0, FILES_SHOWN)
  const rest = item.files.length - shown.length

  const revertAll = async (): Promise<void> => {
    setConfirming(false)
    setReverting(true)
    setError(null)
    const failed: string[] = []
    for (const f of item.files) {
      try {
        // gitRevertFile 失败以抛异常表达（返回 void）。
        await window.api.gitRevertFile(cwd, f.path, f.untracked === true)
      } catch {
        failed.push(f.path)
      }
    }
    setReverting(false)
    if (failed.length > 0) setError(`${failed.length} 个文件还原失败：${failed.slice(0, 2).map(fileName).join('、')}`)
    else setReverted(true)
  }

  return (
    <div className="tran-ai-col px-6 py-1.5">
      <div className="rounded-xl border border-border-subtle bg-bg-elev/60">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-zinc-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-zinc-200">
              {reverted ? '已撤销本轮改动' : `本轮编辑 ${item.files.length} 个文件`}
            </div>
            {!reverted && (
              <div className="mt-0.5 flex gap-2 text-[11px] tabular-nums">
                <span className="text-emerald-400">+{item.addedTotal}</span>
                <span className="text-red-400">-{item.removedTotal}</span>
              </div>
            )}
          </div>
          {!reverted && (
            <>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={reverting}
                className="shrink-0 rounded-lg px-2.5 py-1 text-[11px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
              >
                {reverting ? '撤销中…' : '撤销 ↺'}
              </button>
              <button
                type="button"
                onClick={() => onReview()}
                className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-white/[0.06]"
              >
                审核
              </button>
            </>
          )}
        </div>

        {!reverted && (
          <div className="border-t border-white/[0.05]">
            {shown.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onReview(f.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-white/[0.03]"
                title={f.path}
              >
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                  {dirName(f.path) && <span className="text-zinc-600">{dirName(f.path)}/</span>}
                  <span className="text-zinc-300">{fileName(f.path)}</span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-emerald-400">+{f.added}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-red-400">-{f.removed}</span>
              </button>
            ))}
            {rest > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full px-3 py-1.5 text-left text-[11px] text-zinc-500 transition hover:text-zinc-300"
              >
                再显示 {rest} 个文件 ⌄
              </button>
            )}
          </div>
        )}

        {error && <div className="px-3 pb-2 text-[11px] text-red-400">{error}</div>}
      </div>

      <ConfirmDialog
        open={confirming}
        title="撤销本轮改动"
        message={`将把这 ${item.files.length} 个文件还原到本轮开始前的状态，不可恢复。`}
        confirmLabel="撤销"
        danger
        onConfirm={() => void revertAll()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
