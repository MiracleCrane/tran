import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitFileChange } from '../../shared/ipc'
import { useSessionStore } from '../store/sessionStore'
import { openChangesPanel } from '../events'

/**
 * 输入框正上方的「N 个文件已更改 +X -Y」悬浮胶囊（Codex 同款）。
 *
 * 口径（2026-08-14 用户拍板）：只算**本会话**造成的改动——并集来自对话流里
 * 每张 TurnChangesCard 的文件清单（轮开始/结束的 git 快照差，见 sessionStore
 * 的 #TurnChanges）。工作区里别人/别的会话改的文件不再算进来；这个对话一行
 * 没改就整枚隐藏。注意没改的文件若后来被还原回 HEAD，numstat 里查无此项，
 * 自然也不再显示。
 *
 * 数据走 gitWorkingChanges（git diff --numstat，无网络无写盘）。轮跑动时每 4 秒
 * 一次、轮结束补一次；非 git 目录或 git 不可用时整枚隐藏，不打扰。
 */

const POLL_MS = 4000
const FILES_SHOWN = 8

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export default function SessionChangesPill(): JSX.Element | null {
  const cwd = useSessionStore((s) => s.meta?.cwd ?? '')
  const running = useSessionStore((s) => s.status.running)
  // 本会话改过的文件集合：对话流里所有 turnChanges 卡片的并集。路径两边同出
  // gitWorkingChanges，格式一致可直接比。
  const sessionPaths = useSessionStore((s) => {
    let key = ''
    for (const it of s.items) {
      if (it.kind !== 'turnChanges') continue
      for (const f of it.files) key += `${f.path}`
    }
    return key
  })
  const sessionPathSet = useMemo(
    () => new Set(sessionPaths ? sessionPaths.split('') : []),
    [sessionPaths]
  )
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [open, setOpen] = useState(false)
  // 切目录/并发刷新竞态：迟到的响应不许覆盖新目录的数据（同 ChangesPanel）。
  const seqRef = useRef(0)

  const load = useCallback((): void => {
    if (!cwd) {
      setFiles([])
      return
    }
    const seq = ++seqRef.current
    const target = cwd
    void window.api
      .gitWorkingChanges(target)
      .then((res) => {
        if (seqRef.current !== seq) return
        setFiles(res.files)
      })
      .catch(() => {
        if (seqRef.current !== seq) return
        // 非 git 目录 / git 不可用：静默隐藏。
        setFiles([])
      })
  }, [cwd])

  useEffect(() => {
    setFiles([])
    setOpen(false)
    load()
  }, [cwd, load])

  // 轮结束（running 由 true 变 false）会走这里补一次；跑动期间再挂个轮询，
  // 让计数跟着模型的编辑往上走，而不是等一轮跑完才跳一下。
  useEffect(() => {
    load()
    if (!running) return
    const timer = window.setInterval(load, POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, load])

  // 用户自己在别处改了文件（外部编辑器、终端）也该反映出来。
  useEffect(() => {
    const onFocus = (): void => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // 会话口径过滤：本会话没碰过的文件不进计数；这个对话一行没改 → 整枚隐藏。
  const sessionFiles = sessionPathSet.size > 0 ? files.filter((f) => sessionPathSet.has(f.path)) : []
  const counted = sessionFiles.filter((f) => !f.binary)
  const addedTotal = counted.reduce((n, f) => n + (f.additions ?? 0), 0)
  const removedTotal = counted.reduce((n, f) => n + (f.deletions ?? 0), 0)
  if (sessionFiles.length === 0) return null

  const shown = sessionFiles.slice(0, FILES_SHOWN)
  const rest = sessionFiles.length - shown.length
  const review = (path?: string): void => {
    setOpen(false)
    openChangesPanel(path)
  }

  return (
    <div className="pointer-events-none relative z-20 flex justify-center">
      <div
        className="pointer-events-auto relative"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {open && (
          <div className="absolute bottom-full left-1/2 mb-2 w-[min(420px,70vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border-subtle bg-bg-elev shadow-xl shadow-black/40">
            {shown.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => review(f.path)}
                title={f.path}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition hover:bg-white/[0.05]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{fileName(f.path)}</span>
                {f.binary ? (
                  <span className="shrink-0 text-[11px] text-zinc-500">二进制</span>
                ) : (
                  <>
                    <span className="shrink-0 text-[11px] tabular-nums text-emerald-400">+{f.additions ?? 0}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-red-400">-{f.deletions ?? 0}</span>
                  </>
                )}
              </button>
            ))}
            {rest > 0 && (
              <div className="border-t border-white/[0.05] px-3 py-1.5 text-[11px] text-zinc-500">
                还有 {rest} 个文件…
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => review()}
          title="查看本次会话的工作区改动"
          className="mb-1.5 flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elev px-3.5 py-1.5 text-[12px] text-zinc-300 shadow-lg shadow-black/30 transition hover:bg-bg-hover"
        >
          <span>本会话 {sessionFiles.length} 个文件已更改</span>
          <span className="tabular-nums text-emerald-400">+{addedTotal}</span>
          <span className="tabular-nums text-red-400">-{removedTotal}</span>
        </button>
      </div>
    </div>
  )
}
