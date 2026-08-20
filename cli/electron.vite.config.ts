import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 注意：mcp-browser 不走这里——多入口会把 ws 拆成共享 chunk，而它
        // 必须是单文件（extraResources 只带一个 js）。见 build:mcp（esbuild）。
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // ws 的可选原生加速依赖：留成运行时 require，ws 内部 try/catch
        // 会在缺失时退回纯 JS 实现；打进 bundle 反而变成硬依赖报错。
        external: ['bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // 桌面宠物窗口的独立 preload（只暴露 petApi，不带完整 ForgeApi）。
          pet: resolve(__dirname, 'src/preload/pet.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // 桌面宠物窗口页面（独立 BrowserWindow 加载，见 main/petWindow.ts）。
          pet: resolve(__dirname, 'src/renderer/pet.html')
        }
      }
    },
    plugins: [react()]
  }
})
