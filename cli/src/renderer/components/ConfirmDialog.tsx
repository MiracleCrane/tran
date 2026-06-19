interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button (destructive actions: force-delete, revert, …). */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** A lightweight yes/no modal. Visual pattern mirrors PermissionModal
 *  (fixed overlay + centered glass card), but generic — driven by props so
 *  any component can request confirmation without touching session state. */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element | null {
  if (!open) return null

  return (
    // z-[60] sits above GitToolbar popups (z-50) and PermissionModal (z-50).
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${danger ? 'bg-red-400' : 'bg-amber-400'}`} />
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
        </div>
        <p className="mb-5 whitespace-pre-wrap break-words text-sm text-zinc-400">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-5 py-2 text-sm font-medium text-white hover:brightness-110 ${
              danger ? 'bg-red-500' : 'bg-accent'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
