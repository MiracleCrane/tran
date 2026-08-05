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
      // 圆角标度对齐 Codex 桌面版实测的 --radius-* token（app.asar 里读的）：
      //   sm .375rem(6) / md .5rem(8) / lg .625rem(10) / 2xl 1rem(16)
      //   3xl 1.25rem(20) / 4xl 1.5rem(24) / 2xs .125rem(2)
      // Tailwind 默认是 sm 2 / md 6 / lg 8 / 3xl 24——整体比 Codex 硬。覆盖标度
      // 而不是逐处改类名：全 app 几百处 rounded-* 一次生效，也不会漏。
      // xl 保持 12px（Codex 没有对应档，介于 lg 10 与 2xl 16 之间，原值正好）。
      borderRadius: {
        '2xs': '0.125rem',
        xs: '0.25rem',
        sm: '0.375rem',
        DEFAULT: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.75rem',
        '2xl': '1rem',
        '3xl': '1.25rem',
        '4xl': '1.5rem',
        full: '9999px'
      },
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
