import { useEffect, useState } from 'react'
import type { DisplayInfo } from '../../shared/ipc'

/**
 * 「桌面控制」开关卡片（Codex 式 computer-use，默认关）。
 * 开 = 把 tran-desktop MCP server 注册进 kimi 的 mcp.json（截屏/点击/键入/
 * 窗口管理/UIA 读取七个 desktop_* 工具）；关 = 反注册。kimi 重开会话生效。
 * 能力等同于让 AI 坐在键盘前，卡片必须把这一点讲清楚。
 */
export default function DesktopControlCard(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [toggling, setToggling] = useState(false)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  /** null = 不限制（整个桌面）；数字 = 只允许操作这块屏。 */
  const [aiDisplay, setAiDisplay] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getControlPlugins().then((p) => {
      if (!alive) return
      setEnabled(p.desktopEnabled)
      // 回读已选的那块屏：不读的话每次打开设置都显示「不限制」，而后台其实
      // 还锁着上次的选择。
      setAiDisplay(p.desktopDisplayIndex)
    }).catch(() => {})
    void window.api.listDisplays().then((list) => {
      if (alive) setDisplays(list)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const pickDisplay = async (index: number | null): Promise<void> => {
    setAiDisplay(index)
    try {
      await window.api.setDesktopDisplay(index)
    } catch {
      /* 保持本地选择，下次打开重新读 */
    }
  }

  const toggle = async (): Promise<void> => {
    if (enabled === null || toggling) return
    setToggling(true)
    try {
      const next = await window.api.setControlPlugin('desktop', !enabled)
      setEnabled(next.desktopEnabled)
    } catch {
      /* 保持原状 */
    } finally {
      setToggling(false)
    }
  }

  const on = enabled === true
  return (
    <section className="glass-panel-soft rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">桌面控制</span>
        {enabled !== null && (
          <span className={`text-[11px] ${on ? 'text-emerald-400' : 'text-zinc-600'}`}>
            {on ? '已开启' : '已关闭'}
          </span>
        )}
        <span className="rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-400">实验性</span>
        <div className="ml-auto">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="切换桌面控制"
            disabled={enabled === null || toggling}
            onClick={() => void toggle()}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              on ? 'bg-accent' : 'bg-zinc-700'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                on ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
        让 AI 像 Codex 那样操作整个 Windows 桌面：截屏识别、读取窗口控件（UIA）、移动点击鼠标、
        键盘输入、切换窗口。开关即时生效，kimi 重开会话后可用 desktop_* 工具。
      </p>
      <p className="mt-1 text-[11px] text-zinc-600">
        对 <span className="text-zinc-500">Kimi Code</span> 与{' '}
        <span className="text-zinc-500">Claude Code</span> 两个后端同时生效（各写各的 MCP 配置）。
      </p>
      {on && displays.length > 1 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-zinc-300">分屏控制</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
            把其中一块屏划给 AI：截图只截这块屏，点击/聚焦越界会被拒绝，你在另一块屏上继续干活互不干扰。
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void pickDisplay(null)}
              className={`rounded-lg px-3 py-1.5 text-[11px] transition ${
                aiDisplay === null
                  ? 'bg-accent/20 text-accent'
                  : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
              }`}
            >
              不限制（整个桌面）
            </button>
            {displays.map((d) => (
              <button
                key={d.index}
                type="button"
                onClick={() => void pickDisplay(d.index)}
                className={`rounded-lg px-3 py-1.5 text-[11px] transition ${
                  aiDisplay === d.index
                    ? 'bg-accent/20 text-accent'
                    : 'text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300'
                }`}
              >
                {d.label} · {d.width}×{d.height}
                {d.scalePercent !== 100 ? ` · ${d.scalePercent}%` : ''}
                {d.primary ? ' · 主屏' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {on && (
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
          ⚠️ 桌面控制等同于把键盘鼠标交给 AI——它能操作屏幕上的任何程序。工具调用仍会走
          kimi 的权限确认（逐条确认模式下每步都会问你）；不放心时把会话保持在「逐条确认」模式。
          AI 操作期间屏幕边缘会亮起紫色光晕作提示。
        </div>
      )}
    </section>
  )
}
