# Changelog

## v1.0.22 - 2026-07-23

### 中文

- 修复:权限模式按会话保持。此前在会话 A 选了 yolo 等模式后,切到别的对话再切回来会被重置回 default——resume 历史会话的两条路径(openSession/restartSession)都没有把权限模式传给后端,而 kimi CLI 的 session/load 不恢复会话模式(init 恒报 default)。现按 sdkSessionId 把模式持久化到 localStorage,resume 时显式下发并重放。
- 修复: Composer 的"模式"按钮现在直接显示激活的模式(模式·计划 / 模式·Swarm / 模式·目标),不用展开即可见。
- 修复:错误诊断误分类。"Cannot launch a new turn while another turn is active"(上一轮未结束时发送)此前因文案含 "Invalid" 被误判为"模型名可能无效",现正确识别为"上一轮仍在进行中"并给出等待/打断建议。
- 修复:待办清单完成态的打勾在小圆圈里视觉偏移(文本字形基线问题),改用 SVG 勾选,居中稳定。
- 新增:输入框支持直接粘贴剪贴板图片(截图工具/复制的图片),与拖拽同一附件管线,无图片时保持默认文本粘贴行为。
- 修复:历史会话打不开(Internal error)的自恢复。会话在计划模式中被中断会留下"wire 引用了 plan 文件但文件未保存"的残缺状态,kimi CLI 的 session/load 遇缺失 plan 文件直接整体失败。现 Tran 检测到这类 ENOENT 时自动补建占位 plan 文件并重试(白名单校验路径,最多 4 个缺失文件)。

### English

- Fixed: permission mode now sticks per session. Switching away and back to a conversation reset the mode to default because neither resume path (openSession/restartSession) passed the mode to the backend, and kimi CLI's session/load does not restore it (init always reports default). The mode is now persisted per sdkSessionId in localStorage and replayed on resume.
- Fixed: the Composer "模式" button now shows the active modes inline (模式·计划 / 模式·Swarm / 模式·目标) without expanding.
- Fixed: error diagnosis misclassification — "Cannot launch a new turn while another turn is active" was misread as a model-name error; it is now correctly identified as "previous turn still running".
- Fixed: the todo check mark was visually off-center in its circle (text glyph baseline); replaced with an SVG check.
- Added: paste clipboard images (screenshots/copied images) directly into the composer, using the same attachment pipeline as drag-and-drop.
- Fixed: self-recovery for history sessions failing to open with "Internal error". Sessions killed mid plan-mode can reference a plan file that was never saved, and kimi CLI's session/load fails hard on the missing file. Tran now recreates a placeholder plan file (path-whitelisted) and retries, up to 4 missing files.

#### 验证

- `npm run typecheck`

## v1.0.21 - 2026-07-23

### 中文

- 修复:输入框上方状态行"后台命令 / 子 Agent / 待办"三个 chip 间距不一致——"子 Agent"按钮带 `min-w-[120px]`,内容不足 120px 时右侧留下不可见空白,使其与"待办"的间距看起来比其他的大。移除该固定最小宽度(相邻"后台命令"chip 本就不预留宽度,计数变化时的轻微位移可接受),三个 chip 现按 `gap-3` 均匀排布。

### English

- Fixed: uneven spacing between the "后台命令 / 子 Agent / 待办" chips above the composer — the "子 Agent" button had `min-w-[120px]`, leaving invisible trailing space when its content was shorter, making the gap to "待办" look wider. The fixed min-width is removed (the neighboring "后台命令" chip reserves no width either; minor shift on count changes is acceptable), so all chips now space evenly via `gap-3`.

#### 验证

- `npm run typecheck`

## v1.0.20 - 2026-07-23

### 中文

- 回退:全套图标恢复为 v1.0.16 的 Kimi 克隆设计(黑底圆角方块 + 白色 T + 紫点、带颗粒质感)——任务栏/exe/安装器/托盘图标原样恢复,应用内 logo(标题栏/启动页/侧边栏)也改为直接渲染同一张图标图片,窗内窗外完全一致。移除 v1.0.17 的扁平重绘及 `scripts/generate-icon.ps1`。
- 修复:启动时屏幕左上角/品牌区偶发紫色光晕残影,物理屏可见但 CDP 抓屏不可见,手动缩放窗口后消失。根因有二:一是 `.tran-ambient` 静态光晕层与 `AmbientCanvas` 粒子层两个 z-index 30 的紫色覆盖层压在全部 UI 之上,残影内容均来自它们;二是 Windows 无边框窗口首次呈现时 DWM/DirectComposition 可能把某合成层旧纹理卡在屏幕上。现已整体移除这两个覆盖层(保留 body 背景渐变,氛围基本不变且更省性能),并在启动后自动做一次 ±1px 窗口尺寸微抖,强制重建合成树,等效于用户手动缩放一次。

### English

- Reverted: the entire icon set back to the v1.0.16 Kimi-clone design (near-black rounded square, white "T", purple dot, grain texture) — taskbar/exe/installer/tray icons restored as-is, and in-app logos (titlebar/splash/sidebar) now render the very same icon image so window and taskbar match exactly. Removed the v1.0.17 flat redraw and `scripts/generate-icon.ps1`.
- Fixed: intermittent purple haze artifact near the top-left/brand area at startup, visible on the physical screen but not in CDP screenshots, cleared by manually resizing the window. Two root causes: (1) the two z-index-30 purple overlay layers (`.tran-ambient` static glow and `AmbientCanvas` particles) painting above all UI — the source of every artifact's content; (2) Windows frameless windows can get a stale composited layer stuck on screen at first present by DWM/DirectComposition. Both overlays are removed (body background gradients remain, so the ambience barely changes and rendering is cheaper), and the window now performs a one-time ±1px size nudge shortly after startup to force the composition tree to rebuild — equivalent to a manual resize.

#### 验证

- `npm run typecheck`
- 诊断:OS 级物理截屏复现残影,CDP `captureScreenshot` 同时刻无残影,确认为显示链路残留层

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
