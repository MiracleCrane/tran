# Forge

Forge 是一个面向 Windows 的 Claude Code / Claude Agent 桌面客户端。它把会话、项目、Git 状态、Provider 配置、技能、翻译和 WSL 运行环境放在同一个安静而完整的工作台里，让日常编码对话更顺手、更稳定，也更好看。

1.0 版本的重点是体验完整度：界面采用克制的玻璃质感和紧凑布局，窗口、侧栏、顶栏、输入框、下拉面板和会话列表的动画都围绕连续、轻盈、不打断工作来设计。许多细节都经过处理，例如 Git 顶栏展开时会自动避让接近底部的会话滚动位置，展开后再回到底部，减少抖动和闪烁。

## 特色

- 优雅的桌面 UI：深色玻璃面板、柔和高光、统一的 Forge `F` 标识和更精致的系统托盘图标。
- 连贯的动画体验：侧栏、会话切换、Git 顶栏、快捷命令、模板面板、设置项和列表变化都有平滑过渡。
- 项目化会话管理：按项目工作目录组织会话，支持历史会话、置顶、重命名、删除和 Windows / WSL 过滤。
- Claude Code 桌面工作流：在 Forge 内直接启动会话、发送消息、附加文件、预览附件、处理权限请求。
- Git 顶栏：查看分支、状态、提交记录，执行 fetch、branch、commit 等常用 Git 操作。
- Provider 管理：配置不同运营商 / API Provider，并支持按 Windows 或 WSL 后端维护模型列表。
- 快捷命令和模板：输入 `/` 唤起命令提示，支持方向键选择、回车确认；模板面板也有动画上拉体验。
- 翻译支持：可选择使用当前 Provider 的大模型翻译，或配置百度翻译 API 处理大量短文本。
- WSL 内 Claude Code：支持在 WSL 环境运行 Claude Code，读取 WSL 历史，并提供 WSL 健康检查和基础修复。
- 系统托盘：关闭窗口可选择最小化到托盘，后台运行完成后可发送原生通知。
- 设置导入 / 导出：备份 Provider、模型列表、外观和应用偏好。

## 安装

从 GitHub Release 下载 `Forge-1.0.0-setup.exe`，运行安装向导即可。

Forge 本身是桌面客户端，仍需要本机或 WSL 中已经可用的 Claude Code：

```powershell
irm https://claude.ai/install.ps1 | iex
claude --version
claude doctor
```

也可以使用 WinGet：

```powershell
winget install Anthropic.ClaudeCode
```

如果要使用 WSL 后端，请进入 WSL 终端安装 Claude Code：

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

## 基本操作

1. 首次启动后，在设置中确认默认权限模式、默认思考强度和模型列表。
2. 在左侧选择项目或新建会话，Forge 会以当前项目目录作为 Claude Code 工作目录。
3. 在底部输入框发送消息。按 `Enter` 发送，按 `Shift+Enter` 换行。
4. 点击输入框左侧附件按钮添加文件，也可以把文件拖入输入区。
5. 输入 `/` 打开快捷命令提示，用上下方向键选择，按 `Enter` 插入。
6. 点击右侧“模板”按钮打开 Prompt 模板上拉栏，选择后会自动填入输入框。
7. 点击“上下文”开关决定是否把当前项目路径附加到消息上下文中。
8. 顶部 Git 区域可以折叠 / 展开；展开时 Forge 会尽量保持接近底部的会话滚动位置稳定。
9. 左侧底部工具入口可进入技能、MCP、Provider、翻译、设置、WSL 健康检查和说明页面。
10. 在设置中开启“最小化到系统托盘”后，关闭窗口会让 Forge 留在后台运行。

## 翻译

进入“翻译”页面选择翻译引擎：

- 运营商模型翻译：使用当前激活 Provider 的 `/v1/messages` 能力，质量高，适合少量内容。
- 百度翻译：填写 App ID 和 Secret Key 后使用百度通用翻译 API，适合大量短文本，额度独立。

保存后，技能 / 插件描述等翻译场景会自动使用所选引擎。

## WSL 支持

在设置中开启 WSL 支持后，Forge 会显示 WSL 会话、WSL Provider Profile 和 WSL 健康检查入口。WSL 后端适合已经把开发环境、依赖和 Claude Code 都放在 Linux 子系统中的工作流。

需要注意：

- Windows 原生 Claude Code 和 WSL Claude Code 是两套环境。
- Windows 配置通常在 `C:\Users\<用户名>\.claude`。
- WSL 配置通常在 `~/.claude`。
- 如果当前项目路径无法映射到 WSL，先在 WSL 健康检查中查看诊断信息。

## 开发

安装依赖：

```powershell
npm install
```

启动开发环境：

```powershell
npm run dev
```

类型检查：

```powershell
npm run typecheck
```

构建 Windows 安装包：

```powershell
npm run build:win
```

构建产物会输出到 `release/` 目录。

## 版本

当前版本：`1.0.0`
