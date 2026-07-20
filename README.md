# Tran

Tran 是一个 Windows 桌面客户端：给本机的 CLI AI agent 套上图形界面。
当前内置 **Kimi Code CLI** 后端（通过 ACP / `kimi acp` 接入）；主进程的
`AgentBridge` 保留了可插拔的后端适配层，未来可以在不动 UI/IPC 的情况下扩展更多后端。

## 技术栈

- Electron + electron-vite
- React 18 + Tailwind + zustand（渲染进程）
- 主进程：`cli/src/main`（agent 后端桥接在 `cli/src/main/agent`）
- 共享类型：`cli/src/shared`

## 前置条件

- 安装 Kimi Code CLI 并完成登录（终端里运行 `kimi`，按提示登录）。
- `kimi` 需在 PATH 上；不在时 Tran 会回退查找
  `%USERPROFILE%\.kimi-code\bin\kimi.cmd` / `kimi.exe` / `kimi`。

## 常用命令

在仓库根目录执行：

```bash
npm install
npm run dev          # 开发模式启动桌面客户端
npm run typecheck    # 主进程 + 渲染进程类型检查
npm run build:win    # 打包 NSIS 安装包（release/）
```
