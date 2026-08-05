import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitFileChange, GitWorkingChanges } from '../../shared/ipc'
import DiffView from './DiffView'
import ConfirmDialog from './ConfirmDialog'
import { langForPath } from './CodeBlock'

/**
 * 会话级"改动"面板（Codex 风格）：工作区相对 HEAD 的全部改动聚合视图。
 * 文件列表 + 逐文件懒加载 diff（点击展开），可单文件还原。
 *
 * 数据全部来自主进程 git 封装（gitWorkingChanges / gitFileDiff /
 * gitRevertFile），面板自身不持久化任何状态——挂载即拉取，refreshKey
 * 变化（GitToolbar 的 status 计数变了）时静默刷新。
 */

interface ChangesPanelProps {
  cwd: string
  /** 外部状态变化信号：值变了就刷新（不比较内容，只比较引用/值）。 */
  refreshKey: string
  onClose: () => void
}

const STATUS_META: Record<GitFileChange['status'], { letter: string; cls: string; label: string }> = {
  modified: { letter: 'M', cls: 'text-blue-400', label: '已修改' },
  added: { letter: 'A', cls: 'text-emerald-400', label: '新增' },
  deleted: { letter: 'D', cls: 'text-red-400', label: '已删除' },
  renamed: { letter: 'R', cls: 'text-purple-400', label: '重命名' },
  untracked: { letter: 'U', cls: 'text-emerald-400', label: '未跟踪' },
  conflicted: { letter: '!', cls: 'text-red-400', label: '冲突' }
}

/** 路径拆成"目录/"+"文件名"两段渲染：目录压暗，文件名提亮。 */
function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return { dir: '', base: path }
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) }
}

