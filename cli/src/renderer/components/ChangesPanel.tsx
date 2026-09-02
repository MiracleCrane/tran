import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitFileChange, GitWorkingChanges } from '../../shared/ipc'
import DiffView from './DiffView'
import ConfirmDialog from './ConfirmDialog'
import { langForPath } from './CodeBlock'
import HoverTip from './HoverTip'
import { isAbsolutePath, normalizePath, relativePathTo, type ChangesGitGroup } from '../gitTarget'
import { pathToUserAttachment, pickedFileToUserAttachment } from '../utils/attachments'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'

/**
 * 会话级"改动"面板（Codex 风格）：工作区相对 HEAD 的全部改动聚合视图。
 * 文件列表 + 逐文件懒加载 diff（点击展开），可单文件还原。
 *
 * 数据全部来自主进程 git 封装（gitWorkingChanges / gitFileDiff /
 * gitRevertFile），面板自身不持久化任何状态——挂载即拉取，refreshKey
 * 变化（GitToolbar 的 status 计数变了）时静默刷新。
 *
 * 2026-09-02 分组改动面板：会话改动同时落在多个 git 工作区时（无项目
 * scratch 会话改了自己目录 + 又改了别的仓库），按仓库根分组渲染，每组
 * 一个组头、用自己的 root 出 diff；root=null 的组（不在任何 git 仓库的
 * 文件）没有仓库可出 diff，点击改为打开文件预览。只有主仓库一个组时
 * 不套组头，外观与分组前完全一致（纯 scratch / 单仓库会话零变化）。
 */

