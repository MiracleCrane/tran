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
      <div className="flex h-screen items-center justify-center bg-bg-base">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-lg font-bold text-white">
          F
        </div>
      </div>
    )
  }

  if (!meta) return <Onboarding />

  return (
    <div className="flex h-screen bg-bg-base">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
  )
}
