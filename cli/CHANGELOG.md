# Changelog

## v1.0.4 - 2026-06-18

### 中文

- 新增:Composer 输入框工具栏可实时切换当前会话的权限模式(默认 / 自动接受编辑 / 计划模式 / 跳过权限 / 自动),即时生效,无需重开会话。
- 移除:Composer 的"上下文"按钮,以及发送消息时自动拼接 `Project context:` 前缀的行为;消息现按原文发送。
- 优化:侧边栏展开/收紧动画改用与下拉菜单一致的平滑 ease-out 曲线,移除手调关键帧停顿,运动更顺滑、与会话界面缩放保持一致。

### English

- Added: live permission-mode switching from the Composer toolbar (default / accept-edits / plan / bypass / auto), taking effect immediately without restarting the session.
- Removed: the Composer "上下文" (context) button and the automatic `Project context:` prefix prepended to messages; messages are now sent as typed.
- Improved: sidebar expand/collapse now uses the same smooth ease-out curve as the dropdowns, replacing the hand-tuned keyframe stops for a smoother motion that stays in sync with the chat area resizing.

#### 验证

- `npm run typecheck`

## v1.0.3 - 2026-06-17

### 中文

#### 重点更新

- 新增多 Agent 后端架构，支持 Claude Code 与 Codex 适配器、Codex App Server 集成、Codex 历史记录读取，以及按后端区分的模型列表。
- 优化前台交互响应：页面切换、项目/会话点击、发送消息、滚动等操作优先更新界面；如果新的交互发生，旧的异步结果会被丢弃。
- 历史会话改为渐进式加载：先显示最近内容，再在后台逐步预加载更早的消息，避免影响滚动。
- 恢复会话进入时的转圈等待提示，同时保持普通点击和滚动不被阻塞。
- 优化文件和目录预览：点击路径后预览框立即出现并显示加载状态；路径不存在、无法读取或超时会在预览框内提示，不再卡住客户端。
- 为慢速路径读取、目录扫描、资源管理器打开增加超时保护，尤其改善失效 WSL 路径或网络路径带来的卡顿。
- WSL 文件/目录交互改用异步读取，减少主进程阻塞。
- 只有调用系统目录选择器时才显示全屏等待，这是唯一允许阻塞前台的场景。

#### 界面和工作流

- 新增 Codex 感知的运行状态、Provider/模型处理、Composer 默认值和设置项。
- 项目切换支持快速点击抢占，后一次切换可以覆盖前一次尚未返回的请求。
- 优化侧边栏和会话列表加载状态，减少可见 loading 抖动。
- 调整 Codex 会话的虚拟列表参数，减少上下滚动时的闪烁。
- 附件选择、拖入和提交更安全，旧的后台读取不会在用户删除或发送后把附件重新加回来。

#### 更新和诊断

- 新增可配置的更新下载流程和进度显示。
- 改进诊断导出、设置导入和运行状态展示。
- 插件/技能市场增加按 Agent 后端过滤的支持。

#### 验证

- `npm run typecheck`
- `npm run build`
- `npm run build:win`

### English

#### Highlights

- Added the multi-agent backend architecture, including Claude Code and Codex adapters, Codex App Server integration, Codex history loading, and backend-aware model lists.
- Improved foreground responsiveness: view switches, project/session clicks, composer submission, and transcript scrolling now update the UI first; stale async results are ignored when a newer interaction wins.
- Added progressive transcript hydration for history sessions: recent messages render first, while older messages preload in the background without interrupting scrolling.
- Restored the in-session startup spinner while keeping normal clicks and scrolling non-blocking.
- Improved file and directory previews: clicking a path opens the preview pane immediately with a loading state; missing, unreadable, or timed-out paths now report inside the preview pane instead of freezing the client.
- Added timeout protection around slow path reads, directory scans, and reveal-in-Explorer calls, especially for stale WSL or network paths.
- Moved WSL file and directory interactions to async filesystem reads to reduce main-process blocking.
- The full-screen blocking spinner is now limited to OS directory picker calls, the one case where waiting on Explorer is expected.

#### UI And Workflow

- Added Codex-aware runtime status, provider/model handling, composer defaults, and settings controls.
- Improved project switching so rapid clicks can supersede earlier project changes.
- Improved sidebar and session-list loading behavior to reduce visible loading churn.
- Tuned transcript virtualization for Codex sessions to reduce flicker while scrolling.
- Made attachment picker, drag/drop, and submit flows safer so stale background reads cannot re-add attachments after removal or submission.

#### Updates And Diagnostics

- Added a configurable update download flow with progress reporting.
- Improved diagnostic export, settings import, and runtime status reporting.
- Added backend-aware filtering support for marketplace plugins and skills.

#### Verification

- `npm run typecheck`
- `npm run build`
- `npm run build:win`
