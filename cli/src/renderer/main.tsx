import React from 'react'
import { createRoot } from 'react-dom/client'
/**
 * 只自带等宽字体，界面字体交给系统。
 *
 * 依据是实测 Codex 桌面版（OpenAI.Codex 26.730，app.asar → webview/assets）：
 *   body            font-family: var(--vscode-font-family)
 *   --font-sans-default : -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
 *   --font-mono-default : ui-monospace, "SF Mono", Menlo, Consolas, monospace
 * 即 Codex 在 Windows 上就是 **Segoe UI + Consolas**，纯系统字体；asar 里那两个
 * `OpenAI Sans` 的 @font-face 只挂在 --font-openai-sans 上，主界面没有用到；
 * 中文它没做任何指定，落到系统默认。界面字体因此跟随 Codex 走系统栈。
 *
 * 等宽是唯一的例外，刻意不跟 Codex：JetBrains Mono 的 x-height 更大（同字号更
 * 易读）、0/1/l/I 做过区分，是为代码设计的；Consolas 的长处在 Windows hinting，
 * 在 Chromium + 高分屏上用不上。
 *
 * 字体文件用 JetBrains 官方完整版而非 @fontsource 子集（后者缺制表符会让终端
 * 输出错列），原因见 assets/fonts/fonts.css 的注释。
 */
import './assets/fonts/fonts.css'
import 'highlight.js/styles/github-dark.css'
import './styles.css'
import App from './App'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('root element not found')

const gpuBackend = new URLSearchParams(window.location.search).get('gpuBackend')
if (gpuBackend) document.documentElement.dataset.gpuBackend = gpuBackend

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