export default function ChangesPanel({ cwd, refreshKey, onClose }: ChangesPanelProps): JSX.Element {
  const [changes, setChanges] = useState<GitWorkingChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** path → diff 文本；null 表示加载中。判废用整体清空。 */
  const [diffs, setDiffs] = useState<Record<string, string | null>>({})
  const [confirmRevert, setConfirmRevert] = useState<GitFileChange | null>(null)
  const [reverting, setReverting] = useState(false)
  // 切目录/刷新竞态：迟到的响应不覆盖新目录的数据
  const loadSeqRef = useRef(0)

  const load = useCallback(
    (opts?: { keepDiffs?: boolean }): void => {
      const seq = ++loadSeqRef.current
      void window.api
        .gitWorkingChanges(cwd)
        .then((result) => {
          if (loadSeqRef.current !== seq) return
          setChanges(result)
          setError(null)
          // 文件内容可能已变：默认作废已加载的 diff（保留展开状态，重新懒加载）
          if (!opts?.keepDiffs) setDiffs({})
        })
        .catch((e: unknown) => {
          if (loadSeqRef.current !== seq) return
          setError(e instanceof Error ? e.message : String(e))
        })
    },
    [cwd]
  )

  useEffect(() => {
    setChanges(null)
    setExpanded(null)
    setDiffs({})
    load()
  }, [cwd, load])

  // GitToolbar 的 status 计数变化（agent 改了文件 / 用户暂存等）→ 静默刷新
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey 是唯一触发源
  }, [refreshKey])

  const toggleFile = (file: GitFileChange): void => {
    const next = expanded === file.path ? null : file.path
    setExpanded(next)
    if (next && diffs[file.path] === undefined) {
      setDiffs((d) => ({ ...d, [file.path]: null }))
      void window.api
        .gitFileDiff(cwd, file.path, {
          untracked: file.status === 'untracked',
          ...(file.oldPath ? { oldPath: file.oldPath } : {})
        })
        .then((text) => {
          setDiffs((d) => ({ ...d, [file.path]: text || '[无差异内容]' }))
        })
        .catch((e: unknown) => {
          setDiffs((d) => ({ ...d, [file.path]: `[diff 加载失败：${e instanceof Error ? e.message : String(e)}]` }))
        })
    }
  }

  const doRevert = async (): Promise<void> => {
    const file = confirmRevert
    if (!file) return
    setReverting(true)
    try {
      await window.api.gitRevertFile(cwd, file.path, file.status === 'untracked', {
        status: file.status,
        ...(file.oldPath ? { oldPath: file.oldPath } : {})
      })
      setConfirmRevert(null)
      if (expanded === file.path) setExpanded(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirmRevert(null)
    } finally {
      setReverting(false)
    }
  }

  const files = changes?.files ?? []

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* 头部：标题 + 总计 + 刷新/关闭 */}
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">工作区改动</span>
          {changes && files.length > 0 && (
            <span className="text-[10px] text-zinc-500">
              {files.length} 个文件
              <span className="ml-1.5 text-emerald-400">+{changes.totalAdditions}</span>
              <span className="ml-1 text-red-400">−{changes.totalDeletions}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => load({ keepDiffs: false })}
            className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-300"
            title="刷新"
          >
            刷新
          </button>
          <button onClick={onClose} className="rounded px-1 py-0.5 text-zinc-600 transition hover:text-zinc-300" title="关闭">
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {/* 列表 */}
      {!changes && !error && <div className="py-6 text-center text-[11px] text-zinc-500 animate-pulse">读取改动中…</div>}
      {changes && files.length === 0 && (
        <div className="py-6 text-center text-[11px] text-zinc-500">工作区干净，没有未提交的改动</div>
      )}
      {files.length > 0 && (
        <div className="git-stable-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {files.map((file) => {
            const meta = STATUS_META[file.status]
            const { dir, base } = splitPath(file.path)
            const isOpen = expanded === file.path
            const diff = diffs[file.path]
            return (
              <div key={file.path} className="mb-0.5">
                <div
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.05] ${
                    isOpen ? 'bg-white/[0.04]' : ''
                  }`}
                  onClick={() => toggleFile(file)}
                >
                  <span className={`w-3 shrink-0 text-center font-mono font-semibold ${meta.cls}`} title={meta.label}>
                    {meta.letter}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
                    {dir && <span className="text-zinc-600">{dir}</span>}
                    <span className="text-zinc-300">{base}</span>
                  </span>
                  {file.binary ? (
                    <span className="shrink-0 text-[10px] text-zinc-600">二进制</span>
                  ) : (
                    (file.additions !== null || file.deletions !== null) && (
                      <span className="shrink-0 font-mono text-[10px]">
                        {file.additions !== null && <span className="text-emerald-400">+{file.additions}</span>}
                        {file.deletions !== null && <span className="ml-1 text-red-400">−{file.deletions}</span>}
                      </span>
                    )
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmRevert(file)
                    }}
                    className="shrink-0 rounded px-1 py-0.5 text-[10px] text-zinc-600 opacity-0 transition hover:bg-white/[0.08] hover:text-red-300 group-hover:opacity-100"
                    title={file.status === 'untracked' ? '删除此文件' : '还原到 HEAD'}
                  >
                    还原
                  </button>
                </div>
                {isOpen && (
                  <div className="mb-1.5 ml-5 mt-1 max-h-[32vh] overflow-auto rounded-lg border border-white/[0.06] bg-black/20">
                    {diff === null || diff === undefined ? (
                      <div className="px-3 py-4 text-center text-[11px] text-zinc-500 animate-pulse">加载 diff…</div>
                    ) : (
                      <DiffView text={diff} {...(langForPath(file.path) ? { lang: langForPath(file.path) } : {})} />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmRevert}
        title={confirmRevert?.status === 'untracked' ? '删除未跟踪文件' : '还原文件'}
        message={
          confirmRevert?.status === 'untracked'
            ? `将从磁盘删除 ${confirmRevert?.path}。\n此操作不可恢复。`
            : `将把 ${confirmRevert?.path} 的暂存与工作区内容都还原到 HEAD。\n未提交的改动会丢失，此操作不可恢复。`
        }
        confirmLabel={reverting ? '处理中…' : '还原'}
        danger
        onConfirm={() => void doRevert()}
        onCancel={() => setConfirmRevert(null)}
      />
    </div>
  )
}
