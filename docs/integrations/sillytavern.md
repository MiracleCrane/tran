# SillyTavern（RP 酒馆）集成

Tran 的 RP 酒馆功能由外置 SillyTavern 后端和终端 TUI 组成：Tran 负责检测安装、启动后端并打开 TUI，不接管模型密钥和复杂设定。

## 前置条件

- Windows 已安装 Node.js 20 或更高版本。
- 已安装 SillyTavern，推荐使用官方 release 分支：

  ```powershell
  git clone https://github.com/SillyTavern/SillyTavern -b release
  ```

  也可以使用 SillyTavern Launcher 或 GitHub Desktop，只要在 Tran 中选择的目录包含 `server.js`、`Start.bat` 和 `package.json` 即可。

## 使用方式

1. 在 Tran 侧栏打开“RP 酒馆”。
2. 确认或填写 SillyTavern 安装目录，点击“保存目录”。
3. 点击“打开 RP TUI”。Tran 会复用已运行的 8000 服务；未运行时先隐藏准备 npm 依赖，再直接启动 `node.exe server.js`，等待就绪后打开终端 TUI。

TUI 支持 Enter 发送、Shift+Enter 换行、F2 AI 帮答、F3 续写、F4 重试和 F9 打开完整网页。AI 帮答只把草稿放入输入框，不会自动发送。F6/F7/F8 调整字体，默认 F12 切换调试日志伪装界面。

老板键可在输入框用 `/bosskey <按键>` 修改并持久化，例如 `ctrl+b`、`mouse4`、`mouse5` 或 `middle`。聊天正文使用 Rich Markdown 渲染。

首次安装依赖时启动可能较慢，Tran 最多等待三分钟。启动输出保存在 Tran userData 的 `logs/rp-tavern.stdout.log` 和 `logs/rp-tavern.stderr.log`。

## 配置归属

- API Key、连接配置、模型和 Prompt 由 SillyTavern 管理。
- 角色卡、世界书和聊天记录由 SillyTavern 管理。
- TUI 通过本机 SillyTavern 接口使用同一份角色、聊天和当前连接，不读取或复制明文 API Key。
- TUI 在不可见的 Chrome/Edge 页面中调用 SillyTavern 原版前端生成函数，提示链与网页一致；它不再自行拼装简化 Prompt。
- 如果更换全新 SillyTavern 安装，需要在 SillyTavern 中重新配置 API，或迁移原安装的 `data` 目录。

## 边界与维护

- SillyTavern 不会被打进 Tran 安装包，Tran 也不会修改它的源码。
- Tran 不包含 `SillyTavernBridge`、AWS 桥、LiteLLM、Python 自动路由或额外 PowerShell 常驻脚本。
- 依赖准备阶段的 cmd 进程会在 npm 完成后退出；酒馆运行期间只有隐藏的 Node 服务和用户主动打开的 TUI 窗口。
- Tran 不自动执行 `git pull`，酒馆更新由用户或 SillyTavern Launcher 完成。
- Tran 退出时不会强制结束原本已运行的外部酒馆进程。

SillyTavern 是独立的 AGPL-3.0 开源项目，地址：<https://github.com/SillyTavern/SillyTavern>。
