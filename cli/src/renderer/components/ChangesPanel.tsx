import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitFileChange, GitWorkingChanges } from '../../shared/ipc'
import DiffView from './DiffView'
import ConfirmDialog from './ConfirmDialog'
import { langForPath } from './CodeBlock'
import HoverTip from './HoverTip'

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
  /** 从轮次/会话文件行进入时，加载后自动定位并展开该文件。 */
  initialPath?: string | null
  initialRequestKey?: number
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

export default function ChangesPanel({ cwd, refreshKey, initialPath, initialRequestKey, onClose }: ChangesPanelProps): JSX.Element {
  const [changes, setChanges] = useState<GitWorkingChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** path → diff 文本；null 表示加载中。判废用整体清空。 */
  const [diffs, setDiffs] = useState<Record<string, string | null>>({})
  const [confirmRevert, setConfirmRevert] = useState<GitFileChange | null>(null)
  const [reverting, setReverting] = useState(false)
  /** 从轮次卡/pill 点进来、但不在 git 工作区改动里的文件（gitignored/已提交）：
   *  合成条目挂在列表最前，保证"点了一定有东西展开"。 */
  const [extraFiles, setExtraFiles] = useState<GitFileChange[]>([])
  // 切目录/刷新竞态：迟到的响应不覆盖新目录的数据
  const loadSeqRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const appliedRequestRef = useRef<number | null>(null)

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
    setExtraFiles([])
    load()
  }, [cwd, load])

  // GitToolbar 的 status 计数变化（agent 改了文件 / 用户暂存等）→ 静默刷新
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey 是唯一触发源
  }, [refreshKey])

  const ensureFileDiff = (file: GitFileChange): void => {
    if (diffs[file.path] === undefined) {
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

  const toggleFile = (file: GitFileChange): void => {
    const next = expanded === file.path ? null : file.path
    setExpanded(next)
    if (next) ensureFileDiff(file)
  }

  useEffect(() => {
    if (!initialPath || initialRequestKey === undefined || !changes) return
    if (appliedRequestRef.current === initialRequestKey) return
    // 轮次卡/pill 带进来的可能是绝对路径（agent 工具调用里的原始写法），
    // 而 gitFileDiff 只接受仓库内相对路径——先折算；在仓库外的直接给提示，
    // 不走 IPC 吃「只接受仓库内的相对路径」报错（2026-09-01 用户截图抓包：
    // .scratch/release-v1.1.67.sh 以绝对路径传进来，diff 加载失败）。
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
    let rel = norm(initialPath)
    let outside = false
    if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('//')) {
      const root = norm(cwd) + '/'
      if (rel.toLowerCase().startsWith(root.toLowerCase())) rel = rel.slice(root.length)
      else outside = true
    }
    const file = changes.files.find((entry) => entry.path === rel)
    appliedRequestRef.current = initialRequestKey
    // 不在工作区改动里（gitignored / 已提交）：不能静默放弃——那是轮次卡/pill
    // 点进来"什么都不跳"的根源（2026-08-19 用户抓包）。合成一条未跟踪条目进
    // 列表展开它；diff 由 getFileDiff 兜底合成（tracked 空 → 未跟踪合成）。
    if (!file) {
      const synthetic: GitFileChange = {
        path: rel,
        status: 'untracked',
        additions: null,
        deletions: null,
        binary: false
      }
      setExtraFiles((prev) => (prev.some((f) => f.path === rel) ? prev : [synthetic, ...prev]))
      setExpanded(rel)
      if (outside) setDiffs((d) => ({ ...d, [rel]: '[该文件不在当前项目目录内，无法展示 diff]' }))
      else ensureFileDiff(synthetic)
      return
    }
    setExpanded(file.path)
    ensureFileDiff(file)
    window.requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-change-path]') ?? []
      const row = [...rows].find((entry) => entry.dataset.changePath === file.path)
      row?.scrollIntoView({ block: 'nearest' })
    })
    // `diffs` / `expanded` are intentionally excluded: this effect reacts to a new request or file list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, initialRequestKey, changes, cwd])

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

  // extraFiles（轮次卡/pill 点进来的 gitignored/已提交文件）排在 git 列表前面。
  const files = [...extraFiles, ...(changes?.files ?? [])]

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
            aria-label="刷新"
          >
            {/* 2026-08-25：原生 title= 太丑，统一换 HoverTip 气泡 */}
            <HoverTip tip="刷新">刷新</HoverTip>
          </button>
          <button onClick={onClose} className="rounded px-1 py-0.5 text-zinc-600 transition hover:text-zinc-300" aria-label="关闭">
            <HoverTip tip="关闭">✕</HoverTip>
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
        <div ref={listRef} className="git-stable-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {files.map((file) => {
            const meta = STATUS_META[file.status]
            const { dir, base } = splitPath(file.path)
            const isOpen = expanded === file.path
            const diff = diffs[file.path]
            return (
              <div key={file.path} data-change-path={file.path} className="mb-0.5">
                <div
                  className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.05] ${
                    isOpen ? 'bg-white/[0.04]' : ''
                  }`}
                  onClick={() => toggleFile(file)}
                >
                  <HoverTip tip={meta.label}>
                    <span className={`w-3 shrink-0 text-center font-mono font-semibold ${meta.cls}`}>
                      {meta.letter}
                    </span>
                  </HoverTip>
                  <HoverTip
                    tip={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    tipClassName="break-all"
                    className="min-w-0 flex-1 truncate font-mono"
                  >
                    {dir && <span className="text-zinc-600">{dir}</span>}
                    <span className="text-zinc-300">{base}</span>
                  </HoverTip>
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
                    aria-label={file.status === 'untracked' ? '删除此文件' : '还原到 HEAD'}
                  >
                    <HoverTip tip={file.status === 'untracked' ? '删除此文件' : '还原到 HEAD'}>还原</HoverTip>
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
