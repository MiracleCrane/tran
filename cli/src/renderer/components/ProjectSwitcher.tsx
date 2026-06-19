import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { ClaudeExecutionBackend, Project } from '../../shared/ipc'
import Collapse from './Collapse'
import { isWslProjectPath } from '../../shared/paths'
import { emitForgeEvent, onForgeEvent } from '../events'

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
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}
      stroke="currentColor"
      strokeWidth="1.8"
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

export default function ProjectSwitcher({ collapsed }: { collapsed: boolean }): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const switchProject = useSessionStore((s) => s.switchProject)
  const reset = useSessionStore((s) => s.reset)
  const showBlockingOverlay = useUiStore((s) => s.showBlockingOverlay)
  const hideBlockingOverlay = useUiStore((s) => s.hideBlockingOverlay)

  const [projects, setProjects] = useState<Project[]>([])
  const [open, setOpen] = useState(false)
  const [elevated, setElevated] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmPath, setConfirmPath] = useState<string | null>(null)
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)
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

  const current = projects.find((p) => p.path === meta?.cwd) ?? null
  const currentLabel =
    current?.name ?? (meta?.cwd ? meta.cwd.split(/[\\/]/).pop() : '项目')

  const inferBackendFromPath = (
    path: string,
    fallback: ClaudeExecutionBackend
  ): ClaudeExecutionBackend =>
    isWslProjectPath(path, { includePosixAbsolute: true }) ? 'wsl' : fallback

  const addNew = async (backend: ClaudeExecutionBackend): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    setOpen(false)
    const overlayId = showBlockingOverlay('正在等待资源管理器响应...')
    let dir: string | null = null
    try {
      dir = await window.api.pickDirectory({ backend })
    } finally {
      hideBlockingOverlay(overlayId)
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
    const normalizedDir = normalizePickedProjectPath(dir, targetBackend)
    const savedPath = list.find((p) => p.path === normalizedDir)?.path ?? normalizedDir
    void switchProject(savedPath)
  }

  const onSwitch = (path: string): void => {
    ++projectActionSeqRef.current
    setOpen(false)
    if (path === meta?.cwd) return
    void switchProject(path)
  }

  const commitRename = async (path: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    const list = await window.api.renameProject(path, editText)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    setEditingPath(null)
  }

  const doRemove = async (path: string): Promise<void> => {
    const actionSeq = ++projectActionSeqRef.current
    setConfirmPath(null)
    const list = await window.api.removeProject(path)
    if (projectActionSeqRef.current !== actionSeq) return
    setProjects(list)
    if (path === meta?.cwd) {
      if (list[0]) void switchProject(list[0].path)
      else reset() // removed the last project → back to Onboarding
    }
  }

  const trigger = collapsed ? (
    <button
      onClick={() => setOpen((o) => !o)}
      title={current?.path ?? meta?.cwd ?? ''}
      className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200"
    >
      <FolderIcon />
    </button>
  ) : (
    <button
      onClick={() => setOpen((o) => !o)}
      title={current?.path ?? meta?.cwd ?? ''}
      className="flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100"
    >
      <FolderIcon />
      <span className="flex-1 truncate text-left">{currentLabel}</span>
      <ChevronIcon up={open} />
    </button>
  )

  const addProjectBackends: ClaudeExecutionBackend[] = wslSupportEnabled
    ? ['windows', 'wsl']
    : ['windows']

  // Shared project list + "add" row. `open` drives the stagger transition; in
  // the expanded sidebar it lives inside <Collapse> (so it animates), in the
  // collapsed icon rail it's shown directly in a floating frame (the rail is
  // too narrow for in-place expand).
  const listContent = (
    <>
      <div className="max-h-60 overflow-y-auto">
        {projects.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-600">还没有项目</div>
        )}
        {projects.map((p, i) => {
          const isCurrent = p.path === meta?.cwd
          const editing = editingPath === p.path
          const confirming = confirmPath === p.path
          return (
            <div
              key={p.path}
              className="group relative transition-all duration-[360ms] ease-spring"
              style={{
                transitionDelay: open ? `${i * 40}ms` : '0ms',
                opacity: open ? 1 : 0,
                transform: open ? 'translateY(0)' : 'translateY(-6px)'
              }}
            >
              {editing ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
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
        <div
          style={{
            transitionDelay: open ? `${projects.length * 40}ms` : '0ms',
            opacity: open ? 1 : 0,
            transform: open ? 'translateY(0)' : 'translateY(-6px)'
          }}
          className={`grid ${
            wslSupportEnabled ? 'grid-cols-2' : 'grid-cols-1'
          } gap-1.5 transition-all duration-[360ms] ease-spring`}
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

  // Collapsed icon rail: too narrow (w-14) for the frame to grow in place,
  // so the list floats beside the icon instead.
  if (collapsed) {
    return (
      <div className={`project-switcher-root relative ${elevated ? 'is-elevated' : ''}`}>
        {trigger}
        {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
        <Collapse
          open={open}
          className={`absolute left-0 top-full mt-1 w-56 ${
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

  // Expanded sidebar: the frame ITSELF enlarges — trigger + list share one
  // glass-panel-soft frame, which is absolutely positioned so growing it
  // overlaps the session list instead of shoving it. A placeholder reserves
  // the trigger's footprint in the flow.
  return (
    <div className={`project-switcher-root relative ${elevated ? 'is-elevated' : ''}`}>
      <div
        className={`glass-panel-soft project-switcher-panel absolute inset-x-0 top-0 rounded-2xl p-1.5 ${
          elevated ? 'z-[70]' : 'z-50'
        }`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {trigger}
        <Collapse open={open}>
          <div className="pt-0.5">{listContent}</div>
        </Collapse>
      </div>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      <div className="invisible" aria-hidden>
        <div className="glass-panel-soft rounded-2xl p-1.5">
          <div className="flex h-8 items-center gap-2 px-2.5 text-[11px]">
            <span className="w-[15px]" />
            <span className="flex-1 truncate">{currentLabel}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
