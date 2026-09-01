import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../store/sessionStore'
import type { ClaudeExecutionBackend, Project, ProjectPatch } from '../../shared/ipc'
import Collapse from './Collapse'
import HoverTip from './HoverTip'
import { showInlineContextMenu, type InlineMenuItem } from './InlineContextMenu'
import { isWslProjectPath, normalizeCwdForCompare } from '../../shared/paths'
import { emitForgeEvent, onForgeEvent } from '../events'

const FolderIcon = (): JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
const PlusIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)
const EditIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)
const TrashIcon = (): JSX.Element => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
    <path
      d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const ChevronIcon = ({ up }: { up: boolean }): JSX.Element => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
    <path
      d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const HomeIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M3 11.5 12 4l9 7.5M5.5 10v9a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-9"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const PROJECT_SWITCHER_CLOSE_ELEVATION_MS = 560

/** 项目外观预设色（2026-09-01 一等实体化：右键菜单选色，图标先不做）。 */
const PROJECT_PRESET_COLORS: { label: string; value: string }[] = [
  { label: '琥珀', value: '#f59e0b' },
  { label: '红', value: '#ef4444' },
  { label: '绿', value: '#22c55e' },
  { label: '蓝', value: '#3b82f6' },
  { label: '紫', value: '#a855f7' },
  { label: '粉', value: '#ec4899' }
]

function normalizePickedProjectPath(path: string, backend: ClaudeExecutionBackend): string {
  if (backend !== 'wsl') return path
  return path.replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\')
}

