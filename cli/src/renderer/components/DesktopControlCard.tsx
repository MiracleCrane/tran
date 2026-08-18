import { useEffect, useState } from 'react'
import type { DisplayInfo } from '../../shared/ipc'
import SettingText from './SettingText'

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
      <SettingText className="mt-1">
        允许 Agent 操作 Windows 桌面，包括截屏、读取窗口控件、鼠标点击、键盘输入和窗口切换。

        启用后，需要重新打开会话才能使用 `desktop_*` 工具。此设置同时应用于 **Kimi Code** 和 **Claude Code**，Tran 会分别更新对应的 MCP 配置。
      </SettingText>
      {on && displays.length > 1 && (
        <div className="mt-3">
          <div className="text-[11px] font-medium text-zinc-300">分屏控制</div>
          <SettingText className="mt-0.5">
            将桌面控制限制在指定显示器。截图仅包含该显示器，超出范围的点击和窗口聚焦请求会被拒绝。
          </SettingText>
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
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2">
          <SettingText className="text-amber-300">
            {'> **安全提示：** 桌面控制允许 Agent 操作屏幕上的其他应用。建议使用“逐条确认”权限模式，并在执行前核对每次工具调用。Agent 操作期间，屏幕边缘会显示紫色提示光晕。'}
          </SettingText>
        </div>
      )}
    </section>
  )
}
