import { useState } from 'react'
import SettingText from './SettingText'

/**
 * 「xhh 终端」启动卡片：弹出一个独立 cmd 窗口刷小黑盒热榜/帖子。
 * 窗口是用户自己的交互式终端（cmd /k），生命周期不挂在 Tran 上。
 */
export default function XhhCard(): JSX.Element {
  const [error, setError] = useState<string | null>(null)

  const launch = async (): Promise<void> => {
    setError(null)
    try {
      const result = await window.api.launchXhh()
      if (!result.ok) setError(result.error ?? '启动失败')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="glass-panel-soft rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">xhh 终端</span>
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
        {'在终端里纯文本刷小黑盒（热榜/帖子/评论），界面看起来像普通命令行输出。\n数据走你已登录的 Chrome，不另起浏览器。打开后输入 `xhh feed` 刷热榜、`xhh post <id>` 看帖子。'}
      </SettingText>
      {error && (
        <SettingText className="mt-2 text-amber-300">{`启动失败：${error}`}</SettingText>
      )}
    </section>
  )
}
