# Forge (macOS)

Forge 是 Claude Code Agent 的 macOS 桌面客户端。它把会话、项目、Git 状态、运营商配置、技能、翻译和 MCP 放在同一个安静而完整的工作台里，让日常编码对话更顺手、更稳定，也更好看。

macOS 版基于 Windows 版移植，**仅保留 Claude Code 后端**（Codex / Hermes / WSL 在 macOS 上不可用）。

## 特色

- 优雅的桌面 UI：深色玻璃面板、柔和高光、统一的 Forge `F` 标识和系统托盘图标；macOS 使用原生红绿灯窗口控件（`hiddenInset` 标题栏）。
- 连贯的动画体验：侧栏、会话切换、Git 顶栏、快捷命令、模板面板、设置项和列表变化都有平滑过渡。
- 项目化会话管理：按项目工作目录组织会话，支持历史会话、置顶、重命名、删除。
- Claude Code 桌面工作流：在 Forge 内直接启动会话、发送消息、附加文件、预览附件、处理权限请求。
- Git 顶栏：查看分支、状态、提交记录，执行 fetch、branch、commit 等常用 Git 操作。
- 运营商管理：配置不同运营商 / API Provider，并同步默认模型到 `~/.claude/settings.json`。
- 快捷命令和模板：输入 `/` 唤起命令提示，支持方向键选择、回车确认。
- 翻译支持：可选择使用当前运营商的大模型翻译，或配置百度翻译 API 处理大量短文本。
- 系统托盘：关闭窗口可选择最小化到托盘，后台运行完成后可发送原生通知。
- 设置导入 / 导出：备份运营商、模型列表、外观和应用偏好。

## 安装

### 1. 安装 Claude Code

Forge 是桌面客户端，真正运行 Claude 会话的是 `claude` CLI，请先安装：

```bash
# 官方脚本（推荐）
curl -fsSL https://claude.ai/install.sh | bash

# 或 Homebrew
brew install claude-code

# 或 npm
npm install -g @anthropic-ai/claude-code
```

验证：

```bash
claude --version
```

### 2. 安装 Forge

从 GitHub Release 下载 `Forge-1.0.5-external-claude-mac-arm64.dmg`（Apple Silicon）或
`Forge-1.0.5-external-claude-mac-x64.dmg`（Intel），双击打开，把 **Forge** 拖进「应用程序」。

首次打开因为是未签名构建，需要**右键 → 打开**绕过 Gatekeeper。

> Forge 会自己查找 `claude` 可执行文件（扫描 PATH，以及 `/opt/homebrew/bin`、
> `/usr/local/bin`、`~/.claude/local` 等常见位置），因为 GUI 启动的应用不会继承
> 你 shell 里的 PATH。如果找不到，会在应用内给出清晰提示。也可以用环境变量
> `FORGE_CLAUDE_PATH` 显式指定 `claude` 的绝对路径。

## 基本操作

1. 首次启动后，在设置中确认默认权限模式、默认思考强度和模型列表。
2. 在左侧选择项目或新建会话，Forge 会以当前项目目录作为 Claude Code 的工作目录。
3. 在底部输入框发送消息。按 `Enter` 发送，按 `Shift+Enter` 换行。
4. 点击输入框左侧附件按钮添加文件，也可以把文件拖入输入区。
5. 输入 `/` 打开快捷命令提示，用上下方向键选择，按 `Enter` 插入。
6. 点击右侧「模板」按钮打开 Prompt 模板上拉栏，选择后会自动填入输入框。
7. 点击「上下文」开关决定是否把当前项目路径附加到消息上下文中。
8. 顶部 Git 区域可以折叠 / 展开；展开时 Forge 会尽量保持接近底部的会话滚动位置稳定。
9. 左侧底部工具入口可进入技能、MCP、运营商、翻译、设置和说明页面。
10. 在设置中开启「最小化到系统托盘」后，关闭窗口会让 Forge 留在后台运行。

## 运营商与默认模型

在「运营商」页面配置 API Provider（baseUrl、鉴权方式、Token、默认模型）。保存后 Forge 会
把激活运营商的连接信息和默认模型写入 `~/.claude/settings.json` 的 `env`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://...",
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_MODEL": "glm-5.2"
  }
}
```

切换激活运营商时，Forge 会自动更新这些字段。

## 翻译

进入「翻译」页面选择翻译引擎：

- 运营商模型翻译：使用当前激活运营商的 `/v1/messages` 能力，质量高，适合少量内容。
- 百度翻译：填写 App ID 和 Secret Key 后使用百度通用翻译 API，适合大量短文本，额度独立。

保存后，技能 / 插件描述等翻译场景会自动使用所选引擎。

## 开发

从仓库根目录安装依赖：

```bash
npm install
```

从仓库根目录启动开发环境（热更新）：

```bash
npm run cli-mac:dev
```

类型检查：

```bash
npm run cli-mac:typecheck
```

构建 macOS 安装包：

```bash
npm run cli-mac:build:mac
```

根目录脚本会转发到 `cli-mac` 子项目。也可以进入 `cli-mac/` 后直接运行同名命令；构建产物
会输出到 `cli-mac/release/` 目录。

> 应用图标由 `cli-mac/scripts/generate-icon.cjs` 程序化生成（含 1024px + `iconutil` 打包
> 成 `icon.icns`），运行 `npm --workspace @claude-forge/cli-mac run icon` 可重新生成。

## 与 Windows 版的差异

- **后端**：仅 Claude Code（Codex / Hermes / WSL 已禁用，UI 中相应入口已隐藏）。
- **GPU**：macOS 使用原生 Metal 合成，Windows 的 Vulkan / D3D11 实验开关已隐藏。
- **窗口**：使用 macOS 原生红绿灯控件，而非 Windows 的自定义标题栏按钮。
- **配置路径**：Claude Code 配置在 `~/.claude/settings.json`；Hermes 配置在 `~/.hermes/config.yaml`。

## 版本

当前版本：`1.0.5`
