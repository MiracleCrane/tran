import { useMemo, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import { openChangesPanel } from '../events'

/**
 * 输入框正上方的「N 个文件已更改 +X -Y」悬浮胶囊（Codex 同款）。
 *
 * 口径（2026-08-19 改定）：本会话所有轮次改动卡的**并集汇总**——每张卡记录
 * 那一轮实际动过的文件与增删行数，胶囊就是它们的总和。这样「会话 ≥ 任一轮」
 * 在构造上恒成立。
 *
 * 旧口径是「卡片路径 ∩ 当前 git 工作区 diff」：commit 之后文件从工作区 diff
 * 里消失、.scratch 这类 gitignore 的文件 git 根本不列——卡片口径（工具输入）
 * 却在涨，于是出现"本轮 +123 而会话只有 +8"的倒挂（2026-08-19 用户抓包）。
 * 代价：文件后来被还原/提交后仍在计数（这是"本会话动过什么"的历史视角；
 * 当前未提交实况看 Git 工具条的「改动」）。
 */

const FILES_SHOWN = 8

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

export default function SessionChangesPill(): JSX.Element | null {
  // 轮次卡并集：同一文件多轮编辑时累加（与卡片口径一致，都是"动了多少"）。
  const sessionFiles = useSessionStore((s) => {
    const map = new Map<string, { added: number; removed: number }>()
    for (const it of s.items) {
      if (it.kind !== 'turnChanges') continue
      for (const f of it.files) {
        const cur = map.get(f.path) ?? { added: 0, removed: 0 }
        cur.added += f.added
        cur.removed += f.removed
        map.set(f.path, cur)
      }
    }
    // 自定义选择器每次返回新数组会打穿 memo——拼成稳定字符串（/ 做
    // 分隔符，文件路径不可能含控制字符。教训：曾直接写裸控制字符，落盘被静默
    // 吃掉变成 split('')，路径被拆成单字符——「本会话 25 个文件」的 25 其实是
    // 路径的字符数。分隔符必须写成转义序列，别写裸控制字符）。
    return [...map.entries()].map(([p, v]) => `${p}${v.added}:${v.removed}`).join('')
  })
  const files = useMemo(
    () =>
      (sessionFiles ? sessionFiles.split('') : []).map((entry) => {
        const [path, nums] = entry.split('')
        const [added, removed] = (nums ?? '0:0').split(':').map(Number)
        return { path: path ?? '', added: added ?? 0, removed: removed ?? 0 }
      }),
    [sessionFiles]
  )
  const [open, setOpen] = useState(false)

  // 这个对话一行没改 → 整枚隐藏。
  if (files.length === 0) return null

  const addedTotal = files.reduce((n, f) => n + f.added, 0)
  const removedTotal = files.reduce((n, f) => n + f.removed, 0)
  const shown = files.slice(0, FILES_SHOWN)
  const rest = files.length - shown.length
  const review = (path?: string): void => {
    setOpen(false)
    openChangesPanel(path)
  }

  return (
    <div className="pointer-events-none relative z-20 flex justify-center">
      <div
        className="pointer-events-auto relative"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {open && (
          <div className="absolute bottom-full left-1/2 mb-2 w-[min(420px,70vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border-subtle bg-bg-elev shadow-xl shadow-black/40">
            {shown.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => review(f.path)}
                title={f.path}
                className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition hover:bg-white/[0.05]"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">{fileName(f.path)}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-emerald-400">+{f.added}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-red-400">-{f.removed}</span>
              </button>
            ))}
            {rest > 0 && (
              <div className="border-t border-white/[0.05] px-3 py-1.5 text-[11px] text-zinc-500">
                还有 {rest} 个文件…
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => review()}
          title="查看本次会话的工作区改动"
          className="mb-1.5 flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elev px-3.5 py-1.5 text-[12px] text-zinc-300 shadow-lg shadow-black/30 transition hover:bg-bg-hover"
        >
          <span>本会话 {files.length} 个文件已更改</span>
          <span className="tabular-nums text-emerald-400">+{addedTotal}</span>
          <span className="tabular-nums text-red-400">-{removedTotal}</span>
        </button>
      </div>
    </div>
  )
}
