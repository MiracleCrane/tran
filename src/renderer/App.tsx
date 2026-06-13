import { useEffect } from 'react'
import { useSessionStore } from './store/sessionStore'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import Transcript from './components/Transcript'
import Composer from './components/Composer'
import StatusBar from './components/StatusBar'
import PermissionModal from './components/PermissionModal'

export default function App(): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const ingest = useSessionStore((s) => s.ingestAgentEvent)
  const addPerm = useSessionStore((s) => s.addPermissionRequest)

  useEffect(() => {
    const off1 = window.api.onAgentEvent((e) => ingest(e))
    const off2 = window.api.onPermissionRequest((r) => addPerm(r))
    return () => {
      off1()
      off2()
    }
  }, [ingest, addPerm])

  if (!meta) return <Onboarding />

  return (
    <div className="flex h-screen bg-bg-base">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-hidden">
          <Transcript />
        </div>
        <Composer />
        <StatusBar />
      </div>
      <PermissionModal />
    </div>
  )
}
