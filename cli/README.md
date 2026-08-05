# Tran

Tran 是一个面向 Windows 的 **Kimi Code CLI** 桌面客户端。它把会话、项目、Git 状态、技能、翻译、MCP 和后台任务放在同一个安静而完整的工作台里，让日常编码对话更顺手、更稳定，也更好看。

界面采用克制的玻璃质感和紧凑布局，窗口、侧栏、顶栏、输入框、下拉面板和会话列表的动画都围绕连续、轻盈、不打断工作来设计。

## 特色

- 优雅的桌面 UI：深色玻璃面板、柔和高光、精致的系统托盘图标。
- 连贯的动画体验：侧栏、会话切换、Git 顶栏、快捷命令、设置项和列表变化都有平滑过渡。
- 项目化会话管理：按项目工作目录组织会话，支持历史会话、置顶、重命名、删除。
- 后台会话保活：切走的会话在后台继续推进，切回时接上进度。
- 流式输出与工具卡片：命令、子代理、待办、权限请求都有独立的可视化卡片。
- Git 顶栏：查看分支、状态、提交记录，执行 fetch、branch、commit 等常用操作。
- AI 辅助小功能：会话自动命名、命令一句话说明、思考摘要与翻译（走用户自己配置的 OpenAI 兼容 API，可一键关闭）。
- 翻译支持：技能/插件描述可用大模型或百度翻译 API 本地化。
- MCP 管理：查看与编辑 Kimi Code 的 MCP server 配置。
- 系统托盘：关闭窗口可选择最小化到托盘，后台运行完成后可发送原生通知。
- 设置导入 / 导出：备份模型列表、外观和应用偏好。
- 自更新：设置页检查并下载 GitHub Release 上的新版本。

## 安装

从 [GitHub Releases](https://github.com/MiracleCrane/tran/releases) 下载最新的 `Tran-X.Y.Z-setup.exe`，运行安装向导即可。

Tran 本身是桌面客户端，需要本机已安装并登录 Kimi Code CLI：

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
kimi --version
```

也可以使用 npm：

```powershell
npm install -g @moonshot-ai/kimi-code
```

`kimi` 需在 PATH 上；不在时 Tran 会回退查找 `%USERPROFILE%\.kimi-code\bin\` 下的可执行文件。

## 基本操作

1. 首次启动后，在设置中确认默认权限模式、思考强度和模型。
2. 在左侧选择项目或新建会话，Tran 会以当前项目目录作为 Kimi 的工作目录。
3. 在底部输入框发送消息。按 `Enter` 发送，按 `Shift+Enter` 换行。
4. 点击输入框附件按钮添加文件，也可以把文件拖入或粘贴到输入区。
5. 输入 `/` 打开快捷命令提示，用上下方向键选择，按 `Enter` 确认。
6. 顶部 Git 区域可以折叠 / 展开。
7. 左侧底部工具入口可进入技能、MCP、翻译、设置和说明页面。
8. 在设置中开启"最小化到系统托盘"后，关闭窗口会让 Tran 留在后台运行。

## 翻译

进入"翻译"页面选择翻译引擎：

- 大模型翻译：使用配置的 OpenAI 兼容 API，质量高，适合少量内容。
- 百度翻译：填写 App ID 和 Secret Key 后使用百度通用翻译 API，适合大量短文本，额度独立。

## 开发

从仓库根目录执行：

```powershell
npm install
npm run dev          # 开发模式
npm run typecheck    # 主进程 + 渲染进程类型检查
npm run build:win    # 打包 NSIS 安装包（cli/release/）
```

根目录脚本会转发到 `cli` 子项目。版本号在 `cli/package.json`，changelog 在 `cli/CHANGELOG.md`。
