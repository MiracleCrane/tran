import { useCallback, useEffect, useState } from 'react'
import { useUiStore } from '../store/uiStore'
import { useArchiveStore } from '../store/archiveStore'
import { useSessionStore } from '../store/sessionStore'
import { relTime } from '../utils/format'
import HoverTip from './HoverTip'
import type { SessionListItem } from '../../shared/ipc'

/**
 * 归档页（2026-08 用户功能）：找回被归档的会话。
 * - 点标题直接打开会话（打开前先取消归档，让它回到侧栏列表）；
 * - 多选 → 批量恢复 / 批量删除（真删，走 forge:deleteSession，不可恢复）。
 * 侧栏列表只能归档/删除单条，批量与恢复都只在这里发生。
 */
export default function ArchivePanel(): JSX.Element {
  const archivedIds = useArchiveStore((s) => s.archivedIds)
  const loadArchived = useArchiveStore((s) => s.loadArchived)
  const unarchive = useArchiveStore((s) => s.unarchive)
  const storeError = useArchiveStore((s) => s.lastError)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // 会话列表是否成功加载过一次。未加载成功时绝不把归档项判成「已不存在」——
  // 否则 listSessions 失败（sessions 保持 []）会让所有归档会话都被误判，
  // 用户点「清除标记」实为 unarchive，真实会话被无声恢复。
  const [listLoaded, setListLoaded] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    await loadArchived()
    try {
      // 归档页看全部项目（scope:all），上限放大避免漏网。
      const list = await window.api.listSessions('', { scope: 'all', limit: 500 })
      setSessions(list)
      setListLoaded(true)
    } catch {
      // 列表拉不到：保持 listLoaded=false，只按 id 列出归档项，不判「不存在」。
      setListLoaded(false)
    }
  }, [loadArchived])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const archived = sessions.filter((s) => archivedIds && s.sessionId in archivedIds)
  // 只有列表成功加载后，才把「归档标记在、但列表里查无此会话」判为已删除。
  const missingIds = listLoaded
    ? Object.keys(archivedIds ?? {}).filter((id) => !sessions.some((s) => s.sessionId === id))
    : []

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openSession = async (s: SessionListItem): Promise<void> => {
    await unarchive(s.sessionId)
    useUiStore.getState().setView('chat')
    // 打开走 sessionStore 的跨项目打开（与侧栏点击同一条路径）。
    void useSessionStore.getState().openSessionCrossProject(s.sessionId, s.cwd ?? '', s.runtimeBackend)
  }

  const restoreSelected = async (): Promise<void> => {
    setBusy(true)
    for (const id of selected) await unarchive(id)
    setSelected(new Set())
    setBusy(false)
    void refresh()
  }

  const deleteSelected = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    const failed: string[] = []
    for (const id of selected) {
      const s = sessions.find((item) => item.sessionId === id)
      // 删除成功才取消归档。deleteSession 以 {ok:false} 返回失败而不是抛异常，
      // 此前只 .catch 兜异常、无视 ok，删除失败仍 unarchive → 用户确认「永久
      // 删除」的会话反而回到侧栏。现在失败就保留归档标记并汇报。
      const result = await window.api
        .deleteSession(id, s?.cwd ?? '', s?.runtimeBackend)
        .catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      if (result && result.ok) {
        await unarchive(id)
      } else {
        failed.push(s?.summary || id)
      }
    }
    setSelected(new Set())
    setConfirming(false)
    setBusy(false)
    if (failed.length > 0) {
      setActionError(`${failed.length} 个会话删除失败，已保留在归档中：${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}`)
    }
    void refresh()
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-6">
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={() => useUiStore.getState().setView('chat')}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">归档</h1>
          <span className="text-[11px] text-zinc-600">
            {archived.length + missingIds.length} 个已归档会话
          </span>
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-500">
          归档只是从侧栏列表藏起来，数据原地不动。在这里可以恢复（回到列表）或多选后彻底删除。
        </p>

        {(actionError || storeError) && (
          <div className="rounded-xl border border-red-500/30 bg-red-950/30 px-3 py-2 text-[11px] text-red-300">
            {actionError || storeError}
          </div>
        )}

        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[11px] text-zinc-400">
            <span className="tabular-nums">已选 {selected.size} 项</span>
            <button
              onClick={() => void restoreSelected()}
              disabled={busy}
              className="rounded-lg px-2 py-1 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
            >
              恢复
            </button>
            {!confirming ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-red-400 transition hover:bg-red-950/40 disabled:opacity-50"
              >
                删除所选
              </button>
            ) : (
              <>
                <span className="text-red-300/80">永久删除，不可恢复：</span>
                <button
                  onClick={() => void deleteSelected()}
                  disabled={busy}
                  className="rounded-lg bg-red-950/60 px-2 py-1 text-red-300 transition hover:bg-red-900/60 disabled:opacity-50"
                >
                  {busy ? '删除中…' : '确认删除'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-lg px-2 py-1 transition hover:bg-white/[0.06]"
                >
                  取消
                </button>
              </>
            )}
            <button
              onClick={() => setSelected(new Set())}
              className="ml-auto rounded-lg px-2 py-1 transition hover:bg-white/[0.06]"
            >
              清空选择
            </button>
          </div>
        )}

        {archived.length === 0 && missingIds.length === 0 && (
          <div className="py-16 text-center text-xs text-zinc-600">
            没有归档的会话。侧栏会话行的 📥 按钮可以把会话收进来。
          </div>
        )}

        <div className="space-y-1">
          {archived.map((s) => (
            <div
              key={s.sessionId}
              className="group flex items-center gap-2 rounded-xl px-2.5 py-2 transition hover:bg-white/[0.04]"
            >
              <button
                type="button"
                onClick={() => toggle(s.sessionId)}
                aria-label={selected.has(s.sessionId) ? '取消选择' : '选择'}
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${
                  selected.has(s.sessionId)
                    ? 'border-accent bg-accent/70 text-white'
                    : 'border-white/25 text-transparent'
                }`}
              >
                ✓
              </button>
              <HoverTip tip="恢复并打开" className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => void openSession(s)}
                  className="w-full min-w-0 text-left"
                >
                  <span className="block truncate text-xs text-zinc-200">
                    {s.summary || '(未命名)'}
                  </span>
                  <span className="block truncate text-[10px] text-zinc-600">
                    {s.cwd ?? ''} · {relTime(s.lastModified)}
                  </span>
                </button>
              </HoverTip>
              <button
                type="button"
                onClick={() => void unarchive(s.sessionId).then(() => void refresh())}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-zinc-500 opacity-0 transition hover:bg-white/[0.06] hover:text-zinc-200 group-hover:opacity-100"
              >
                恢复
              </button>
            </div>
          ))}
          {/* 列表里已不存在（可能已被 kimi 侧删掉）但归档标记还在的，给清理入口。 */}
          {missingIds.map((id) => (
            <div key={id} className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-zinc-600">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{id}（会话已不存在）</span>
              <button
                type="button"
                onClick={() => void unarchive(id).then(() => void refresh())}
                className="shrink-0 rounded-lg px-2 py-1 text-[11px] transition hover:bg-white/[0.06] hover:text-zinc-300"
              >
                清除标记
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
