import { useState } from 'react'
import SettingText from './SettingText'

/**
 * 「xtw 终端」启动卡片：弹出一个独立 cmd 窗口刷 X(Twitter)。
 * 窗口是用户自己的交互式终端（cmd /k），生命周期不挂在 Tran 上。
 * 数据走 twikit + 一次性导出的 cookie，需要本地代理（默认 127.0.0.1:7897）。
 */
export default function XtwCard(): JSX.Element {
  const [error, setError] = useState<string | null>(null)

  const launch = async (): Promise<void> => {
    setError(null)
    try {
      const result = await window.api.launchXtw()
      if (!result.ok) setError(result.error ?? '启动失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="glass-panel-soft rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">xtw 终端</span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => void launch()}
            className="rounded-lg border border-border-subtle bg-bg-elev px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-bg-hover"
          >
            打开终端
          </button>
        </div>
      </div>
      <SettingText className="mt-1">
        {'在终端里纯文本刷 X（时间线/推文/回复），界面看起来像普通命令行输出。\n首次使用先在调试浏览器登录 X 并运行 `xtw login` 导出 cookie，之后不再需要浏览器。需要本地代理（默认 127.0.0.1:7897，可用 `xtw proxy <url>` 修改）。'}
      </SettingText>
      {error && (
        <SettingText className="mt-2 text-amber-300">{`启动失败：${error}`}</SettingText>
      )}
    </section>
  )
}
