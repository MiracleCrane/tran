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
        accent: '#df765f'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
}
