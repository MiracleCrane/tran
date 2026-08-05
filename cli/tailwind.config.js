/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: 'rgba(14, 15, 20, 0.26)',
          panel: 'rgba(28, 29, 36, 0.34)',
          elev: 'rgba(48, 48, 58, 0.38)',
          hover: 'rgba(76, 76, 88, 0.34)'
        },
        border: { subtle: 'rgba(238, 232, 226, 0.16)' },
        accent: '#8b5cf6'
      },
      // sans 完全照抄 Codex 桌面版实测的 --font-sans-default（见 main.tsx 注释）：
      // Windows 上落到 Segoe UI，中文落到系统默认，和 Codex 一模一样。
      // mono 只把首选换成随包分发的 JetBrains Mono，后面的兜底仍是 Codex 那串。
      // 两个栈的**中文兜底必须显式且一致**。原先两边都以 generic family 收尾
      // （sans-serif / monospace），而 Chromium 对这两个 generic 挑的中文字体
      // 不是同一个：sans-serif 落到微软雅黑，monospace 往往落到宋体/新宋体——
      // 于是终端和代码块里的中文又细又硬，和界面里的中文明显不是一个字。
      // 显式写死后两边都是微软雅黑（Windows）/ 苹方（macOS）。
      //
      // 注意这修的是"长得不一样"，修不了"列对不齐"：汉字全角 1.0em，而
      // JetBrains Mono 是 0.6em，1 个汉字 ≠ 2 个西文字符（差 0.2em，每 3 个汉字
      // 少一个西文字符宽）。要对齐得换 CJK 等宽字体（更纱黑体那类，5–15MB），
      // Codex 自己也没做。
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', '"Microsoft YaHei"', '"PingFang SC"', 'sans-serif'],
        mono: [
          '"JetBrains Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'Consolas', '"Liberation Mono"',
          '"Microsoft YaHei"', '"PingFang SC"', 'monospace'
        ]
      }
    }
  },
  plugins: []
}
