import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { Project } from '../../shared/ipc'

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

export default function ProjectSwitcher({ collapsed }: { collapsed: boolean }): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const switchProject = useSessionStore((s) => s.switchProject)
  const starting = useSessionStore((s) => s.starting)
  const reset = useSessionStore((s) => s.reset)

  const [projects, setProjects] = useState<Project[]>([])
  const [open, setOpen] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [confirmPath, setConfirmPath] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setProjects(await window.api.listProjects())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, meta?.cwd])

  const current = projects.find((p) => p.path === meta?.cwd) ?? null
  const currentLabel =
    current?.name ?? (meta?.cwd ? meta.cwd.split(/[\\/]/).pop() : '项目')

  const addNew = async (): Promise<void> => {
    setOpen(false)
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const list = await window.api.addProject(dir)
    setProjects(list)
    await switchProject(dir)
  }

  const onSwitch = async (path: string): Promise<void> => {
    setOpen(false)
    if (path === meta?.cwd) return
    await switchProject(path)
  }

  const commitRename = async (path: string): Promise<void> => {
    const list = await window.api.renameProject(path, editText)
    setProjects(list)
    setEditingPath(null)
  }

  const doRemove = async (path: string): Promise<void> => {
    setConfirmPath(null)
    const list = await window.api.removeProject(path)
    setProjects(list)
    if (path === meta?.cwd) {
      if (list[0]) await switchProject(list[0].path)
      else reset() // removed the last project → back to Onboarding
    }
  }

  const trigger = collapsed ? (
    <button
      onClick={() => setOpen((o) => !o)}
      disabled={starting}
      title={current?.path ?? meta?.cwd ?? ''}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-bg-hover/60 hover:text-zinc-200 disabled:opacity-50"
    >
      <FolderIcon />
    </button>
  ) : (
    <button
      onClick={() => setOpen((o) => !o)}
      disabled={starting}
      title={current?.path ?? meta?.cwd ?? ''}
      className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-elev px-2.5 py-1.5 text-xs text-zinc-300 transition hover:bg-bg-hover disabled:opacity-50"
    >
      <FolderIcon />
      <span className="flex-1 truncate text-left">{currentLabel}</span>
      <ChevronIcon up={open} />
    </button>
  )

  return (
    <div className="relative">
      {trigger}
      {open && (
        <>
          {/* outside-click catcher */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={`absolute z-50 mt-1 overflow-hidden rounded-lg border border-border-subtle bg-bg-elev shadow-xl ${
              collapsed ? 'left-0 w-56' : 'left-0 right-0'
            }`}
          >
            <div className="max-h-72 overflow-y-auto py-1">
              {projects.length === 0 && (
                <div className="px-3 py-2 text-xs text-zinc-600">还没有项目</div>
              )}
              {projects.map((p) => {
                const isCurrent = p.path === meta?.cwd
                const editing = editingPath === p.path
                const confirming = confirmPath === p.path
                return (
                  <div key={p.path} className="group relative px-1">
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
                        className="m-1 w-[calc(100%-0.5rem)] rounded border border-accent bg-bg-base px-2 py-1 text-xs text-zinc-100 outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => void onSwitch(p.path)}
                        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition ${
                          isCurrent
                            ? 'text-zinc-100'
                            : 'text-zinc-400 hover:bg-bg-hover hover:text-zinc-200'
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
                              className="rounded bg-bg-base px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-bg-hover"
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
                              className="rounded p-1 text-zinc-500 transition hover:bg-bg-hover hover:text-zinc-200"
                              title="重命名"
                            >
                              <EditIcon />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmPath(p.path)
                              }}
                              className="rounded p-1 text-zinc-500 transition hover:bg-red-950/50 hover:text-red-300"
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
            <div className="border-t border-border-subtle p-1">
              <button
                onClick={() => void addNew()}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
              >
                <PlusIcon /> 添加项目…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
