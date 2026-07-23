# Changelog

## v1.0.19 - 2026-07-23

### 中文

- 修复:标题栏品牌区(logo + "Tran")偶发被一团紫色光斑罩住,最大化/还原窗口后尤其明显,光斑会随时间变淡消失、每次启动位置随机。根因:氛围粒子层(AmbientCanvas)以 z-index 30 画在整个应用最上层,粒子飘到左上角时正好盖住品牌区。现每帧绘制后擦掉标题栏 42px 区域,光斑不再污染品牌区,其余位置的氛围效果不变。

### English

- Fixed: an intermittent purple blob tinting the titlebar brand area (logo + "Tran"), most noticeable after window maximize/restore, fading over time with a random position per launch. Root cause: the ambient particle canvas (AmbientCanvas) paints on top of the whole app at z-index 30, so particles drifting into the top-left corner covered the brand area. The titlebar's 42px strip is now cleared after each frame; the ambient effect elsewhere is unchanged.

#### 验证

- `npm run typecheck`
- CDP 逐层排除实验(隐藏 `.ambient-canvas` 后角落光斑消失,恢复后复现)确认粒子层为根因

## v1.0.18 - 2026-07-23

### 中文

- 修复:窗口最大化/还原时侧边栏区域偶发"幽灵框"残影(反复操作会越缩越小直至消失)。根因是 `.sidebar-expand` / `.sidebar-collapse` / `.sidebar-deferred-content` 常驻类上永久挂着 `will-change`,使侧边栏长期占据独立 GPU 合成层,而 width 动画跑在主线程,窗口状态切换时合成器可能把过期图层纹理按旧缩放贴回屏幕。移除常驻 `will-change`(动画期间 Chromium 会自动提升图层,动效不受影响)。

### English

- Fixed: intermittent "ghost panel" artifact near the sidebar after window maximize/restore (shrinking away over repeated toggles). Root cause: permanent `will-change` on the always-present `.sidebar-expand` / `.sidebar-collapse` / `.sidebar-deferred-content` classes kept the sidebar on a dedicated GPU layer while its width animation ran on the main thread, so the compositor could re-blit a stale layer texture at an old scale on window state changes. The permanent `will-change` declarations are removed (Chromium still auto-promotes during the animation, so motion is unaffected).

#### 验证

- `npm run build`

## v1.0.17 - 2026-07-22

### 中文

- 优化:全套应用图标重绘为干净的扁平高分辨率设计(黑底圆角方块 + 白色 T + 紫点),去除噪点纹理;ICO 内含 16~256 共 10 个独立优化的尺寸,任务栏、桌面快捷方式、安装器/卸载器图标在高分屏下均清晰。
- 统一:标题栏、启动页、侧边栏(展开/收起)的应用 logo 统一为与任务栏图标一致的 SVG 组件,替换原先不协调的紫色文字块。
- 优化:系统托盘图标改为与主图标一致的设计,并新增 64px @2x 表示,高 DPI 显示器下不再模糊。
- 新增:`scripts/generate-icon.ps1` 图标生成脚本,设计调整后重跑即可再生成全套图标。

### English

- Improved: redrawn the full icon set as a clean flat high-resolution design (near-black rounded square, white "T", purple dot) with the grain texture removed; the ICO now packs 10 individually optimized sizes (16–256) so taskbar, shortcut, installer and uninstaller icons stay crisp on high-DPI displays.
- Unified: titlebar, splash and sidebar (expanded/collapsed) logos now share one SVG component identical to the taskbar icon, replacing the mismatched purple text tile.
- Improved: system tray icon now matches the app icon and ships a 64px @2x representation for high-DPI displays.
- Added: `scripts/generate-icon.ps1` to regenerate the whole icon set after design tweaks.

#### 验证

- `npm run typecheck`
- `npm run build:win`(安装包 exe 图标提取确认;托盘图标渲染确认)

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
