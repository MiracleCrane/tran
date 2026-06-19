import { useEffect, useState } from 'react'
import { emitForgeEvent } from '../events'

interface ClosePromptDialogProps {
  open: boolean
  onClose: () => void
}

/** First-close prompt shown when the user closes Forge for the first time.
 *  Lets them pick: minimize to tray (keep running) or quit outright, with a
 *  "don't ask again" checkbox that persists the choice. Visual pattern mirrors
 *  ConfirmDialog (fixed overlay + centered glass card). */
export default function ClosePromptDialog({ open, onClose }: ClosePromptDialogProps): JSX.Element | null {
  const [remember, setRemember] = useState(true)

  // Reset the checkbox whenever the dialog re-opens.
  useEffect(() => {
    if (open) setRemember(true)
  }, [open])

  // Esc dismisses (treated as cancel: do nothing, window stays open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const choose = async (minimize: boolean): Promise<void> => {
    await window.api.resolveClose({ minimize, remember })
    // Notify any open SettingsPanel that the persisted close-pref changed (e.g.
    // "不再提醒" was checked) so its "每次关闭都询问" toggle re-syncs.
    emitForgeEvent('closePrefsChanged')
    onClose()
  }

  return (
    // z-[60] sits above GitToolbar popups (z-50) and PermissionModal (z-50).
    // Backdrop darkened so the opaque card below reads clearly.
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      {/* Opaque card mirroring the main-surface (chat panel) styling so the
          dialog reads as part of the app rather than a bright-edged overlay. */}
      <div
        className="w-full max-w-md p-6"
        style={{
          borderRadius: '18px',
          border: '1px solid rgba(238, 232, 226, 0.12)',
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.024), rgba(255,255,255,0.006)), rgba(8, 9, 13, 0.992)',
          boxShadow:
            'inset 0 1px 0 rgba(255, 250, 245, 0.15), 0 20px 70px rgba(0, 0, 0, 0.26)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="text-base font-semibold text-zinc-100">关闭 Forge</h2>
        </div>
        <p className="mb-5 text-sm leading-relaxed text-zinc-400">
          关闭窗口时是否最小化到系统托盘继续运行?最小化后 Agent 仍在后台执行,点击托盘图标可恢复窗口。
        </p>

        <label className="mb-5 flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-3.5 w-3.5 accent-[#df765f]"
          />
          不再提醒(之后可在「设置」中修改)
        </label>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            onClick={() => void choose(false)}
            className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-red-950/40 hover:text-red-300"
          >
            直接退出
          </button>
          <button
            onClick={() => void choose(true)}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            最小化到托盘
          </button>
        </div>
      </div>
    </div>
  )
}