interface ChangesPanelProps {
  /** 主仓库根（改动多数派仓库 ?? 工具条全局仓库），一定有值（非 git 目录走不到这里）。 */
  cwd: string
  /** 会话改动按仓库根的分组（sessionStore.changesGitGroups，与 changesGitRoot 同一次重算产出）。 */
  groups?: ChangesGitGroup[]
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

/** 仓库根显示名（目录 basename），组头用。 */
function repoBaseName(root: string): string {
  return normalizePath(root).split('/').pop() ?? root
}

/** 仓库根等值比较：归一化 + 大小写不敏感（Windows）。 */
function sameRepoRoot(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
}

type PanelSection =
  | { kind: 'repo'; key: string; root: string }
  | { kind: 'nogit'; key: string; files: string[] }

/** 各组上报的计数，面板头部聚合成「N 个文件 +X −Y」。 */
interface SectionStats {
  n: number
  add: number
  del: number
}

export default function ChangesPanel({ cwd, groups, refreshKey, initialPath, initialRequestKey, onClose }: ChangesPanelProps): JSX.Element {
  // 手动刷新序号：串进 refreshKey 下发给各组（面板头的「刷新」按钮）。
  const [manualRefreshSeq, setManualRefreshSeq] = useState(0)
  const [statsBySection, setStatsBySection] = useState<Record<string, SectionStats>>({})

  // 主仓库 = cwd；groups 里 root 与主仓库相同的组滤掉（主仓库的工作区视图
  // 就是那一组）。只剩主仓库时 grouped=false，单组渲染不套组头。
  const extraGroups = (groups ?? []).filter((g) => !(g.root && sameRepoRoot(g.root, cwd)))
  const grouped = extraGroups.length > 0
  const sections = useMemo<PanelSection[]>(
    () => [
      { kind: 'repo', key: normalizePath(cwd).toLowerCase(), root: cwd },
      ...extraGroups.map((g): PanelSection =>
        g.root
          ? { kind: 'repo', key: normalizePath(g.root).toLowerCase(), root: g.root }
          : { kind: 'nogit', key: '__nogit__', files: g.files }
      )
    ],
    // extraGroups 由 groups 派生，groups 是 store 里的稳定引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, groups]
  )

  // 组集合变了（重算/切会话）清掉已消失组的计数，避免头部总数混入旧组。
  useEffect(() => {
    setStatsBySection((prev) => {
      const next: Record<string, SectionStats> = {}
      for (const sec of sections) {
        const cur = prev[sec.key]
        if (cur) next[sec.key] = cur
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [sections])

  const reportStats = useCallback((key: string, st: SectionStats): void => {
    setStatsBySection((prev) => {
      const cur = prev[key]
      if (cur && cur.n === st.n && cur.add === st.add && cur.del === st.del) return prev
      return { ...prev, [key]: st }
    })
  }, [])

  const totals = Object.values(statsBySection).reduce<SectionStats>(
    (acc, s) => ({ n: acc.n + s.n, add: acc.add + s.add, del: acc.del + s.del }),
    { n: 0, add: 0, del: 0 }
  )

  // initialPath 折算（2026-09-02 分组版）：先找到它属于哪组再折算成组内
  // 相对路径。落在 root=null 组 → 该组滚动定位（无 diff 可展开）；绝对路径
  // 但哪组都不属于 → 维持旧行为：挂进主仓库列表当合成条目 + 提示。
  const routed = ((): { key: string; rel: string; outside: boolean } | null => {
    if (!initialPath || initialRequestKey === undefined) return null
    const norm = normalizePath(initialPath)
    if (isAbsolutePath(norm)) {
      for (const sec of sections) {
        if (sec.kind !== 'repo') continue
        const rel = relativePathTo(sec.root, norm)
        if (rel) return { key: sec.key, rel, outside: false }
      }
      const nogit = sections.find((s): s is Extract<PanelSection, { kind: 'nogit' }> => s.kind === 'nogit')
      if (nogit?.files.some((f) => normalizePath(f).toLowerCase() === norm.toLowerCase())) {
        return { key: nogit.key, rel: norm, outside: false }
      }
      return { key: sections[0].key, rel: norm, outside: true }
    }
    // 相对路径：维持旧语义，按主仓库内相对路径处理
    return { key: sections[0].key, rel: norm, outside: false }
  })()

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* 头部：标题 + 总计 + 刷新/关闭 */}
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">工作区改动</span>
          {totals.n > 0 && (
            <span className="text-[10px] text-zinc-500">
              {totals.n} 个文件
              <span className="ml-1.5 text-emerald-400">+{totals.add}</span>
              <span className="ml-1 text-red-400">−{totals.del}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setManualRefreshSeq((n) => n + 1)}
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

      {/* 分组列表（单组时就是唯一的主仓库组，无组头） */}
      <div className="git-stable-scroll min-h-0 flex-1 overflow-y-auto pr-1">
        {sections.map((sec) =>
          sec.kind === 'repo' ? (
            <RepoChangesSection
              key={sec.key}
              root={sec.root}
              showHeader={grouped}
              refreshKey={`${refreshKey}:${manualRefreshSeq}`}
              initialTarget={
                routed && routed.key === sec.key && initialRequestKey !== undefined
                  ? { path: routed.rel, requestKey: initialRequestKey, outside: routed.outside }
                  : undefined
              }
              statsKey={sec.key}
              onStats={reportStats}
            />
          ) : (
            <NonGitFilesSection
              key={sec.key}
              files={sec.files}
              scrollTarget={
                routed && routed.key === sec.key && initialRequestKey !== undefined
                  ? { path: routed.rel, requestKey: initialRequestKey }
                  : undefined
              }
              statsKey={sec.key}
              onStats={reportStats}
            />
          )
        )}
      </div>
    </div>
  )
}

/** 单个 git 仓库的改动组：gitWorkingChanges(root) + 逐文件懒加载 diff + 还原。 */
function RepoChangesSection({
  root,
  showHeader,
  refreshKey,
  initialTarget,
  statsKey,
  onStats
}: {
  root: string
  /** 多组时显示组头（仓库名 + 全路径 HoverTip + 组内计数）。 */
  showHeader: boolean
  refreshKey: string
  /** 路由进来的待定位文件：path 已折算成 root 内相对路径（outside=true 时是兜底绝对路径）。 */
  initialTarget?: { path: string; requestKey: number; outside: boolean }
  statsKey: string
  onStats: (key: string, st: SectionStats) => void
}): JSX.Element {
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
        .gitWorkingChanges(root)
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
    [root]
  )

  useEffect(() => {
    setChanges(null)
    setExpanded(null)
    setDiffs({})
    setExtraFiles([])
    load()
  }, [root, load])

  // GitToolbar 的 status 计数变化（agent 改了文件 / 用户暂存等）→ 静默刷新
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey 是唯一触发源
  }, [refreshKey])

  const ensureFileDiff = (file: GitFileChange): void => {
    if (diffs[file.path] === undefined) {
      setDiffs((d) => ({ ...d, [file.path]: null }))
      void window.api
        .gitFileDiff(root, file.path, {
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
    if (!initialTarget || !changes) return
    if (appliedRequestRef.current === initialTarget.requestKey) return
    // 轮次卡/pill 带进来的路径由面板路由进本组时已折算成 root 内相对路径
    // （2026-09-02 分组版；在此之前是在本 effect 里对单 cwd 折算，见 git 历史）。
    // outside=true 是兜底：文件不属于任何组，按旧行为挂合成条目 + 提示，
    // 不走 IPC 吃「只接受仓库内的相对路径」报错（2026-09-01 用户截图抓包：
    // .scratch/release-v1.1.67.sh 以绝对路径传进来，diff 加载失败）。
    const rel = initialTarget.path
    const file = changes.files.find((entry) => entry.path === rel)
    appliedRequestRef.current = initialTarget.requestKey
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
      if (initialTarget.outside) setDiffs((d) => ({ ...d, [rel]: '[该文件不在当前项目目录内，无法展示 diff]' }))
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
    // `diffs` / `expanded` / `ensureFileDiff` are intentionally excluded: this effect
    // reacts to a new request or file list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTarget, changes, root])

  const doRevert = async (): Promise<void> => {
    const file = confirmRevert
    if (!file) return
    setReverting(true)
    try {
      await window.api.gitRevertFile(root, file.path, file.status === 'untracked', {
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

  // 组计数上报给面板头部聚合（单组时即旧版头部的「N 个文件 +X −Y」）。
  useEffect(() => {
    onStats(statsKey, { n: files.length, add: changes?.totalAdditions ?? 0, del: changes?.totalDeletions ?? 0 })
  }, [changes, extraFiles, statsKey, onStats]) // eslint-disable-line react-hooks/exhaustive-deps -- files 由二者派生

  return (
    <div className={showHeader ? 'mb-2' : ''}>
      {showHeader && (
        <div className="mb-1 flex items-baseline gap-2 border-b border-white/[0.05] px-1 pb-1">
          <HoverTip tip={root} tipClassName="break-all">
            <span className="text-[10px] font-medium text-zinc-400">{repoBaseName(root)}</span>
          </HoverTip>
          {changes && files.length > 0 && (
            <span className="text-[10px] text-zinc-600">
              {files.length} 个文件
              <span className="ml-1.5 text-emerald-400/80">+{changes.totalAdditions}</span>
              <span className="ml-1 text-red-400/80">−{changes.totalDeletions}</span>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-1 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {!changes && !error && <div className="py-6 text-center text-[11px] text-zinc-500 animate-pulse">读取改动中…</div>}
      {changes && files.length === 0 && (
        <div className="py-6 text-center text-[11px] text-zinc-500">工作区干净，没有未提交的改动</div>
      )}
      {files.length > 0 && (
        <div ref={listRef}>
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

/** root=null 组：不在任何 git 仓库的改动文件。没有仓库可出 diff，点击打开文件预览。 */
function NonGitFilesSection({
  files,
  scrollTarget,
  statsKey,
  onStats
}: {
  /** 绝对路径列表（分组函数已归一化、去重、排序）。 */
  files: string[]
  scrollTarget?: { path: string; requestKey: number }
  statsKey: string
  onStats: (key: string, st: SectionStats) => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const appliedRequestRef = useRef<number | null>(null)

  useEffect(() => {
    onStats(statsKey, { n: files.length, add: 0, del: 0 })
  }, [files.length, statsKey, onStats])

  // 轮次卡/pill 带进来的文件落在本组：滚动定位（无 diff 可展开，预览由用户点击触发）。
  useEffect(() => {
    if (!scrollTarget || appliedRequestRef.current === scrollTarget.requestKey) return
    appliedRequestRef.current = scrollTarget.requestKey
    const target = normalizePath(scrollTarget.path).toLowerCase()
    window.requestAnimationFrame(() => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-change-path]') ?? []
      const row = [...rows].find((entry) => normalizePath(entry.dataset.changePath ?? '').toLowerCase() === target)
      row?.scrollIntoView({ block: 'nearest' })
    })
  }, [scrollTarget])

  // 2026-09-02：非 git 目录的文件没有仓库可出 diff，点击改为打开附件预览
  // （与 MessageText 行内路径同一套 loading → readFiles → 内容/错误 流程）。
  const openPreview = (abs: string): void => {
    const open = useUiStore.getState().openAttachmentPreview
    open(pathToUserAttachment(abs, { previewState: 'loading' }))
    const cwd = useSessionStore.getState().meta?.cwd ?? ''
    void window.api
      .readFiles(cwd, [abs])
      .then((picked) => {
        const current = useUiStore.getState().attachmentPreview
        if (current?.path !== abs) return
        open(
          picked[0]
            ? pickedFileToUserAttachment(picked[0])
            : pathToUserAttachment(abs, { previewState: 'error', previewError: '文件或目录不存在，或无法读取。' })
        )
      })
      .catch((e: unknown) => {
        const current = useUiStore.getState().attachmentPreview
        if (current?.path !== abs) return
        open(
          pathToUserAttachment(abs, {
            previewState: 'error',
            previewError: e instanceof Error ? e.message : '文件或目录不存在，或无法读取。'
          })
        )
      })
  }

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-baseline gap-2 border-b border-white/[0.05] px-1 pb-1">
        <span className="text-[10px] font-medium text-zinc-400">未跟踪（非 git 目录）</span>
        <span className="text-[10px] text-zinc-600">{files.length} 个文件</span>
      </div>
      <div ref={listRef}>
        {files.map((abs) => {
          const { dir, base } = splitPath(normalizePath(abs))
          return (
            <div key={abs} data-change-path={abs} className="mb-0.5">
              <div
                className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.05]"
                onClick={() => openPreview(abs)}
              >
                <HoverTip tip="非 git 目录，无 diff 可比；点击预览文件">
                  <span className="w-3 shrink-0 text-center font-mono font-semibold text-zinc-500">◦</span>
                </HoverTip>
                <HoverTip tip={abs} tipClassName="break-all" className="min-w-0 flex-1 truncate font-mono">
                  {dir && <span className="text-zinc-600">{dir}</span>}
                  <span className="text-zinc-300">{base}</span>
                </HoverTip>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
