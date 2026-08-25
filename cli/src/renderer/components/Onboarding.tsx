import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { Project, SessionListItem } from '../../shared/ipc'
import { relTime } from '../utils/format'

/** 首页「最近会话」条数上限：只放一屏的量，全量在侧栏「全部」视图。 */
const RECENT_SESSIONS_LIMIT = 10

/** 与侧栏 ProjectSwitcher 同款的文件夹图标（保持两处视觉一致）。 */
const FolderIcon = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)

/** 路径末段作为项目名（Sidebar.pathName 的同款小工具，分量太轻不提公共）。 */
function pathBase(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? clean
}

/**
 * 首页（!meta 时由 App.tsx 渲染）。
 *
 * 2026-08-25 用户决策：启动不再自动进入上次项目，统一落在这里。有已存项目时
 * 是「项目 + 最近会话」的入口页；一个项目都没有时保持最初的首跑形态
 * （介绍 + 浏览选目录），不硬塞空列表。
 */
export default function Onboarding(): JSX.Element {
  const startSession = useSessionStore((s) => s.startSession)
  const switchProject = useSessionStore((s) => s.switchProject)
  const openStartupProject = useSessionStore((s) => s.openStartupProject)
  const openSessionCrossProject = useSessionStore((s) => s.openSessionCrossProject)

  // null = 还在拉取：先按首跑形态渲染，避免列表闪现又消失。
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [recent, setRecent] = useState<SessionListItem[]>([])
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    let alive = true
    // 两块数据并行：项目列表 + 跨项目最近会话。listSessions 的 scope:'all'
    // 由主进程忽略 cwd（侧栏「全部」视图同款调用），首页没有 meta，传空串占位。
    void Promise.all([
      window.api.listProjects().catch(() => [] as Project[]),
      window.api
        .listSessions('', { scope: 'all', limit: RECENT_SESSIONS_LIMIT, offset: 0 })
        .catch(() => [] as SessionListItem[])
    ]).then(([projs, sessions]) => {
      if (!alive) return
      setProjects(projs)
      setRecent(sessions.slice(0, RECENT_SESSIONS_LIMIT))
    })
    return () => {
      alive = false
    }
  }, [])

  const pick = async (): Promise<string | null> => {
    // 局部小指示（不整屏转圈）：按钮文案提示，页面其余部分保持可操作。
    setPicking(true)
    try {
      return await window.api.pickDirectory()
    } finally {
      setPicking(false)
    }
  }

  /** 选定目录后进入：存为项目（幂等）并起会话，meta 置位后 App 切走首页。 */
  const enterDirectory = async (dir: string): Promise<void> => {
    setError(null)
    setSubmitting(true)
    try {
      await window.api.addProject(dir)
      await startSession({ cwd: dir })
      // startSession() sets meta → App switches to the main view and unmounts us.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  const pickAndEnter = async (): Promise<void> => {
    const dir = await pick()
    if (dir) await enterDirectory(dir)
  }

  const start = async (): Promise<void> => {
    const cleanCwd = cwd.trim()
    if (!cleanCwd) {
      setError('请先选择一个工作目录。')
      return
    }
    await enterDirectory(cleanCwd)
  }

  /** 最近会话：首页没有 meta，先懒创建地落进目标项目（不起后端空壳），
   *  再走侧栏「全部」视图同款的跨项目 resume（openSessionCrossProject 的
   *  前置条件就是 meta 已存在）。 */
  const openRecent = async (s: SessionListItem): Promise<void> => {
    if (!s.cwd) return
    setError(null)
    try {
      await openStartupProject(s.cwd)
      await openSessionCrossProject(s.sessionId, s.cwd, s.runtimeBackend, s.agentBackend)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const intro = (
    <>
      <div className="mb-1 text-2xl font-semibold text-zinc-100">Tran</div>
      <div className="mb-6 text-sm text-zinc-400">
        本地 CLI Agent 的桌面客户端（当前内置 Kimi 后端）。选择一个项目文件夹即可开始。
      </div>
    </>
  )

  const errorBox = error && (
    <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
      {error}
    </div>
  )

  // 首跑形态：没有已存项目时保持原来的介绍 + 浏览选目录。
  if (!projects || projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-transparent px-6">
        <div className="w-full max-w-lg rounded-2xl border border-border-subtle bg-bg-panel p-8 shadow-2xl">
          {intro}

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
              onClick={() => {
                void pick().then((dir) => {
                  if (dir) setCwd(dir)
                })
              }}
              disabled={picking}
              className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 hover:bg-bg-hover disabled:opacity-60"
            >
              {picking ? '正在打开…' : '浏览…'}
            </button>
          </div>

          {errorBox}

          <button
            onClick={() => void start()}
            disabled={submitting}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '正在启动…' : '开始会话'}
          </button>
        </div>
      </div>
    )
  }

  // 首页形态：居中定宽列，行的悬停态与侧栏行一致（hover:bg-white/[0.055]）。
  return (
    <div className="flex h-full justify-center overflow-y-auto bg-transparent px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6 self-start">
        <div>
          <div className="mb-1 text-2xl font-semibold text-zinc-100">Tran</div>
          <div className="text-sm text-zinc-400">选一个项目继续，或从最近的会话直接回到现场。</div>
        </div>

        {errorBox}

        <section>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
            项目
          </div>
          <div className="glass-panel-soft rounded-2xl p-1.5">
            {projects.map((p) => (
              <button
                key={p.path}
                onClick={() => void switchProject(p.path)}
                title={p.path}
                className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm text-zinc-300 transition hover:bg-white/[0.055] hover:text-zinc-100"
              >
                <span className="shrink-0 text-zinc-500">
                  <FolderIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate text-[11px] text-zinc-600">{p.path}</span>
                </span>
              </button>
            ))}
            <button
              onClick={() => void pickAndEnter()}
              disabled={picking || submitting}
              className="mt-0.5 flex min-h-9 w-full items-center gap-2.5 rounded-xl border-t border-white/[0.06] px-3 py-1.5 pt-2 text-left text-sm text-zinc-500 transition hover:bg-white/[0.055] hover:text-zinc-200 disabled:opacity-60"
            >
              {picking ? '正在打开…' : submitting ? '正在启动…' : '浏览新文件夹…'}
            </button>
          </div>
        </section>

        {recent.length > 0 && (
          <section>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
              最近会话
            </div>
            <div className="glass-panel-soft rounded-2xl p-1.5">
              {recent.map((s) => (
                <button
                  key={s.sessionId}
                  onClick={() => void openRecent(s)}
                  title={s.cwd ?? ''}
                  className="flex min-h-9 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm text-zinc-300 transition hover:bg-white/[0.055] hover:text-zinc-100"
                >
                  <span className="min-w-0 flex-1 truncate">{s.summary}</span>
                  <span className="shrink-0 text-[11px] text-zinc-600">
                    {s.cwd ? `${pathBase(s.cwd)} · ` : ''}
                    {relTime(s.lastModified)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
