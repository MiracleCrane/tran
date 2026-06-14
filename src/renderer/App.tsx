import { useEffect } from 'react'
import { useSessionStore } from './store/sessionStore'
import { useUiStore } from './store/uiStore'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import Transcript from './components/Transcript'
import Composer from './components/Composer'
import StatusBar from './components/StatusBar'
import PermissionModal from './components/PermissionModal'
import McpPanel from './components/McpPanel'
import ProvidersPanel from './components/ProvidersPanel'
import SkillsPanel from './components/SkillsPanel'
import SettingsPanel from './components/SettingsPanel'
import ErrorBoundary from './components/ErrorBoundary'

function WindowTitlebar(): JSX.Element {
  return (
    <div className="window-titlebar flex shrink-0 items-center text-[13px] text-zinc-200/80">
      <div className="window-titlebar-drag flex min-w-0 flex-1 items-center gap-2 px-4">
        <div className="flex h-5 w-5 items-center justify-center rounded-md border border-white/15 bg-accent/70 text-[10px] font-semibold text-white shadow-sm shadow-black/20">
          F
        </div>
        <span className="font-medium">Forge</span>
      </div>
      <div className="window-controls flex h-full shrink-0 items-stretch">
        <button
          type="button"
          className="window-control"
          aria-label="最小化"
          onClick={() => void window.api.minimizeWindow()}
        >
          <span className="mb-1 block h-px w-3 rounded bg-current" />
        </button>
        <button
          type="button"
          className="window-control"
          aria-label="最大化"
          onClick={() => void window.api.toggleMaximizeWindow()}
        >
          <span className="block h-3 w-3 rounded-[2px] border border-current" />
        </button>
        <button
          type="button"
          className="window-control close"
          aria-label="关闭"
          onClick={() => void window.api.closeWindow()}
        >
          <span className="relative block h-4 w-4 before:absolute before:left-1/2 before:top-1/2 before:h-px before:w-4 before:-translate-x-1/2 before:-translate-y-1/2 before:rotate-45 before:bg-current after:absolute after:left-1/2 after:top-1/2 after:h-px after:w-4 after:-translate-x-1/2 after:-translate-y-1/2 after:-rotate-45 after:bg-current" />
        </button>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const bootstrapped = useSessionStore((s) => s.bootstrapped)
  const bootstrap = useSessionStore((s) => s.bootstrap)
  const ingest = useSessionStore((s) => s.ingestAgentEvent)
  const addPerm = useSessionStore((s) => s.addPermissionRequest)
  const view = useUiStore((s) => s.view)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const off1 = window.api.onAgentEvent((e) => ingest(e))
    const off2 = window.api.onPermissionRequest((r) => addPerm(r))
    return () => {
      off1()
      off2()
    }
  }, [ingest, addPerm])

  if (!bootstrapped) {
    return (
      <div className="app-shell flex h-screen flex-col overflow-hidden">
        <WindowTitlebar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="accent-soft-button flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white">
            F
          </div>
        </div>
      </div>
    )
  }

  if (!meta) {
    return (
      <ErrorBoundary>
        <div className="app-shell flex h-screen flex-col overflow-hidden text-zinc-200">
          <WindowTitlebar />
          <div className="min-h-0 flex-1">
            <Onboarding />
          </div>
        </div>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app-shell flex h-screen flex-col overflow-hidden text-zinc-200">
        <WindowTitlebar />
        <div className="workspace-shell flex min-h-0 flex-1 gap-4 p-4 pt-4">
          <Sidebar />
          <div className="main-surface flex min-w-0 flex-1 flex-col overflow-hidden">
            {view === 'mcp' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <McpPanel />
              </div>
            ) : view === 'providers' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <ProvidersPanel />
              </div>
            ) : view === 'skills' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <SkillsPanel />
              </div>
            ) : view === 'settings' ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <SettingsPanel />
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Transcript />
                </div>
                <Composer />
                <StatusBar />
              </>
            )}
          </div>
          <PermissionModal />
        </div>
      </div>
    </ErrorBoundary>
  )
}
