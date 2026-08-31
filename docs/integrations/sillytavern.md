# SillyTavern（RP 酒馆）集成

Tran 的 RP 酒馆功能是一个纯启动器：Tran 负责检测外置安装、启动 SillyTavern 和打开独立窗口，不参与模型与聊天配置。

## 前置条件

- Windows 上已安装 Node.js 20 或更高版本。
- 已安装 SillyTavern。推荐使用官方 release 分支：

  ```powershell
  git clone https://github.com/SillyTavern/SillyTavern -b release
  ```

  也可以使用 SillyTavern Launcher 或 GitHub Desktop；只要在 Tran 中选择的目录包含 `server.js`、`Start.bat` 和 `package.json` 即可。

## 使用方式

1. 在 Tran 侧栏打开“RP 酒馆”。
2. 确认或填写 SillyTavern 安装目录，点击“保存目录”。
3. 点击“打开酒馆”。Tran 会复用已运行的 8000 服务；未运行时先隐藏准备 npm 依赖，再直接启动 `node.exe server.js`，等待就绪后打开窗口。

首次安装依赖时启动可能较慢，Tran 最多等待三分钟。启动输出保存在 Tran userData 的 `logs/rp-tavern.stdout.log` 和 `logs/rp-tavern.stderr.log`。

## 配置归属

- API Key、连接配置和模型选择由 SillyTavern 管理。
- Prompt、角色卡、世界书和聊天记录由 SillyTavern 管理。
- Tran 不读取、复制、注入或修改上述配置。
- 从新电脑全新安装 SillyTavern 后，需要在 SillyTavern 内重新配置 API，或迁移原来的 `data` 目录。

## 边界与维护

- SillyTavern 不会被打包进 Tran 安装包，Tran 也不会修改其源码。
- Tran 不依赖 `SillyTavernBridge`、AWS 桥、LiteLLM、Python 自动路由器或外置 PowerShell 启动脚本。
- 依赖准备阶段的 cmd 进程会在 npm 完成后退出；酒馆运行期间不保留 cmd 父进程。
- Tran 不会自动执行 `git pull`，升级由用户在 SillyTavern 目录或 Launcher 中完成。
- Tran 退出时不会强制结束原本已运行的外部酒馆进程。

SillyTavern 由其项目按 AGPL-3.0 授权。项目地址：<https://github.com/SillyTavern/SillyTavern>。
