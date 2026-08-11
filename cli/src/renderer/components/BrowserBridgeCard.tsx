import { useEffect, useState } from 'react'
import type { BrowserBridgeStatus } from '../../shared/ipc'
import { useTransientFlag } from '../hooks/useTransientFlag'

/**
 * 「浏览器控制」状态块：展示 Chrome 扩展桥的连接状态、配对码与安装引导。
 * 状态由主进程推送（forge:browser-bridge-status），挂载时先拉一次兜底。
 */
export default function BrowserBridgeCard(): JSX.Element {
  const [status, setStatus] = useState<BrowserBridgeStatus | null>(null)
  const [copied, flashCopied] = useTransientFlag(1500)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.getBrowserBridgeStatus().then((s) => {
      if (alive) setStatus(s)
    }).catch(() => {})
    const off = window.api.onBrowserBridgeStatus((s) => setStatus(s))
    return () => {
      alive = false
      off()
    }
  }, [])

  const copyPairingCode = async (): Promise<void> => {
    if (!status?.pairingCode) return
    try {
      await navigator.clipboard.writeText(status.pairingCode)
      flashCopied()
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  const connected = status?.extensionConnected ?? false
  const running = status?.running ?? false
  const stateLabel = !status
    ? '加载中'
    : !running
      ? '服务未启动'
      : connected
        ? '已连接'
        : '等待扩展连接'
  const dotClass = connected
    ? 'bg-emerald-500'
    : running
      ? 'bg-amber-500 animate-pulse'
      : 'bg-red-500'
  const textClass = connected ? 'text-emerald-400' : running ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="mt-6 rounded-xl border border-border-subtle bg-bg-panel px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">浏览器控制</span>
        <span className={`inline-flex items-center gap-1.5 text-[11px] ${textClass}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
          {stateLabel}
        </span>
        {connected && status?.extensionVersion && (
          <span className="text-[11px] text-zinc-500">扩展 v{status.extensionVersion}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setShowGuide((v) => !v)}
            className="rounded px-2 py-0.5 text-[11px] text-zinc-400 transition hover:bg-bg-hover hover:text-zinc-200"
          >
            {showGuide ? '收起引导' : '安装引导'}
          </button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        通过 Chrome 扩展让 AI 操作你日常在用的浏览器（标签页、页面读取、点击输入）。
      </p>

      {running && status?.pairingCode && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">配对码</span>
          <code className="max-w-[280px] truncate rounded bg-bg-elev px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
            {status.pairingCode}
          </code>
          <button
            onClick={() => void copyPairingCode()}
            className="rounded border border-border-subtle bg-bg-elev px-2 py-0.5 text-[11px] text-zinc-300 transition hover:bg-bg-hover"
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}

      {!running && status && (
        <div className="mt-2 text-[11px] text-red-400/80">
          本机 WebSocket 服务启动失败（端口被占用？），重启 Tran 重试。
        </div>
      )}

      {showGuide && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-[11px] leading-relaxed text-zinc-400">
          <li>
            打开 Chrome，访问 <code className="rounded bg-bg-elev px-1 py-0.5 font-mono">chrome://extensions</code>
            ，右上角打开「开发者模式」。
          </li>
          <li>
            点「加载已解压的扩展程序」，选择 Tran 安装目录下的{' '}
            <code className="rounded bg-bg-elev px-1 py-0.5 font-mono">resources/browser-extension</code>{' '}
            文件夹（开发模式为仓库的 <code className="rounded bg-bg-elev px-1 py-0.5 font-mono">cli/extension</code>）。
          </li>
          <li>在扩展详情页打开「扩展程序选项」，粘贴上面的配对码并保存。</li>
          <li>扩展图标显示 ON、此处显示「已连接」即配对成功。</li>
        </ol>
      )}
    </div>
  )
}
