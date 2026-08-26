import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { ClaudeExecutionBackend, Project } from '../../shared/ipc'
import Collapse from './Collapse'
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

function normalizePickedProjectPath(path: string, backend: ClaudeExecutionBackend): string {
  if (backend !== 'wsl') return path
  return path.replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\')
}

export default function ProjectSwitcher(): JSX.Element | null {
  const meta = useSessionStore((s) => s.meta)
  const switchProject = useSessionStore((s) => s.switchProject)
  const reset = useSessionStore((s) => s.reset)

  const [projects, setProjects] = useState<Project[]>([])
  const [open, setOpen] = useState(false)
  const [elevated, setElevated] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
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
  const currentCwd = meta?.cwd ? normalizeCwdForCompare(meta.cwd) : null
  const current = currentCwd
    ? projects.find((p) => normalizeCwdForCompare(p.path) === currentCwd) ?? null
    : null
  // cwd 不在已添加项目里 = 无项目会话（Codex 的 "no project" 形态），
  // 标签直说，不再拿目录末段冒充项目名；完整路径仍在 title 上。
  const currentLabel = current?.name ?? '无项目'

  /** 「不在项目中工作」：会话落在用户主目录，不进项目列表（addProject 只收
   *  显式添加的目录——switchProject 不会污染项目列表）。 */
  const switchToNoProject = async (): Promise<void> => {
    ++projectActionSeqRef.current
    setOpen(false)
    const home = await window.api.getHomeDir().catch(() => null)
    if (!home) return
    if (currentCwd && normalizeCwdForCompare(home) === currentCwd) return
    void switchProject(home)
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
    const savedPath = list.find((p) => p.path === normalizedDir)?.path ?? normalizedDir
    void switchProject(savedPath)
  }

  const onSwitch = (path: string): void => {
    ++projectActionSeqRef.current
    setOpen(false)
    if (currentCwd && normalizeCwdForCompare(path) === currentCwd) return
    void switchProject(path)
  }

  const commitRename = async (path: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    const list = await window.api.renameProject(path, editText)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
    setEditingPath(null)
  }

  const doRemove = async (path: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    setConfirmPath(null)
    const list = await window.api.removeProject(path)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    emitForgeEvent('projectsChanged')
    if (currentCwd && normalizeCwdForCompare(path) === currentCwd) {
      if (list[0]) void switchProject(list[0].path)
      else reset() // removed the last project → back to Onboarding
    }
  }

  // 标题栏项目 chip（2026-08-26 从侧栏顶部搬进 WindowTitlebar，用户要求
  // 「显眼点」）：文件夹 + 项目名（无项目会话显示「无项目」）+ chevron，
  // 带底色/描边/hover 的按钮态，不再是纯展示文本。
  const trigger = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={picking ? '正在打开文件选择器…' : (current?.path ?? meta?.cwd ?? '')}
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
  )

  const addProjectBackends: ClaudeExecutionBackend[] = wslSupportEnabled
    ? ['windows', 'wsl']
    : ['windows']

  // 共享的项目列表 + 「添加」行：`open` 驱动外层 Collapse 的开合动画，
  // 行内容进来就是定稿（不做逐行 stagger，见下方行内注释）。
  const listContent = (
    <>
      <div className="max-h-60 overflow-y-auto">
        {projects.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-600">还没有项目</div>
        )}
        {projects.map((p) => {
          const isCurrent = currentCwd !== null && normalizeCwdForCompare(p.path) === currentCwd
          const editing = editingPath === p.path
          const confirming = confirmPath === p.path
          return (
            // 2026-08：删掉逐行 stagger 级联。逐行延迟淡入会让每一项的截断宽度
            // 在动画期间反复变化（用户截图反馈"点开之后内容一直在变"），
            // 开合动画交给外层 Collapse 一次做完，行内容进来就是定稿。
            <div key={p.path} className="group relative">
              {editing ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    // 输入法组词中的 Enter 是确认候选，不能当成提交项目重命名。
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter') void commitRename(p.path)
                    else if (e.key === 'Escape') setEditingPath(null)
                  }}
                  onBlur={() => void commitRename(p.path)}
                  className="my-0.5 h-8 w-full rounded-xl border border-accent/70 bg-bg-base/80 px-2.5 text-[11px] text-zinc-100 outline-none"
                />
              ) : (
                <button
                  onClick={() => void onSwitch(p.path)}
                  className={`flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1 text-left text-[11px] transition ${
                    isCurrent
                      ? 'glass-active text-zinc-100'
                      : 'text-zinc-400 hover:bg-white/[0.055] hover:text-zinc-200'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isCurrent ? 'bg-accent' : 'bg-transparent'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-[10px] text-zinc-600">{p.path}</span>
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
                          void doRemove(p.path)
                        }}
                        className="rounded bg-red-950/80 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/80"
                      >
                        删除
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmPath(null)
                        }}
                        className="rounded bg-bg-base/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-bg-hover"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingPath(p.path)
                          setEditText(p.name)
                        }}
                        className="rounded-lg p-1 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
                        title="重命名"
                      >
                        <EditIcon />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmPath(p.path)
                        }}
                        className="rounded-lg p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
                        title="删除"
                      >
                        <TrashIcon />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-0.5 border-t border-white/[0.06] pt-0.5">
        {/* 无项目入口（Codex 同款 "work without a project"）：cwd 落到主目录，
            不进项目列表。当前就是无项目态时禁用显示「当前」。 */}
        <button
          type="button"
          onClick={() => void switchToNoProject()}
          className="mb-0.5 flex min-h-8 w-full items-center gap-2 rounded-xl px-2.5 py-1 text-left text-[11px] text-zinc-400 transition hover:bg-white/[0.055] hover:text-zinc-200"
        >
          <HomeIcon />
          <span className="min-w-0 flex-1">
            <span className="block truncate">不在项目中工作</span>
            <span className="block truncate text-[10px] text-zinc-600">会话落在主目录，不占用项目位</span>
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
      className={`project-switcher-root relative ${elevated ? 'is-elevated' : ''}`}
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {trigger}
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      <Collapse
        open={open}
        className={`absolute left-0 top-full mt-1.5 w-64 ${
          elevated ? 'z-[70]' : 'z-50'
        } ${open ? '' : 'pointer-events-none'}`}
      >
        <div
          className="glass-panel-soft project-switcher-panel rounded-2xl p-1.5"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {listContent}
        </div>
      </Collapse>
    </div>
  )
}
