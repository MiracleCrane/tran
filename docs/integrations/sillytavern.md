# SillyTavern（RP 酒馆）集成

Tran 的 RP 酒馆功能是一个外部伴侣集成：Tran 负责检测、启动和打开窗口，SillyTavern 仍是独立安装、独立更新的软件。

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
3. 状态正常后点击“打开酒馆”。Tran 会复用运行中的服务；未运行时会启动它并等待就绪。

如果存在 `C:\LegacyD\Programs\SillyTavernBridge\Start-RPTavern.ps1`，Tran 会优先使用该伴侣启动器，以便同时启动本机桥接与自动模型路由。否则只启动 SillyTavern 自身。

## 边界与维护

- SillyTavern 不会被打包进 Tran 安装包，Tran 也不会修改其源码。
- Tran 不会自动执行 `git pull`，升级由用户在 SillyTavern 目录或 Launcher 中完成。
- Tran 退出时不会强制结束外部酒馆进程，以免终止原本由用户启动的会话。
- 角色卡、预设、聊天记录和 API 密钥仍由 SillyTavern 管理；Tran 不复制模型凭据。
- 备份和迁移 SillyTavern 数据时，请遵循其官方文档。

SillyTavern 由其项目按 AGPL-3.0 授权。项目地址：<https://github.com/SillyTavern/SillyTavern>。
