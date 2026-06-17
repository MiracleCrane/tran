import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

export default function PermissionModal(): JSX.Element | null {
  const req = useSessionStore((s) => s.pendingPermissions[0])
  const respond = useSessionStore((s) => s.respondPermission)
  const [denyReason, setDenyReason] = useState('')

  if (!req) return null

  const isBash = req.toolName === 'Bash'
  const command = isBash ? (req.input as { command?: string })?.command : ''
  const inputJson = JSON.stringify(req.input, null, 2)

  const allow = (): void => {
    void respond(req.toolUseID, 'allow')
  }
  const deny = (): void => {
    void respond(req.toolUseID, 'deny', denyReason.trim() || undefined)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-md">
      <div className="glass-panel liquid-float-in w-full max-w-lg rounded-[22px] p-6 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <h2 className="text-base font-semibold text-zinc-100">权限请求</h2>
        </div>
        <p className="mb-4 text-sm text-zinc-400">
          Forge 想要使用 <span className="font-mono text-zinc-200">{req.toolName}</span>
          {req.agentID ? <span className="text-zinc-500">(在子代理中)</span> : null}。
        </p>

        {req.decisionReason && (
          <p className="mb-3 text-xs text-zinc-500">{req.decisionReason}</p>
        )}

        {isBash && command ? (
          <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-[#0b0c10]/80 p-3 text-xs text-zinc-300">
            <span className="text-zinc-600">$ </span>
            {command}
          </pre>
        ) : (
          <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-[#0b0c10]/80 p-3 text-xs text-zinc-400">
            {inputJson}
          </pre>
        )}

        <input
          value={denyReason}
          onChange={(e) => setDenyReason(e.target.value)}
          placeholder="拒绝原因(可选)"
          className="glass-control mb-4 w-full rounded-lg px-3 py-2 text-xs text-zinc-300 outline-none focus:border-accent"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={deny}
            className="glass-control rounded-lg px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            拒绝
          </button>
          <button
            onClick={allow}
            className="accent-soft-button rounded-lg px-5 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  )
}