export default function ProjectSwitcher(): JSX.Element | null {
  const meta = useSessionStore((s) => s.meta)
  const switchProject = useSessionStore((s) => s.switchProject)
  const switchToScratch = useSessionStore((s) => s.switchToScratch)
  const reset = useSessionStore((s) => s.reset)

  const [projects, setProjects] = useState<Project[]>([])
  const [open, setOpen] = useState(false)
  const [elevated, setElevated] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /** portal 面板的 fixed 坐标（开时按 chip 现位置算一次，滚动/缩放即收）。 */
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!open) {
      setPanelPos(null)
      return
    }
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect) {
      setPanelPos({
        top: rect.bottom + 6,
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 256 - 8))
      })
    }
    const close = (): void => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
  // 文件选择器等待指示（局部小字，替代整屏转圈）。
  const [picking, setPicking] = useState(false)
  const elevationTimerRef = useRef<number | null>(null)
  const projectActionSeqRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setProjects(await window.api.listProjects())
    } catch {
      /* ignore */
    }
  }, [])

  // 主目录路径（合并「12517 / C:\Users\xxx」注册项目行与「不在项目中工作」
  // 行用，2026-08-27 用户：两者是同一个 cwd，下拉里只留后者一行）。
  const [homeDir, setHomeDir] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.getHomeDir().then((h) => {
      if (alive) setHomeDir(h)
    })
    return () => {
      alive = false
    }
  }, [])

  const refreshWslSupport = useCallback(async (): Promise<void> => {
    try {
      const prefs = await window.api.getPreferences()
      setWslSupportEnabled(!!prefs.wslSupportEnabled)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, meta?.cwd])

  useEffect(() => {
    void refreshWslSupport()
    return onForgeEvent('wslSupportChanged', refreshWslSupport)
  }, [refreshWslSupport])

  useEffect(() => {
    if (elevationTimerRef.current !== null) {
      window.clearTimeout(elevationTimerRef.current)
      elevationTimerRef.current = null
    }

    if (open) {
      setElevated(true)
      return
    }

    elevationTimerRef.current = window.setTimeout(() => {
      elevationTimerRef.current = null
      setElevated(false)
    }, PROJECT_SWITCHER_CLOSE_ELEVATION_MS)

    return () => {
      if (elevationTimerRef.current !== null) {
        window.clearTimeout(elevationTimerRef.current)
        elevationTimerRef.current = null
      }
    }
  }, [open])

  // #14 归一化比较：meta.cwd 可能来自 session/list（正斜杠形式），与项目
  // 列表里的反斜杠路径 === 永不匹配，选中高亮/当前项目判定会失效。
  // 2026-09-01：cwd 命中项目 rootPaths 任一条即算该项目。
  const currentCwd = meta?.cwd ? normalizeCwdForCompare(meta.cwd) : null
  const current = currentCwd
    ? projects.find((p) =>
        p.rootPaths.some((root) => normalizeCwdForCompare(root) === currentCwd)
      ) ?? null
    : null
  // cwd 不在已添加项目里 = 无项目会话（Codex 的 "no project" 形态），
  // 标签直说，不再拿目录末段冒充项目名；完整路径挂 HoverTip 气泡。
  const currentLabel = current?.name ?? '无项目'

  /** 「不在项目中工作」（2026-09-01 Codex 化第 2 期）：会话落进新建的独立
   *  scratch 目录（Documents/Tran/<日期>/session-…），不再占主目录，也不进
   *  项目列表。每次点击都是一个新会话目录（Codex 的 new scratch thread 语义）；
   *  历史主目录会话不受影响（侧栏仍按 cwd 列出）。 */
  const switchToNoProject = async (): Promise<void> => {
    ++projectActionSeqRef.current
    setOpen(false)
    void switchToScratch()
  }

  const inferBackendFromPath = (
    path: string,
    fallback: ClaudeExecutionBackend
  ): ClaudeExecutionBackend =>
    isWslProjectPath(path, { includePosixAbsolute: true }) ? 'wsl' : fallback

  const addNew = async (backend: ClaudeExecutionBackend): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    setOpen(false)
    setPicking(true)
    let dir: string | null = null
    try {
      dir = await window.api.pickDirectory({ backend })
    } finally {
      setPicking(false)
    }
    if (!dir) return
    if (projectActionSeqRef.current !== actionSeq) return
    const targetBackend = inferBackendFromPath(dir, backend)
    await window.api.savePreferences({
      claudeExecutionBackend: targetBackend,
      ...(targetBackend === 'wsl' ? { wslSupportEnabled: true } : {})
    })
    if (projectActionSeqRef.current !== actionSeq) return
    emitForgeEvent('providerChanged')
    emitForgeEvent('modelOptionsChanged')
    if (targetBackend === 'wsl') emitForgeEvent('wslSupportChanged')
    const list = await window.api.addProject(dir)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
    const normalizedDir = normalizePickedProjectPath(dir, targetBackend)
    const saved = list.find((p) =>
      p.rootPaths.some((root) => normalizeCwdForCompare(root) === normalizeCwdForCompare(normalizedDir))
    )
    void switchProject(saved?.rootPaths[0] ?? normalizedDir)
  }

  const onSwitch = (p: Project): void => {
    ++projectActionSeqRef.current
    setOpen(false)
    if (current?.id === p.id) return
    void switchProject(p.rootPaths[0])
  }

  const commitRename = async (id: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    const list = await window.api.renameProject(id, editText)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
    setEditingId(null)
  }

  const doRemove = async (id: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    setConfirmId(null)
    const list = await window.api.removeProject(id)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
    if (current?.id === id) {
      if (list[0]?.rootPaths[0]) void switchProject(list[0].rootPaths[0])
      else reset() // removed the last project → back to Onboarding
    }
  }

  /** 外观/置顶补丁（右键菜单入口）。updateProject 返回最新列表，原地替换。 */
  const applyPatch = async (id: string, patch: ProjectPatch): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    const list = await window.api.updateProject(id, patch)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
  }

  /** 「在 worktree 中隔离运行」（2026-09-01 第 4 期）：建 worktree 起新会话，
   *  归属覆盖/台账回填由 sessionStore.switchToWorktree 串起。 */
  const startWorktreeSession = (p: Project): void => {
    ++projectActionSeqRef.current
    setOpen(false)
    void useSessionStore.getState().switchToWorktree(p)
  }

  /** 项目行右键菜单（2026-09-01）：置顶/取消置顶 + 预设色点（图标先不做）。
   *  2026-09-01 第 4 期：git 项目追加「在 worktree 中隔离运行」——是否 git
   *  仓库要异步查，查到才拼菜单（非 git 项目该项不出现）。 */
  const showProjectMenu = async (p: Project, e: MouseEvent<HTMLElement>): Promise<void> => {
    // 先挡默认菜单/冒泡：下面的 isGitRepo 是异步的，showInlineContextMenu
    // 自带的 preventDefault 等不到它回来。
    e.preventDefault()
    e.stopPropagation()
    const isGit = await window.api.isGitRepo(p.rootPaths[0] ?? '').catch(() => false)
    const items: InlineMenuItem[] = [
      ...(isGit
        ? [{ label: '在 worktree 中隔离运行', action: () => startWorktreeSession(p) }]
        : []),
      {
        label: p.pinned ? '取消置顶' : '置顶',
        action: () => void applyPatch(p.id, { pinned: !p.pinned })
      },
      ...PROJECT_PRESET_COLORS.map((c) => ({
        label: `${p.appearance?.color === c.value ? '✓ ' : ''}${c.label}`,
        swatch: c.value,
        action: () => void applyPatch(p.id, { appearance: { color: c.value } })
      })),
      ...(p.appearance?.color
        ? [{ label: '清除颜色', action: () => void applyPatch(p.id, { appearance: { color: '' } }) }]
        : [])
    ]
    showInlineContextMenu(e, items)
  }

  // 标题栏项目 chip（2026-08-26 从侧栏顶部搬进 WindowTitlebar，用户要求
  // 「显眼点」）：文件夹 + 项目名（无项目会话显示「无项目」）+ chevron，
  // 带底色/描边/hover 的按钮态，不再是纯展示文本。
  const trigger = (
    <HoverTip
      tip={picking ? '正在打开文件选择器…' : (current?.rootPaths[0] ?? meta?.cwd ?? '')}
      tipClassName="break-all text-left"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 max-w-56 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-zinc-200 transition hover:bg-white/[0.09] hover:text-zinc-50"
      >
        {picking ? (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-white/20 border-t-accent" />
        ) : (
          <FolderIcon />
        )}
        <span className="truncate">{picking ? '正在打开文件选择器…' : currentLabel}</span>
        <span className="shrink-0 text-zinc-500">
          <ChevronIcon up={open} />
        </span>
      </button>
    </HoverTip>
  )

  const addProjectBackends: ClaudeExecutionBackend[] = wslSupportEnabled
    ? ['windows', 'wsl']
    : ['windows']

  // 置顶项目排在前面（组内保持主进程给的 order/createdAt 顺序——sort 稳定）。
  const orderedProjects = [...projects].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

  // 共享的项目列表 + 「添加」行：`open` 驱动外层 Collapse 的开合动画，
  // 行内容进来就是定稿（不做逐行 stagger，见下方行内注释）。
  const listContent = (
    <>
      <div className="max-h-60 overflow-y-auto">
        {projects.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-600">还没有项目</div>
        )}
        {/* 主目录若被注册成了项目，这里滤掉——它和下面的「不在项目中工作」
            是同一个 cwd，只留那一行（2026-08-27 用户拍板合并）。 */}
        {orderedProjects
          .filter((p) => !homeDir || !p.rootPaths.some((root) => normalizeCwdForCompare(root) === normalizeCwdForCompare(homeDir)))
          .map((p) => {
          const isCurrent = current?.id === p.id
          const editing = editingId === p.id
          const confirming = confirmId === p.id
          return (
            // 2026-08：删掉逐行 stagger 级联。逐行延迟淡入会让每一项的截断宽度
            // 在动画期间反复变化（用户截图反馈"点开之后内容一直在变"），
            // 开合动画交给外层 Collapse 一次做完，行内容进来就是定稿。
            <div key={p.id} className="group relative">
              {editing ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    // 输入法组词中的 Enter 是确认候选，不能当成提交项目重命名。
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter') void commitRename(p.id)
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={() => void commitRename(p.id)}
                  className="my-0.5 h-8 w-full rounded-xl border border-accent/70 bg-bg-base/80 px-2.5 text-[11px] text-zinc-100 outline-none"
                />
              ) : (
                <button
                  onClick={() => void onSwitch(p)}
                  onContextMenu={(e) => void showProjectMenu(p, e)}
                  className={`flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1 text-left text-[11px] transition ${
                    isCurrent
                      ? 'glass-active text-zinc-100'
                      : 'text-zinc-400 hover:bg-white/[0.055] hover:text-zinc-200'
                  }`}
                >
                  {/* 项目色点（外观设置优先），否则沿用「当前项目」指示点。 */}
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      p.appearance?.color ? '' : isCurrent ? 'bg-accent' : 'bg-transparent'
                    }`}
                    style={p.appearance?.color ? { background: p.appearance.color } : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-[10px] text-zinc-600">{p.rootPaths[0]}</span>
                  </span>
                </button>
              )}

              {!editing && (
                <div
                  className={`absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition ${
                    confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {confirming ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void doRemove(p.id)
                        }}
                        className="rounded bg-red-950/80 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/80"
                      >
                        删除
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmId(null)
                        }}
                        className="rounded bg-bg-base/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-bg-hover"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <HoverTip tip="重命名">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingId(p.id)
                            setEditText(p.name)
                          }}
                          aria-label="重命名"
                          className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                        >
                          <EditIcon />
                        </button>
                      </HoverTip>
                      <HoverTip tip="删除">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setConfirmId(p.id)
                          }}
                          aria-label="删除"
                          className="rounded-lg p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
                        >
                          <TrashIcon />
                        </button>
                      </HoverTip>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-0.5 border-t border-white/[0.06] pt-0.5">
        {/* 无项目入口（Codex 同款 "work without a project"）：2026-09-01 第 2 期起
            cwd 落到新建的独立 scratch 目录（原来是主目录），不进项目列表。 */}
        <button
          type="button"
          onClick={() => void switchToNoProject()}
          className="mb-0.5 flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1 text-left text-[11px] text-zinc-400 transition hover:bg-white/[0.055] hover:text-zinc-200"
        >
          <HomeIcon />
          <span className="min-w-0 flex-1">
            <span className="block truncate">不在项目中工作</span>
            <span className="block truncate text-[10px] text-zinc-600">新建独立工作目录，不占用项目位</span>
          </span>
        </button>
        <div
          className={`grid ${
            wslSupportEnabled ? 'grid-cols-2' : 'grid-cols-1'
          } gap-1.5`}
        >
          {addProjectBackends.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => void addNew(item)}
              className="project-add-button flex min-h-8 items-center gap-1.5 rounded-xl px-2 py-1 text-left text-[11px] text-zinc-300 transition-all duration-[360ms] ease-spring hover:text-zinc-100"
            >
              <PlusIcon /> {item === 'wsl' ? 'WSL' : 'Windows'}
            </button>
          ))}
        </div>
      </div>
    </>
  )

  // meta 为空 = Onboarding 首跑（启动自动进入上次项目恢复后，只有首次运行
  // 没有 meta）：此时不渲染 chip，避免在 Onboarding 上叠一个切换入口。
  if (!meta) return null

  // 面板以浮层形式挂在 chip 正下方（下拉式），不再像侧栏时代那样就地撑开
  // 框架——标题栏没有流式空间可占。整体 no-drag：标题栏是窗口拖拽区，
  // 不标的话 chip 和面板都点不动（同标题栏「显示侧边栏」按钮的处理）。
  return (
    <div
      ref={rootRef}
      className={`project-switcher-root relative ${elevated ? 'is-elevated' : ''}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {trigger}
      {/* 2026-08-27 下拉 portal 到 body：合体布局里标题栏与正文同列，absolute
          面板 z-50/70 会被正文（virtuoso 定位行等）压在下面——看着像"透明"，
          点击也全落在正文上（用户实测「根本没办法改变项目」）。portal + fixed
          + z-[100] 与 GroupNoteText/InlineContextMenu 同一层。 */}
      {open && panelPos && (
        <div className="fixed inset-0 z-[95]" onClick={() => setOpen(false)} />
      )}
      {open &&
        panelPos &&
        createPortal(
          <div className="fixed z-[100] w-64" style={{ top: panelPos.top, left: panelPos.left }}>
            <Collapse open={open}>
              <div
                className="glass-panel-soft project-switcher-panel rounded-2xl p-1.5"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {listContent}
              </div>
            </Collapse>
          </div>,
          document.body
        )}
    </div>
  )
}
