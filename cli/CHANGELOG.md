# Changelog

## v1.1.24 - 2026-08-19

### 中文

- 优化:**后台命令 chip 实况化**——有任务在跑时显示「后台命令 N 运行中 · mm:ss」(秒级走时),空闲时才显示累计数;面板里后台命令与后台子 Agent 同口径:「后台」徽章、运行中高亮置顶、按 kimi server 校正的用时、运行中可一键停止(原先只认子 Agent,后台命令永远显示"已完成")。
- 新增:**编辑条 AI 一句话说明**——Edit/Write 这类没有 description 的工具,条上跟一句「· 改了什么」(实测:「patch cli/README.md · 添加 Tran 标记」);走摘要通道 + 内容哈希落盘缓存,同一编辑零重复花费。Bash 不动(自带 description)。
- 新增:**集合行整组 AI 总结**——折叠行变成「思考 N 段 · 编辑文件 ×M · 创建并编辑文件」这种,计数后面跟一句整组总结;只在轮收尾后问一次(流式生长期间不问),小模型偶发判废不落缓存、下次自动重试。

### English

- Live background-command chip: while tasks run it shows "N running · mm:ss" (ticking every second); the panel now treats background commands the same as background sub-agents — a "background" badge, running rows pinned and highlighted, durations corrected against the kimi server, and a one-click stop (previously only sub-agents got this; background commands always showed as done).
- New: one-line AI notes on Edit/Write bars ("· what changed"), which unlike Bash have no description of intent; served by the summary channel with content-hash disk cache, so the same edit never costs twice.
- New: whole-group AI summary on folded collection rows ("N thinking · ×M edits · created and edited files"), requested once when the turn settles; transient rejections are not cached so a later view retries automatically.

## v1.1.23 - 2026-08-18

### 中文

- 优化:**流式期间集合行贴着正在输出的尾巴**——边输出边折叠时,折进去的 bar 汇成「思考 N 段 命令 ×N…」集合行,落在「当前 + 上一条」展开 bar 的正上方,始终在视野内;每折进一个计数实时涨。原先集合行落在段首,段一长就滚出视口,看起来像 bar 凭空消失。轮末收齐与历史布局不变。

### English

- Live output folding: the collection row ("N thinking, ×N commands…") now sits right above the two expanded tail bars (current + previous), staying in view while streaming, and its counters increment live as bars fold in. Previously the row anchored at the segment start and scrolled out of view on long segments, making bars look like they vanished. Turn-end folding and history layout are unchanged.

## v1.1.22 - 2026-08-18

### 中文

- 修复:**思考摘要/翻译/AI 命名/命令说明全部不生效**——摘要请求带 `stop: ['\n']`,而硅基 GLM-4-9B 的回复以 `\n` 开头,服务端在第 0 字截断,HTTP 200 但内容为空(日志里"连续几千次失败"即此);单行约束由 terseText 客户端兜底,删除 stop。失败的空结果已按"判废"缓存,本次同时清空毒缓存(500 条)。
- 修复:**上下文压缩全程无反馈、看起来像"秒成功/假成功"**——`/compact` 发送即点亮「正在压缩上下文…」(此前 kimi 后端从不发 compacting 状态,压缩的 2-3 分钟界面零反馈);只流开场白的秒回轮不再推"已压缩"分界线,统计文本齐了才推;压缩期间发消息不再让人误以为死机。
- 修复:**压缩分界线位置错乱**——统计分界线原先挂到下一轮末尾才推(落在最新消息下面);现改在 steered 轮收尾即时结算;重启后由 wire 全量重建在**历史正确位置**重建分界线,且「查看摘要」展示真实摘要正文(此前只有统计数字)。
- 优化:**侧栏段标(置顶/项目/最近)11px → 13px**,刷新过渡快照同步。
- 修复:**点侧栏刷新时项目组头闪完整路径**——过渡快照直接渲了原始路径,改为与实时列表一致只显示末段名。
- 修复:**会话删光后项目组消失**——空项目保留组头(可直接点「+」开新会话),主目录仍不算项目。

### English

- Fix: thinking summaries/translations, AI titles and command notes all broken — the summary request used `stop: ['\n']`, and SiliconFlow GLM-4-9B starts replies with `\n`, so the server truncated at position 0 (HTTP 200 with empty content). The stop is removed; terseText enforces single-line client-side. Poisoned empty-result caches (500 entries) were purged.
- Fix: context compaction gave zero feedback and looked like an instant "fake success" — a "compacting context…" indicator now lights up as soon as `/compact` is sent (the kimi backend previously never reported the compacting state, leaving the UI blank for the real 2-3 minute compaction); the early ack turn no longer pushes a premature divider; dividers are only pushed once completion stats arrive.
- Fix: compaction dividers landed in the wrong place (the stats divider used to be flushed at the end of the *next* turn, below the latest message). They are now settled when the steered turn ends; after a restart, the wire full-rebuild recreates dividers at their true historical positions, and "view summary" shows the actual summary text instead of only stats.
- Sidebar section labels (Pinned/Projects/Recent) enlarged 11px → 13px, including the refresh-transition snapshot.
- Fix: clicking sidebar refresh flashed full project paths in group headers — the transition snapshot rendered the raw path; it now shows the basename like the live list.
- Fix: a project disappeared from the sidebar once all its sessions were deleted — empty projects keep their group header (with a working "+" new-chat button); the home directory still doesn't count as a project.

## v1.1.21 - 2026-08-18

### 中文

- 新增:**边输出边折叠**——活动流只留「正在输出的 + 上一个」两条 bar,更早的即刻折进集合行(计数实时涨);文本落地收上面整段,轮末一律收齐。
- 新增:**轮次改动卡即时出**——「已编辑 N 个文件 +X -Y」从本轮 Write/Edit 工具输入直接统计,轮一结束立刻落在本轮输出最下面;废弃 git 快照对(大脏仓库里快照 IPC 被轮内流量饿死约 1 分钟,卡片落地太晚位置全错)。
- 优化:**Git 工具回正文顶部常驻**——分支/拉取/推送/改动/提交一行窄条,抽屉从它下面整宽垂下,点工具条以外的地方自动收起;右侧 dock 只剩待办/目标。
- 优化:**侧栏观感对齐 Codex**——项目名与会话行同字重同色(不再半粗白字)、行高 32px、删掉组右侧计数;底部工具区图标统一 18px 列宽,各行文字左边严格对齐。
- 修复:**折叠组展开后内容挤在一起**——组内每块也走 12px 行距(实测 pitch 32px 与转录一致)。
- 优化:**后台/定时类工具中文化**——TaskStop/TaskList/TaskOutput/CronCreate/CronDelete/CronList/AskUserQuestion/CreateGoal/UpdateGoal 在单卡头部与集合摘要行显示中文名(如「停止后台任务」)。
- 优化:设置页说明文案与结构重整(SettingText,含摘要 API/翻译/快捷键页)。

### English

- Fold-as-you-output: only the current bar and the previous one stay expanded; older bars fold into the summary row immediately. Segments fold when narration text lands; everything folds at turn end.
- Turn-changes card now appears instantly at the bottom of the turn's output, computed from the turn's own Write/Edit tool inputs (the git snapshot pair could starve ~1 minute on large dirty repos, landing the card far too late).
- Git toolbar moved back to the top of the content area (branch/pull/push/changes/commit strip); drawers drop down full-width and auto-close when clicking elsewhere; the dock keeps only todos/goals.
- Sidebar matches Codex: project names use the same weight/color as session rows, 32px rows, group counts removed; tool-nav icons get a fixed 18px column so labels align exactly.
- Fixed expanded groups rendering blocks with no row spacing (12px rhythm inside groups, verified).
- Chinese labels for background/cron tools (TaskStop, TaskList, TaskOutput, CronCreate/Delete/List, AskUserQuestion, CreateGoal, UpdateGoal).
- Settings panels' copy and structure reworked (SettingText).

## v1.1.20 - 2026-08-18

### 中文

- 优化:**审核改动支持文件级深链**——改动胶囊/轮次改动卡里点具体文件,改动面板直接在顶部整宽打开并自动展开、滚动定位到该文件（此前只能整包打开再自己找）。
- 修复:**斜杠命令用显示名也能解析**——手打中文别名（如「压缩上下文」）同样识别成对应命令。
- 优化:**段完即折**——每段思考/命令执行完、输出文本一落地,上面的 bar 立刻折进集合行;正在生长的尾巴保持展开,轮末一律收齐（覆盖轮中"上翻不折"的决定）。
- 移除:**侧栏图标条模式整体下线**——头部只留一颗「隐藏侧边栏」按钮（换 VS Code 式面板图标）;Ctrl+B / Alt+W / Alt+Q 统一为隐藏/唤回;拖宽拖过最小值即隐藏（左缘悬停可浮出）。
- 优化:**设置信息架构与说明文案**——分类调整为「会话 / AI 功能 / 工具 / 快捷键 / 外观 / 系统 / 备份」,快捷键成为独立页面;说明统一改为面向用户的正式表达,并由完整的安全 Markdown renderer 渲染标题、列表、引用、表格、链接与代码。

### English

- File-level deep links for change review: clicking a file in the changes pill or turn-changes card opens the full-width changes panel at the top, auto-expanded and scrolled to that file.
- Slash commands now also resolve by display name (custom Chinese aliases work when typed).
- Segment-level folding: when a narration text lands, all activity bars above it fold into the summary row immediately; the growing tail stays visible; everything folds at turn end.
- Sidebar icon-rail mode removed: one hide/show button with a panel-style icon; Ctrl+B / Alt+W / Alt+Q all toggle hidden; dragging past the minimum width hides the sidebar.
- Settings information architecture and copy revised: categories are now Session / AI Features / Tools / Shortcuts / Appearance / System / Backup; Shortcuts has its own page, descriptions use user-facing language, and a safe full Markdown renderer handles headings, lists, blockquotes, tables, links, and code.

## v1.1.19 - 2026-08-18

### 中文

- 新增:**便携设置备份 v2**——命令别名随设置迁移;Provider/摘要/翻译/用量查询密钥可由用户逐类勾选,用备份密码经 scrypt + AES-256-GCM 加密后导出;默认不含敏感凭据,错误密码在写入前拒绝,导入后按目标电脑的 safeStorage 重新加密。旧版 v1 备份继续可导入。
- 新增:**完整历史回放**——绕开 kimi 的压缩回放,直接解析会话 wire.jsonl 重建全部轮次:被上下文压缩吃掉的老对话（压缩前的思考/命令/回复）全部能看到了;解析失败自动回退原回放。
- 修复:**斜杠命令选中后菜单不关、回车发不出**——富文本框在外部改值后光标停在旧偏移,刚选中的命令被重新识别成"正在输入",菜单关了又开、回车被吃掉;现在外部改值光标一律落末尾,选中即关菜单,回车直接发送。
- 修复:**命令别名改不了名**——window.prompt 在 Electron 不支持,改成应用内改名表单;历史误写的垃圾别名读取时自动忽略。
- 优化:**Skill 展示名就是可输入别名**——本机 27 个工程 Skill 与 6 个系统 Skill 全部补齐无空格、无冲突的中文名;列表显示「任务交接」即可直接输入 `/任务交接`,发送前仍还原为真实 `skill:handoff`。
- 修复:**点击轮次/会话里的具体文件直接定位 diff**——文件路径随顶部 Git 打开请求传递,ChangesPanel 加载后自动滚动并展开该文件;「审核」按钮仍打开全部改动。
- 修复:**新一轮开始后上一轮刚折好的 bar 又摊开**——live 闸门按"非历史"一刀切误伤上一轮,改成只盖当前轮。
- 优化:**活动行距 12px**（py-1.5,与 Codex 节奏一致,全列表统一）。
- 优化:**裸 URL 链接渲染成站点图标+短文本**——去协议头、超长中间省略,完整链接留悬停;顺带截断 autolink 误吞的全角括号（点开会 404）。
- 优化:**侧栏三段完全对齐 Codex**——主目录一律不算项目（其会话归「最近」,「最近」段标终于出现）;「项目」段标常显;当前项目名改紫黄流光（删除「当前」徽章）。
- 优化:**未收录工具也有图标+颜色**——ReadMediaFile 给图片图标归蓝色系,其余未知工具兜底扳手+中性灰微光;集合摘要行同步。
- 优化:导航条适配完整历史（6k 消息实测渲染/跳转/高亮正常）;悬停预览补上折叠轮的回复文本。

### English

- Portable settings backup v2: command aliases migrate with settings; opt-in per-category credential export (Provider/summary/translation/usage) encrypted with a passphrase via scrypt + AES-256-GCM; secrets excluded by default, wrong passwords rejected before writing, imports re-encrypt with the destination safeStorage. v1 backups still importable.
- Full history replay: parses the session wire.jsonl directly instead of kimi's compacted replay — turns swallowed by context compaction (thinking/tools/replies) are visible again; falls back to the old replay on parse failure.
- Fixed slash menu staying open and Enter not sending after picking a command (stale caret re-derived a slash context; external value changes now move the caret to the end).
- Fixed command aliasing being broken (window.prompt is unsupported in Electron; replaced with an in-app rename form; historical garbage aliases ignored on read).
- Skill display names are now invocation aliases: all 27 local engineering skills plus 6 system skills have unique, whitespace-free Chinese names; typing the displayed `/任务交接` resolves back to the canonical `skill:handoff` before sending.
- Clicking a specific file in a turn/session changes card now opens the top Git panel focused on that file, scrolls it into view, and expands its diff; the Review button still opens all changes.
- Fixed the previous turn's folded bars re-expanding when a new turn starts (the live gate now covers only the current turn).
- Activity row spacing now 12px (py-1.5), uniform across the transcript.
- Bare URLs render as site icon + shortened text; autolink no longer swallows trailing fullwidth punctuation (which led to 404s).
- Sidebar sections fully match Codex: home dir is never a project (its sessions go to 最近）, 项目 label always shows, current project name gets a violet shimmer instead of the 当前 badge.
- Unmapped tools get icons + colors (image icon for ReadMediaFile, wrench fallback with neutral shimmer for unknown tools).
- Navigation rail verified against full 6k-message histories; hover previews now include folded turns' reply text.

## v1.1.18 - 2026-08-17

### 中文

- 优化:**整轮活动轮末一次收齐**——同一轮的思考/命令（哪怕中间夹解说文字）收成一条集合摘要行,解说与回答原文保留原位;此前按「连续相邻≥2块」聚合,解说一断就只剩一梯子单独的小 bar。
- 优化:**思考体完整 markdown 渲染**——代码块（带语法高亮）/列表/标题都渲（块收尾后;流式期间保持纯文本）,译文落地即渲译文,翻译失败回退原文也照渲。
- 优化:**侧栏段标与缩进对齐 Codex**——「项目」段标常显（修复全是项目时一个段标都没有）;项目内会话行文字与项目名左边严格对齐（像素级实测）;置顶/最近段标样式统一,会话行字号统一 14px。
- 优化:**Git 抽屉回到正文上方整宽展开**——dock 只留按钮行,改动/提交/日志等抽屉在正文顶部整宽打开（360px 的 dock 里 diff 没法看）;待办/目标保持 dock 现状。
- 新增:**任务栏完成角标**（Codex 同款）——一轮答完且窗口不在前台时,任务栏图标右上角出数字小标并累加,切回前台自动消除（仅 Windows）。
- 修复:**图片预览加载不出来**——大图 data: URL 过长被 loadURL 拒载,改落临时文件再 loadFile,窗口关闭即删。
- 修复:**活动行间距时松时紧**——裸活动行 py-0.5/py-1.5 混排是根因,统一 py-1、卡片外边距 my-0,节奏全列表一致。
- 优化:翻译通道统一走「摘要/命名 API」;思考翻译只翻手动展开或整轮最终块（治一轮 N 段的翻译洪峰）;摘要 API 连续失败上报运行状态条;智谱 bigmodel.cn 入关思考白名单。
- 优化:悬停提示统一为应用内样式（不再是浏览器默认 tooltip）;待办点开自动展开;会话预览卡改 Codex 式（标题+时间/项目名/首条摘要）。

### English

- Whole-turn fold: all thinking/tool activity of a turn collapses into one summary row at turn end, even when narration text sits in between; narration and the final answer stay in place.
- Thinking bodies now render full markdown once finished (fenced code blocks with syntax highlighting, lists, headings); translations render when ready, and the original renders as-is if translation fails.
- Sidebar matches Codex: the「项目」section label always shows, session rows align exactly with the project name, section labels and 14px row font unified.
- Git drawers (changes/commit/log/...) open full-width at the top of the content area again instead of being squeezed into the 360px dock; todos/goals stay docked.
- New: Codex-style taskbar badge — a count chip appears on the taskbar icon when a turn finishes while the window is unfocused; cleared on focus (Windows only).
- Fixed image preview not loading (large data: URLs were rejected by loadURL; now written to a temp file and loaded via loadFile).
- Fixed inconsistent activity-row spacing (mixed py-0.5/py-1.5 rhythms unified to py-1/my-0).
- Translation all goes through the summary/naming API channel; thinking translation only fires on manual expand or the final block of a turn; repeated summary-API failures surface in the runtime status strip.
- Hover tooltips use in-app styling; the todo panel auto-expands; session preview cards redesigned Codex-style.

## v1.1.17 - 2026-08-17

### 中文

- 修复:**侧栏与正文交界线彻底消除**——真身是 glow-off 模式给侧栏和主区各套的 inset 1px 亮环,合体模式下整圈摘掉（像素级验证:#202020 直连 #181818）。
- 修复:**停靠面板里改动抽屉点不开**——面板挂在"点一下就关抽屉"的全局手势容器里,抽屉刚开就被秒关;面板内点击不再触发该手势。
- 优化:停靠面板左侧改圆角。

### English

- Junction line between sidebar and content finally gone (the inset 1px rings on both surfaces removed in merged mode; pixel-verified).
- Fixed the git drawer being instantly closed when clicked inside the dock panel.
- Dock panel corners rounded.

## v1.1.16 - 2026-08-17

### 中文

- 优化:**Codex 化全套**——色值按 Codex 桌面端拆包 + 截图像素采样对齐:侧栏 #202020 / 正文 #181818（侧栏比正文亮一档）、会话行 13px #c3c3c3、选中行 #313131 淡底无框;项目分组头只显示项目名（路径收进悬停提示）;组内导轨线删除。
- 优化:**顶栏两行并一行**——Git/待办/目标停靠图标并进窗口标题栏,正文上移一整行。
- 修复:**轮末不折叠**——折叠判定从"成组瞬间是否在底部"改为「轮刚结束一律折」,不再被跟随状态机的中间态卡成永久摊开。
- 优化:本轮计时动画（A+G）——数字流光扫过 + 底部一道紫光往返。
- 优化:MCP 工具行只显示叶名（全名收进悬停）,摘要行收敛为「使用 MCP 工具」,配插头图标。
- 优化:工具/思考行行距收紧（~10px → 1~2px）。

### English

- Full Codex alignment: sidebar #202020 / content #181818 (sidebar lighter, per pixel sampling of the real Codex app), 13px #c3c3c3 rows, #313131 active row; project groups show only the project name (path on hover); guide rail removed.
- Topbar merged into the window titlebar — one less chrome row.
- Fixed turns not folding at completion (fold-at-turn-end regardless of the at-bottom intermediate state).
- Timer animation: shimmer digits + a scanning light line underneath.
- MCP tools show the leaf name with a plug icon; summaries read「使用 MCP 工具」.
- Tighter activity row spacing.

## v1.1.15 - 2026-08-17

### 中文

- 优化:**侧栏与主区的分界线删除**（Codex 式）——只留侧栏比主区暗一档的明度台阶,不再画竖线;玻璃主题的 inset 亮边与右投阴影一并清掉。
- 优化:**会话标题显示长度恢复**——之前为悬停操作组预留的 pr-28 右内边距让标题七八个字就省略号;现在标题占满行宽,操作组悬停时以深色小底板浮在文字上方。

### English

- The sidebar/content divider line is gone (Codex-style brightness step only), including the glass theme's inset edge and cast shadow.
- Session titles use the full row width again — the pr-28 reservation for hover actions truncated them to ~8 chars; the action buttons now float over the text on a small dark chip.

## v1.1.14 - 2026-08-17

### 中文

- 新增:**右侧停靠面板（zcode/Codex 式布局）**——Git 工具、待办、目标收进右缘滑出的面板,顶栏收成右上角一排图标（有待办未完/目标进行中带紫点）。GoalCard 与待办卡不再常驻正文上方,正文独占全高。改动胶囊的「审核」自动打开 Git 页。
- 优化:本轮计时悬浮在**对话区左下角**（输出的左缘）,不占纵向空间,数字流光 + Bahnschrift。
- 优化:**翻译/命名/摘要通道统一**——全部只走「摘要 / 命名 API」,翻译页的引擎选择（运营商/百度）与思考块「未配百度」提示下线。
- 优化:图片附件点开改为**独立窗口**,不再占右侧详情面板（文本/目录预览不变）。
- 修复:**折叠两层语义**——单个命令卡完成照样收起;「多条命令收成摘要行」这一层等整轮输出完再折,不再中途折叠、收尾又展开。
- 优化:侧栏会话行悬停出操作按钮时,运行中圆点/环境徽标淡出避让,不再叠在一起。
- 修复:**思考翻译变慢的主因**——整轮展开让每段思考都触发一次翻译调用（洪峰排队）。现在只有手动展开的块和整轮最终块自动翻。
- 新增:摘要 API 连续网络失败（超时/断连 ≥3 次）上浮到状态条「摘要 API 连不上」——AI 命名/翻译悄悄不工作时一眼可见（此前静默回退）。
- 优化:改动口径标注——轮次卡「本轮编辑」与输入框上方「本会话已更改」分得清了。

### English

- New: **right-side dock panel (zcode/Codex-style)** — Git tools, todos and goal slide out from the right edge; the topbar is now just a row of icons (dots mark pending todos/active goals). GoalCard and the todo card no longer sit above the transcript; the chat owns the full height.「审核」opens the Git tab automatically.
- The turn timer floats at the bottom-left of the chat area — no vertical space taken, shimmering Bahnschrift digits.
- Translation/naming/summary all go through the single「摘要 / 命名 API」channel; the engine picker and baidu hints are gone.
- Image attachments open in a separate window instead of the right preview pane.
- Fixed the two-layer fold semantics: individual cards collapse when done; the multi-command summary fold waits for the whole turn.
- Sidebar running dot / backend badge fade out on hover so the action buttons no longer overlap.
- Fixed the thinking-translation slowdown: only explicitly opened blocks and the turn's final block auto-translate (no more per-turn translation flood).
- Consecutive summary-API network failures surface in the status strip ("摘要 API 连不上") instead of silently degrading naming/translation.
- Labels clarified: per-turn card「本轮编辑」vs the session-wide「本会话已更改」pill.

## v1.1.13 - 2026-08-14

### 中文

- 修复:**上下文窗口恒「暂无数据」**。kimi 0.36 的 /usage 输出格式变了——`Context: 504527 / 1048576 tokens (48%)`(数字和百分比之间多了 "tokens" 一词;Total 行变成 `Session total: N input, M output` 语序也不同),旧正则永不命中。解析器兼容两种格式,实测 48% / 805M 输入正常显示。

### English

- Fixed: the context-window ring stuck at "no data". kimi 0.36 changed the /usage output (`Context: 504527 / 1048576 tokens (48%)` — a "tokens" word the old regex didn't expect, and a reordered Session-total line). The parser now accepts both formats; verified live (48%, 805M input).

## v1.1.12 - 2026-08-14

### 中文

- 修复:**删除当前会话"删不掉"**——磁盘删除成功,但 kimi 的 query-store 缓存还把这条会话吐给 session/list,一刷新就复活(kimi 要自己加载失败才清缓存,所以你"进入一下那个对话"它就没了)。现在删除成功即记墓碑(deleted-sessions.json),侧栏列表一律过滤;同时丢弃历史查询客户端的冻结快照。
- 优化:**删除失败不再静默**——失败弹模态框给具体原因(原先只有输入框上方一行小字);批量删除有失败也弹。
- 优化:**运行中工具卡的紫色描边光圈删除**(紫底一并去掉),运行信号只留文字:「运行中」挪到工具名后面,秒数挂流光。
- 优化:本轮计时从对话区顶部挪到**左侧栏底部**(工具区上方),不占对话区纵向空间,数字带流光。

### English

- Fixed: **deleting the current session "didn't stick".** The files were deleted, but kimi's query-store cache kept returning the session in session/list, so it resurrected on refresh (kimi only prunes the cache after a failed load — which is why opening the conversation made it vanish). Deletions now record a tombstone (deleted-sessions.json) that the sidebar always filters, and the frozen history-client snapshot is dropped.
- Delete failures now surface as a modal with the reason instead of a tiny status line; batch failures too.
- The running tool card's purple ring/background is gone;「运行中 + elapsed」moved next to the tool name with a shimmer on the seconds.
- Turn timer moved from the top of the chat to the bottom of the left sidebar — no vertical space taken, digits shimmer.

## v1.1.11 - 2026-08-14

### 中文

- 修复:**归档页删除失败**——KIMI_CODE_HOME 重定向之前创建的会话存在旧的默认 home（~/.kimi-code）里,session/list 两个 home 都列,删除却只查新 home → 永远找不到。现在当前 home 找不到自动回退旧 home 删;两个 home 都没有按「已删除」成功返回(归档页的幽灵条目才能清掉)。
- 优化:**当前会话选中行减重**——不再套实底 + 亮边的重框,只垫一层淡底,选中信号由左侧紫色指示条表达。
- 优化:**本轮计时挪到对话区顶部**——钉住不随转录滚动、贴左缘,数字换 Bahnschrift 窄体;思考块标题行不再挂计时。
- 优化:**折叠节奏修正**——turn 运行中,本轮的思考/工具块全部保持展开,不再"新块一开始就把前一个折掉、输出完又展开";整轮输出完才一次性折成摘要行。中途手动折/展过的块仍以你的选择为准。

### English

- Fixed: **archived sessions failing to delete.** Sessions created before the KIMI_CODE_HOME redirect live in the legacy home (~/.kimi-code); session/list enumerates both homes but deletion only checked the new one. Deletion now falls back to the legacy home, and a session absent from both counts as deleted (so ghost archive entries can be cleared).
- The active sidebar row loses its heavy filled frame — just a light wash plus the existing accent bar.
- The turn timer moved to a pinned, left-aligned strip above the transcript (Bahnschrift digits); thinking-block titles no longer carry it.
- Fold rhythm fixed: during a running turn all of its thinking/tool blocks stay expanded; everything folds into the summary row once, when the turn completes. Manual toggles still win.

## v1.1.10 - 2026-08-14

### 中文

- 新增:**侧栏项目优先分组**——属于已添加项目的会话只出现在「项目」分组里,不再占「最近」;「最近」只收无项目会话(按时间倒序全量列)。同一项目按归一化路径归并(正反斜杠拼写不再拆成两组)。
- 新增:项目组头加文件夹图标、字色提亮,悬停出行内「+」——**直接在该项目下新建对话**。
- 新增:项目切换器加「**不在项目中工作**」入口(Codex 同款)——会话落在用户主目录,不占用项目位;cwd 不在项目列表时切换器直显「无项目」。
- 优化:**skill 胶囊对齐 Codex**——立方体线框图标 + 浅蓝文字裸排版(去掉紫底药丸);手敲命令命中即时成胶囊(原先只有菜单选中才变),删字失效自动退回纯文本。
- 优化:思考块、跨消息活动组的开合接入高度动画 + 淡入淡出,收起不再瞬时消失(懒挂载,没展开过的历史块不白渲染)。
- 优化:**工具失败/被拒改行首小红 ✗**,行尾「出错/已拒绝」文字删除;待办卡、Swarm 卡、系统消息行残余的 ▸/▾ 展开字形一并清掉。
- 优化:TodoList 工具行补清单图标(摘要行「更新待办」同享)。
- 优化:**Bash/terminal 卡片重做**——命令盒淡底 + 长命令换行(原生横向滚动条没了);kimi 的 terminal 工具也走高亮命令盒(原先错落成「输入」JSON 明细盒);命令输出改纯文本块(原先错套 DiffView,硬解析出「+0 -0」「统一/拆分」)。
- 优化:「后台命令」chip 与浮层**只数真后台任务**(run_in_background)——原先数的是本会话全部 shell 调用总账,还随历史加载窗口摆动。注意:重开的老会话显示 0,因为 kimi 的 ACP 历史回放本身不含后台调用(实测,非计数 bug)。
- 优化:整条只有思考/工具块的「裸活动行」行距收紧(折叠成摘要块之前不再稀稀拉拉);输入框上下留白收紧,正文多出约 20px。
- 修复:**切换对话不再丢排队消息**——切走时队列随快照进后台缓冲,后台每收尾一个 turn 同步弹队,切回时剩余队列原样恢复。
- 优化:**改动胶囊按会话过滤**——只算本对话造成的改动(各轮 TurnChangesCard 并集),这个对话一行没改就整枚隐藏;不再把工作区里别人的改动挂上来。已知边界:重开的老会话没有轮次卡片,只计新产生的改动。

### English

- New: **project-first sidebar.** Sessions belonging to an added project only appear under their project group; 「最近」 now lists only project-less sessions. Same-project groups merge across path spellings (slash/case).
- New: project group headers get a folder icon, brighter text, and a hover「+」to start a chat directly in that project.
- New: **"work without a project"** entry in the switcher (Codex-style) — the session runs in the home directory without occupying a project slot.
- Skill chips now match Codex: cube outline icon + light-blue text, no pill; hand-typed commands chip the moment they resolve, and revert when they stop matching.
- Thinking blocks and activity groups expand/collapse with a height animation (lazy-mounted bodies).
- Failed/denied tools show a small red ✗ at the row start instead of trailing status text; leftover ▸/▾ glyphs removed from todo/swarm/system rows.
- TodoList rows get a checklist icon.
- Bash/terminal cards reworked: light command box with wrapping (no horizontal scrollbar), kimi's `terminal` tool uses the highlighted command box too, and command output renders as plain text instead of a misparsed diff view.
- The「后台命令」chip and popover now count only real background tasks (run_in_background) instead of every shell call in the session. Reopened sessions show 0 because kimi's ACP replay omits background calls entirely (verified, not a counting bug).
- Tighter spacing for bare activity rows (thinking/tool-only messages) and around the composer.
- Fixed: **queued messages no longer vanish when switching sessions** — the queue rides along in the background snapshot and is restored on re-attach.
- The changes pill is now session-scoped: hidden when this conversation changed nothing, and counts only files this conversation touched.

## v1.1.9 - 2026-08-13

### 中文

- 新增:**发送后等待提示**——消息发出到首个输出之前，对话底部出现「✦ 正在思考…」（火花图标 + 紫黄流光）；思考块一开始流式就自动接棒消失。
- 优化:思考块轻量渲染补样式（之前渲染了但没挂 prose-forge 容器,加粗等行内样式不可见）;思考翻译回收尾统一翻（边输出边翻会卡,撤了）。
- 优化:工具行工具名与摘要行同色系微光（patch 编辑紫 / read_file 天青 / Bash 琥珀 / 搜索蓝 / Skill 紫红）。
- 修复:favicon 走本机代理 127.0.0.1:7897（探测通才挂,localhost 直连不受影响）——GitHub 等被墙站点的图标终于能取到,检查更新顺带也走代理了。

### English

- New: a "正在思考…" waiting indicator (sparkle + shimmer) between sending and the first output, handing off to the thinking block's own shimmer.
- Thinking blocks' light markdown now actually shows bold etc. (missing prose-forge wrapper); thinking translation reverted to after-completion only.
- Tool names get the same per-action shimmer hues as the summary segments.
- Favicons (and update checks) now go through the local proxy 127.0.0.1:7897 when reachable — GitHub icons finally load.

## v1.0.98 - 2026-08-13

### 中文

- 新增:**命令胶囊**。在 `/` 面板里选中一条后端命令后,它会从输入框文本里"提"出来变成一枚胶囊(图标 + 名称 + 原名 + ×),输入框只留参数;发送时自动拼回。只挂胶囊不写参数也能直接发(`/status` 这类不需要参数)。
- 新增:**命令别名,可自己改**。Kimi 只给命令的原名和一整句英文描述,没有任何"显示名"——所以 Tran 自己补了一层:内置命令给了一套默认中文名(压缩上下文 / 会话状态 / Token 用量…),`skill:` 前缀在列表里剥掉,原名降级成旁边的灰色小字(仍看得到、仍可搜)。每条命令右侧有「改名」,按后端保存,留空恢复默认。

### English

- New: **command chips.** Picking a backend command from the `/` palette lifts it out of the input text into a chip (icon + name + raw name + ×); the textarea keeps only the arguments and they are recombined on send. A chip alone can be sent (for commands like `/status` that take no arguments).
- New: **editable command aliases.** Kimi exposes only a raw name and a full-sentence English description — no display name — so Tran adds one: built-in commands ship with Chinese names, the `skill:` prefix is dropped in the list, and the raw name is demoted to dim text beside it. Each command has a rename action, stored per backend.

## v1.0.97 - 2026-08-13

### 中文

- 修复:**新建对话时 `/` 面板一条后端命令都没有**。Kimi 的会话是懒启动的——你发出第一条消息之前后端根本没起来,所以开局按 `/` 必然只剩几个自带模板。而这些命令其实是装机级别的属性(不会因会话而变),现在按后端缓存下来,开局立刻可用,真会话起来后照常覆盖。
- 修复:**`/` 面板下方一条黑影**。面板抬高让开 chip 行之后,下面露出的空白区被 34px 的浓投影盖住,看着像框底挂了道黑边。投影收敛。

### English

- Fixed: **the `/` palette had no backend commands in a fresh chat.** Kimi's session is created lazily — the backend doesn't start until you send the first message, so opening `/` before that showed only the built-in templates. The command list is an install-level property, so it's now cached per backend and shown immediately, then refreshed once the real session reports.
- Fixed: **a black smear under the `/` palette** — after raising the panel clear of the chip row, its heavy 34px drop shadow fell on empty space. Toned down.

## v1.0.96 - 2026-08-13

### 中文

- 新增:**Claude Code 后端进程意外退出时,对话流里给出提示**。此前进程死了界面上一个字都没有,正文停在半截输出上,分不清是还在想还是已经死了(Kimi 那边一直是有断线卡片的)。提示同时说明「再发一条消息即可自动重开并接着上下文」——这条路本来就通,只是没人告诉你。
- 修复:**`/` 面板里后端下发的命令一律被标成「Kimi」**。在 Claude Code 会话里,19 条 Claude 的命令全打着 Kimi 的徽标。改成跟着当前后端走。

### English

- New: **the transcript now says so when the Claude Code process dies unexpectedly.** Previously nothing appeared at all — the output just stopped mid-stream with no way to tell "still thinking" from "dead" (Kimi has always shown a disconnect card). The notice also points out that sending another message re-opens the session with context intact.
- Fixed: **backend-provided commands in the `/` palette were always badged "Kimi"**, including the 19 Claude commands in a Claude Code session.

## v1.0.94 - 2026-08-13

### 中文

- 修复:**后端重连之后 `/` 命令列表全空**。Kimi 崩溃/重启会换一个新的 ACP 会话 id,但 Tran 的桥接 id 不变,而补拉命令的兜底只盯着桥接 id ——于是永远不会重跑,40 个命令一个都回不来,面板里只剩几个自带模板。
- 修复:**待办轮询会对着一个已经不存在的会话无限重试**。kimi 返回 `40401 session not found` 时旧代码与"网络暂时不通"一视同仁,于是每 10 秒重试一次、永远不停(日志里刷了几百条)。现在这类致命错误单独识别,确认一次就不再问。
- 改版:**`/` 快捷命令面板**底色改成与面板同色(原来是近乎纯黑压在炭灰界面上,像挖了个洞),并且不再盖住上方的「后台命令 / 子 Agent / 上下文环」那一行。
- 改版:**去掉输入框上方那条「AI 正在输出中(00:18),已排队 N 条」**。计时并进正文里正在流的那一行标题;排队条数在上方队列卡片里本来就有。只保留真正需要你动手的提示:等待授权/回答,以及疑似卡住。

### English

- Fixed: **the `/` command list came back empty after the backend reconnected.** A Kimi crash/restart yields a new ACP session id while Tran's bridge id stays the same, and the fallback that re-fetches commands only watched the bridge id — so it never re-ran.
- Fixed: **the todo poller retried a non-existent session forever.** `40401 session not found` was treated like a transient network error, so it retried every 10s indefinitely. That fatal case is now recognised and the poller stops.
- Redesign: the **`/` palette** now uses the panel background colour (it was near-black on a charcoal UI) and no longer covers the status chip row above the composer.
- Redesign: **removed the "AI is generating (00:18), N queued" strip** above the composer. The timer moved into the streaming header in the transcript; the queue count already exists on the queue card. Only prompts that need you to act remain (permission/question, and the stall notice).

## v1.0.93 - 2026-08-13

后台把 Tran 当普通用户跑了一轮（Kimi + Claude Code 各走完整流程),抓到三个真机才暴露的问题。

### 中文

- 修复:**点导航条永远跳到底部**——也就是「点了跟没点一样」的真正原因。react-virtuoso 这两处用的不是同一套下标:`rangeChanged` 上报**绝对**下标(含 firstItemIndex 基数),`scrollToIndex` 收的却是**相对**下标。两边都按绝对算,传进去的是百万级数字,被一律 clamp 到末项。这个 bug 从导航条第一版就在,静态看代码看不出来。
- 修复:**Claude Code 会话一打开就整片 Transcript 崩溃**(v1.0.91 引入)。导航条摘要要取该轮回复的开头,而流式期间 `blocks` 数组会有空洞,少了一次判空——整个转录区被 React 错误边界接管,只剩「渲染出错」。
- 修复:**Claude Code 的权限档位接反了**。选「自动通过」这个中间档,实际拿到的是 Claude 最危险的 `bypassPermissions`(连权限询问都一并绕开);而标着「慎用」的「完全自主」反倒是更保守的 `acceptEdits`。现已对齐:自动通过 → acceptEdits,完全自主 → bypassPermissions。

### English

- Fixed: **clicking the nav rail always jumped to the bottom** — the real reason clicks felt dead. react-virtuoso reports *absolute* indices in `rangeChanged` but expects *relative* ones in `scrollToIndex`; passing the absolute index meant a million-scale number that got clamped to the last item. Present since the rail's first version.
- Fixed: **the whole Transcript crashed on opening a Claude Code session** (introduced in v1.0.91) — the rail's reply preview read `blocks` without the null-guard the rest of the file uses, and streamed content can leave holes in that array.
- Fixed: **Claude Code's permission tiers were inverted.** Picking "自动通过" (the middle tier) actually got you Claude's most permissive `bypassPermissions`, while the tier labelled "慎用" got the safer `acceptEdits`.

## v1.0.92 - 2026-08-13

### 中文

- 修复:**Kimi 与 Claude Code 的会话混在一列里**。v1.0.88 把两家历史合并排序是个设计错误——用 Kimi 的时候冒出一堆 Claude Code 的对话(反之亦然),既看不懂也点不进去。现在侧栏只列当前 Agent 后端的会话,切后端时列表跟着切。
- 修复:**消息导航条点了不跳转**(v1.0.91 引入)。拖动用的指针捕获挂在了外层滚动列上,而指针捕获会把随后的点击一并重定向给捕获元素,按钮自己的点击事件就永远不触发了。改为挂在按下的那一节上(与 Codex 原实现一致)。
- 修复:**长会话里旧消息在导航条上点不到**。条目原先只留最近 30 条,聊到上百轮之后前面的全都不见了。现在不再截断,刻度列自己滚动,并且会自动把你正在看的那一段滚进视野。

### English

- Fixed: **Kimi and Claude Code sessions were interleaved in one list.** Merging both histories (v1.0.88) was a design mistake — Claude Code conversations showed up while using Kimi and vice versa, and opening one would silently switch engines. The sidebar now lists only the active agent backend's sessions.
- Fixed: **clicking the message nav rail didn't jump** (introduced in v1.0.91). The scrub pointer-capture was attached to the scrolling list, and pointer capture retargets the following click to the capture element, so the tick's own click never fired. It now captures on the pressed tick, matching Codex's implementation.
- Fixed: **older messages were unreachable on the rail in long conversations** — it kept only the most recent 30. The cap is gone; the rail scrolls itself and keeps the span you're reading in view.

## v1.0.91 - 2026-08-13

### 中文

- 改版:**消息导航条完全重写,照搬 Codex 的实现**(方向镜像到右侧)。
  - **命中区放大**:每一节是 10×36px 的透明带,刻度只是里面一根 26px×2px 的线。之前命中区就是那根线本身,要求精准戳中十来个像素。
  - **悬停是一条涟漪**:当前节满格,相邻 70%、次邻 40%、再次 20%——不再是单节硬邦邦地弹一下。刻度靠 `scaleX` 变长而不改布局宽度,所以动画不抖。
  - **可以按住拖着刷**:按下沿刻度上下拖动即可连续预览/跳转,拖动中即时跟手。这个能力此前完全没有。
  - **高亮的是视口内的一整段**:一屏看得到三条消息就亮三格,不再只亮一格。
  - **悬停卡片**改为「你说的那句话 + 这一轮 AI 回复前三行」的 320px 卡片——只看自己说过什么其实认不出是哪一轮。
  - **跳转后目标气泡闪一下**紫色光晕,长回合里一眼看清落点。

### English

- Redesign: **the message nav rail is a faithful port of Codex's implementation** (mirrored to the right edge).
  - **Bigger hit targets**: each row is a 10×36px transparent band; the tick is just a 26×2px line inside it. Previously the tick *was* the hit target.
  - **Hover ripples across neighbours** (100% / 70% / 40% / 20%) instead of one tick popping. Ticks grow via `scaleX` without changing layout width, so nothing jitters.
  - **Press and drag to scrub** the rail for continuous preview/jump — entirely new.
  - **The whole visible span highlights**, not a single tick.
  - **Hover card** now shows your message plus the first three lines of that turn's reply.
  - **The target bubble flashes** after a jump so you can see where you landed.

## v1.0.90 - 2026-08-13

### 中文

- 修复:**Claude Code 会话的上下文环虚高 5 倍**。窗口此前写死 200k,而实测 Claude Code 的窗口是 1m——33.3k 的占用被画成 17%,实际只有 3%。现改用 Claude Code 自己的 `/context` 命令取权威值(占用、窗口上限、真实模型名一并拿到)。这条命令不走 API、不花钱(实测 `num_turns=0`、`cost=0`),所以每轮结束自动刷一次,不必等你悬停上下文环。整轮对界面不可见:不进对话流、不闪「正在运行」。

### English

- Fixed: **the context ring read ~5× too full in Claude Code sessions.** The window was hardcoded to 200k, but Claude Code's actual window here is 1m — 33.3k of usage was drawn as 17% when it was really 3%. Tran now asks Claude Code's own `/context` command for the authoritative numbers (usage, window size, and the real model name). That command makes no API call and costs nothing (`num_turns=0`, `cost=0`), so it refreshes after every turn instead of waiting for a hover. The hidden turn is invisible in the UI — no transcript entry, no "running" flicker.

## v1.0.89 - 2026-08-13

### 中文

- 修复:**消息导航条点了不跳转**。命中区原先只有那根 3px 高、10px 宽的横线,而整条列又正好压在滚动条上——点下去多半打在滚动条上。现在每一节是一条 40px 宽的透明命中带,整条列往里让开滚动条。
- 修复:**悬停不出摘要**。摘要标签是往左浮出到刻度列外面的,而外层容器带着 `overflow-hidden`,标签一直被裁掉——功能其实在,只是永远看不见。
- 改进:导航条**节距收紧**(14px → 9px),不再那么稀疏。
- 修复:**默认模型冷启动就忘**。此前只有「当前会话的模型」这一处状态:会话内切换记得住、新建对话也沿用,但关掉 Tran 再开就掉回默认,每次都要重新选。现在按 Agent 后端各记一个上次用过的模型。

### English

- Fixed: **clicking the message nav rail didn't jump.** The hit target was just the 3px×10px tick, and the rail sat right on top of the scrollbar. Each tick now has a 40px-wide transparent hit band, and the rail is inset clear of the scrollbar.
- Fixed: **hovering showed no summary.** The label floats out to the left of the rail, but the container had `overflow-hidden` clipping it away — the feature worked, it was just never visible.
- Improved: tighter rail spacing (14px → 9px pitch).
- Fixed: **the default model was forgotten on restart.** Model choice lived only on the current session, so it survived model switches and new chats but reset every time Tran reopened. It's now remembered per agent backend.

## v1.0.88 - 2026-08-12

### 中文

- 新增:**Claude Code 的历史会话进侧栏了**。此前 Tran 只读 Kimi 的历史,Claude Code 会话完全不进列表——关掉 Tran 那段对话就再也找不回来(恢复的能力一直都在,只是没有入口)。现在两家历史合并后按时间排,项目分组、置顶、重命名、搜索一视同仁。
- 修复:**点开 Claude Code 历史会话是空白的**。`claude --resume` 只恢复上下文、不重放消息;现改为自己读回会话记录(实测 12MB 的会话 75ms 读完,最多回放最近 400 条)。
- 修复:**恢复会话时用错后端**。此前取的是当前会话的后端,两家历史混排后,拿 Kimi 去恢复一条 Claude Code 会话必然失败;现在由会话条目自己决定。
- 修复:**Claude Code 会话中途换模型无效**。模型此前只在启动进程时用一次,下拉里换了不起作用;现走控制协议热切,当轮即生效。
- 修复:**删不掉 Claude Code 会话**。删除只走 Kimi 的存储路径,对 Claude 的会话表面成功、刷新那一行又回来了。

### English

- New: **Claude Code sessions now appear in the sidebar.** Tran only read Kimi's history before, so Claude Code conversations never made the list — closing Tran lost them (resume worked all along; there was just no entry point). Both histories are merged and sorted by time, with the same grouping, pinning, renaming and search.
- Fixed: **opening a Claude Code session showed a blank transcript** — `claude --resume` restores context without replaying messages, so Tran now reads the session log itself (12MB session in 75ms, last 400 messages).
- Fixed: **resuming used the wrong backend** (the current session's instead of the target session's), which could never work once both histories were listed together.
- Fixed: **switching models mid-session did nothing** for Claude Code; it now hot-swaps over the control protocol.
- Fixed: **deleting a Claude Code session silently failed** and the row came back on refresh.

## v1.0.87 - 2026-08-12

### 中文

- 修复:**浏览器控制 / 桌面控制的开关对 Claude Code 会话不生效**。两个开关原先只写 Kimi 的 `mcp.json`,在 Claude Code 会话里工具根本不装载——但开关看上去是开着的。现在同时调 Claude Code 自己的 `claude mcp add/remove --scope user`,一个开关管两个后端。没装 Claude Code 时静默跳过,不影响开关本身。
- 修复:**Claude Code 会话里图片附件被丢弃**。发送时结构化内容被拍平成纯文本、只留文字块,图片直接消失。现已原样透传。
- 改进:**Claude Code 的技能与 MCP 面板不再是空的**,改为展示该会话真实装载的技能列表与 MCP 服务器连接状态(增删改仍走 `claude mcp` 命令,Tran 只做展示)。
- 改版:**侧栏底部工具区融进侧栏**。去掉那圈卡片外框(玻璃主题下线后它在实色侧栏里只是个突兀的浮起矩形),改为默认收起、鼠标移到底部浮出、点标题可钉住;选中项也不再描边,只用底色区分。

### English

- Fixed: **the browser/desktop control toggles did nothing in Claude Code sessions** — they only wrote Kimi's `mcp.json`, so the tools never loaded, while the switch looked enabled. They now also call `claude mcp add/remove --scope user`, so one switch covers both backends (silently skipped when Claude Code isn't installed).
- Fixed: **image attachments were dropped in Claude Code sessions** (structured content was flattened to text). They now pass through unchanged.
- Improved: the Skills and MCP panels for Claude Code show the session's real skills and MCP server status instead of an empty list.
- Redesign: the sidebar's footer tool section now blends into the sidebar — no card frame, collapsed by default, revealed on hover, click the header to pin it open.

## v1.0.86 - 2026-08-12

### 中文

- 修复:**Claude Code 后端此前根本跑不动**。适配器排队等 `system/init` 才发用户消息,而 CLI 要先收到输入才吐 `init`——两边互等,一条消息都发不出去。现在直接写入,实测一问一答正常。
- 修复:**Claude Code 会话里所有要授权的工具一律被拒**。`--print` 模式不给 `--permission-prompt-tool` 就无处询问,`Write` 直接失败并回「权限未授予」。现已接通控制协议:CLI 的 `can_use_tool` 冒到 Tran 的权限弹窗,裁决回传给 CLI;「本次会话都允许」之类的建议项一并透传。权限模式(默认/自动/YOLO)支持热切,不必重开会话。
- 修复:**Claude Code 里点停止等于杀会话**。改走控制协议的优雅中断;进程真没了的话,下次发消息带 `--resume` 悄悄重启,上下文接着走。
- 修复:Claude Code 会话的上下文环长期显示接近 0——用量只算了 `input+output`,没算缓存命中(实测一轮 `input=2` 而 `cache_read=55294`)。
- 新增:**输入框上方的「N 个文件已更改 +X -Y」悬浮胶囊**(Codex 同款)。显示当前工作区相对 HEAD 的总账,悬停展开文件列表,点击进改动面板;工作区干净时自动消失。与轮内汇总卡的分工是流水 vs 余额。
- 修复:**分屏控制的隔离漏在键盘上**。`desktop_click` / `desktop_focus_window` 都判了越界,`desktop_type` / `desktop_key` 没判——键入一律打给前台窗口,你在自己那块屏上随手点一下换了前台,字就敲进你正在用的窗口里。现在键入前会现查前台窗口在哪块屏。
- 修复:显示器列表永久缓存,插拔扩展坞/改缩放之后越界判定还按旧坐标算;设置页每次打开都把「分屏控制」画成「不限制」(已选的那块屏没回读);桌面控制关掉后光晕仍被锁在之前选的那块屏上。
- 修复:AI 控制光晕的三处失效——切换分屏目标后光晕永久哑火;首次工具调用常撞上遮罩页面加载中而丢失(单次调用等于完全没提示);显示器插拔后遮罩留在旧坐标。
- 修复:每轮改动快照原是全局单槽,同时挂多个会话时互相冲掉基线,汇总卡会把别的会话的改动算到自己头上。
- 修复:`desktop_type` 的工具描述还写着「剪贴板粘贴、会自动恢复剪贴板」,而实现早已换成 SendInput 直接注入 Unicode。

### English

- Fixed: **the Claude Code backend never worked.** It queued user messages until `system/init`, but the CLI emits `init` only after receiving input — a deadlock. Also, without `--permission-prompt-tool` every permission-gated tool was auto-denied in `--print` mode; the control protocol is now wired end to end (`can_use_tool` → Tran's permission modal → `control_response`), including suggestions and live permission-mode switching. Stop no longer kills the session (graceful interrupt, then lazy `--resume`), and usage now counts cache tokens so the context ring is accurate.
- New: **a floating "N files changed +X -Y" pill above the composer** (Codex-style) showing the working tree against HEAD; hover for the file list, click to open the changes panel.
- Fixed: **split-screen isolation leaked through the keyboard** — `desktop_type`/`desktop_key` had no bounds check, so text landed in whatever window you had just focused on your own monitor. Plus a stale display cache, the selected display not being read back into settings, and the overlay staying locked to that display after desktop control was turned off.
- Fixed: three ways the AI-control glow could silently stop showing (after switching the split-screen target, on the first tool call while the overlay page was still loading, and after a monitor was plugged/unplugged).
- Fixed: per-turn change snapshots were a single global slot, so concurrent sessions overwrote each other's baseline.

## v1.0.85 - 2026-08-12

### 中文

- 修复:**混合 DPI 下桌面控制的坐标与截图错乱**。此前桌面控制进程只声明「系统 DPI 感知」,在主屏 200%、副屏 100% 这类混合缩放环境里,Windows 会把所有显示器按主屏缩放虚拟化——副屏被报成 3840×2160（实际 1920×1080）、截图被 2 倍上采样糊掉、点击坐标与截图不同源。现改用 PerMonitorV2,各屏一律真实物理像素、截图 1:1。
- 改进:显示器列表现在给出**物理分辨率 + 缩放百分比**（如 `3120×2080 · 200%`),不再显示缩放后的逻辑尺寸;`desktop_list_displays` 同步返回每屏 `dpi` / `scalePercent`。

### English

- Fixed: **desktop control was mis-mapping coordinates and blurring screenshots under mixed DPI.** The helper only declared system-DPI awareness, so with a 200% primary and a 100% secondary, Windows virtualized every monitor at the primary's scale — the secondary was reported as 3840×2160 (really 1920×1080) and its screenshots were 2x-upscaled. It now uses PerMonitorV2: true physical pixels everywhere, 1:1 screenshots.
- Improved: the display list shows physical resolution plus scale (`3120×2080 · 200%`) instead of the scaled logical size; `desktop_list_displays` returns per-monitor `dpi`/`scalePercent`.

## v1.0.84 - 2026-08-12

### 中文

- 新增:**Claude Code 后端**。设置 → 会话 → Agent 后端可切到 Claude Code,与 Kimi 并存;自动探测可执行文件,权限确认、工具流、会话恢复走同一套 UI。
- 新增:**AI 控制屏幕光晕**。AI 操作浏览器/桌面时屏幕边缘浮出渐变紫光晕 + 「AI 控制中」标识,停歇后自动淡出;全程点击穿透,不挡任何操作。
- 新增:**桌面控制分屏隔离**。可把一块显示器划给 AI——截图只截那块屏,点击/聚焦越界直接拒绝,你在另一块屏上继续干活互不干扰。
- 新增:**每轮文件改动汇总卡**。一轮结束后在对话流里给出「已编辑 N 个文件 +X -Y」,可整轮撤销、可打开改动面板审核。统计走 git 工作区前后快照差,经 shell 改的文件同样算得到。
- 改版:**Codex 同款炭灰实色主题**,玻璃拟态与深黑皮肤全部移除;侧栏默认展开、一律显示全部会话、重排为 置顶 → 最近 → 项目 三段;消息导航条改为悬停单节高亮 + 摘要浮出。
- 改版:**设置页分五类**（会话/插件/外观/系统/备份）,说明支持 Markdown,文案整体重写。
- 修复:低分辨率屏与高分辨率屏图标不一致——ICO 里 ≤48px 的档原本是另一套简化设计（无留白、无质感）,现在全部从 256px 正稿等比重生成。

### English

- New: **Claude Code backend** (switchable alongside Kimi), **AI-control screen glow** (click-through purple vignette while the AI drives), **per-display desktop isolation** (hand one monitor to the AI; out-of-bounds clicks are refused), and a **per-turn file-changes card** ("edited N files +X -Y", revert or review) computed from git snapshots so shell-made edits count too.
- Redesign: Codex-style charcoal theme (glass/onyx skins removed), sidebar always expanded showing all sessions in Pinned → Recent → Projects, Codex-style message rail, and a five-category settings page with Markdown descriptions.
- Fixed: the app icon differed between low- and high-DPI displays — the ≤48px entries in the ICO were a separate simplified design; all sizes are now regenerated from the 256px master.

## v1.0.83 - 2026-08-12

### 中文

- 新增:**浏览器/桌面控制做成可开关插件**（设置页两张卡片,即时生效,kimi 重开会话装载/卸载工具）。浏览器控制默认开;桌面控制默认关、带醒目警示。
- 新增:**桌面控制（Codex 式 computer-use,实验性）**。开启后 kimi 获得 7 个 `desktop_*` 工具:全屏截图、窗口枚举/聚焦、UIA 控件树读取（带中心坐标,可不看图直接点）、鼠标点击、文本输入（SendInput Unicode 直接注入,绕过中文输入法组词与剪贴板同步软件干扰）、组合键。无需任何外部组件。
- 改版:**Codex 风侧栏**。启动一律展开;不再分「当前项目/全部」,一律跨项目全部会话;列表重排为 置顶 → 最近 → 项目（按项目折叠分组,带「当前」徽标）三段。行悬停操作、运行标识、悬停预览、多选、AI 命名、Ctrl+K 搜索全部保留。

### English

- New: **browser/desktop control as toggleable plugins** (two cards in Settings; toggling registers/unregisters the MCP servers instantly, kimi picks it up on next session). Browser control defaults on; desktop control defaults off with a prominent warning.
- New: **desktop control (Codex-style computer use, experimental)** — seven `desktop_*` tools: full-screen capture, window enumeration/focus, UIA control-tree reading (with center coordinates for text-first clicking), mouse clicks, text typing via SendInput Unicode injection (immune to CJK IME composition and clipboard-sync tools), and key combos. No external components required.
- Redesign: **Codex-style sidebar** — always expanded on launch; no more per-project/all toggle (always all sessions); list restructured into Pinned → Recent → Projects (collapsible per-project groups with a "current" badge). Hover actions, running indicators, preview cards, multi-select, AI naming, and Ctrl+K search all preserved.

## v1.0.82 - 2026-08-12

### 中文

- 修复:**浏览器控制 click/type 完全不可用**——chrome.scripting 的参数里 undefined 不可序列化(真机测试抓到),缺省参数改传 null(扩展 v0.3.3,需在 chrome://extensions 重载一次)。
- 修复(扫描收尾,清空 #63-#66 全部剩余项):
  - 归档存档文件损坏时不再静默假成功,归档页横幅提示;搜索面板打开归档会话自动取消归档。
  - 桥:被替换的僵尸扩展连接不再喂活探活;read_page 元素列表纳入长度预算;粘新配对码立即生效。
  - 主进程:网络图片改流式限量下载(谎报 content-length 防不住的内存路径关闭);plan 文件路径归一防 `..` 逃逸;诊断报告日志段脱敏。
  - 会话:桥进程异常退出时未确认消息回收进待发队列(不再静默丢失),台账死条目不再滞留;AgentSwarm 卡片流式期间即时显示任务;超长会话消息时间戳不再消失。

### English

- Fixed: **browser-control click/type were entirely broken** — `undefined` in chrome.scripting args is unserializable (caught in live testing); optional params now pass null (extension v0.3.3, reload once in chrome://extensions).
- Scan wrap-up (closes all remaining items of #63-#66): archive corruption no longer fakes success (banner shown) and search-palette opens auto-unarchive; bridge ignores zombie-connection heartbeats, read_page element list respects the length budget, re-pairing takes effect immediately; network images stream with a hard size cap, plan-file paths are resolved against `..` escapes, diagnostic log section is redacted; messages unacknowledged when the bridge dies are recycled into the pending queue instead of vanishing, swarm cards render during streaming, and long-session timestamps no longer disappear.

## v1.0.81 - 2026-08-11

### 中文

- 新增:**浏览器控制（Chrome 扩展路线）**。kimi 现在能操作你日常在用、登录态齐全的真实 Chrome:列标签页、开/切/关标签页、导航、读页面（正文 + 可交互元素 ref 编号）、点击、输入（可回车提交）、截图。
  - 一次性配对:「设置 → 浏览器控制」里复制配对码 → chrome://extensions 开发者模式「加载已解压的扩展程序」选 Tran 安装目录的 `resources/browser-extension` → 扩展选项里粘贴。之后重启/升级全自动重连。
  - 安全:桥只听 127.0.0.1,握手必须带配对 token;所有连接方（扩展与 MCP server）在交 token 前都先要求服务端出示绑定端口的 HMAC 身份证明,挡掉占端口的本地进程骗取配对码与中继攻击;read_page 不回传密码/信用卡/验证码类输入的值。
  - 实现:MV3 扩展 ↔ Tran 内置 WebSocket 桥 ↔ stdio MCP server(启动时自动注册进 kimi 的 mcp.json,九个 `browser_*` 工具)。
  - 升级提示:扩展代码更新后需在 chrome://extensions 点刷新重载,UI 会在版本落后时提醒。
- 开发:dev 实例支持 `TRAN_USER_DATA_DIR` 重定向 userData,可与正式版并行运行。
- 修复（第三轮全面扫描，主进程/渲染层/归档）:
  - 归档批量删除失败时不再摘除归档标记（此前用户确认「永久删除」的会话会因删除失败反而回到侧栏）;列表未加载成功时不再把归档会话误判「已不存在」。
  - AskUserQuestion 点选答案后 1.2s 内切走会话,答案不再丢失（修复 turn 永久卡死）。
  - 新会话首条消息 init 到达时不再清空刚加的附件。
  - 会话搜索/会话重命名/项目重命名/新建分支四处补输入法组词 Enter 守卫,中文确认候选词不再误触发。
  - 退出时同步 kill 主 ACP 进程,不再泄漏约 300MB 常驻进程;文本附件加体积上限,防大文件 OOM。
  - MCP 面板连接中轮询不再因一次失败永久卡住;会话列表刷新失败不再变未处理 rejection;Git diff 切文件竞态不再跳回旧文件。

### English

- New: **browser control (Chrome extension route)**. kimi can now drive your real, logged-in Chrome: list/open/activate/close tabs, navigate, read pages (text + interactive elements with ref ids), click, type (with Enter submit), and screenshot.
  - One-time pairing: copy the pairing code from Settings → Browser Control, load `resources/browser-extension` as an unpacked extension, paste the code in its options. Reconnects survive restarts and upgrades.
  - Security: the bridge listens on 127.0.0.1 only and requires the pairing token; on port drift the extension demands an HMAC proof from the server before revealing the token.
  - Plumbing: MV3 extension ↔ built-in WebSocket bridge ↔ stdio MCP server (auto-registered into kimi's mcp.json, nine `browser_*` tools).
  - After updating the extension code, reload it in chrome://extensions; the UI warns when the connected version is outdated.
- Dev: `TRAN_USER_DATA_DIR` redirects userData so a dev instance can run beside the installed app.
- Fixes (third full scan — main/renderer/archive): archive bulk-delete no longer un-archives sessions whose delete failed (they used to reappear in the sidebar after a confirmed "permanent delete"), and the archive page no longer mislabels sessions as "gone" when the list failed to load; AskUserQuestion answers are no longer lost if you switch sessions within 1.2s of answering (fixes a stuck turn); attachments added during a new session's init window are no longer wiped; IME composition Enter guards added to session search / session rename / project rename / new branch; the main ACP process is now killed synchronously on quit (no more ~300MB leak) and text attachments have a size cap; MCP panel polling no longer stalls permanently on one failure, session-list refresh failures no longer become unhandled rejections, and Git diff no longer races back to a previously selected file.

## v1.0.80 - 2026-08-11

### 中文

- 新增:**会话归档**。侧栏会话行新增 📥 归档按钮——从列表收起但数据原地不动；左侧「工具 → 归档」页里能找回（点标题恢复并打开）、多选批量恢复或彻底删除（真删走原有删除链路，不可恢复，有二次确认）。侧栏单行删除保留。
- 修复:下拉展开面板宽度被触发器压扁（选项挤成一列单字）——触发器保持自适应,展开面板按内容撑开（上限 17rem）。

### English

- New: session archiving. A 📥 button on each sidebar session row hides it without touching data; the new Archive page (tools nav) restores, or multi-selects for permanent deletion (with confirmation). Single-row delete stays.
- Fixed: opened dropdown panels were squeezed to the trigger's width (options collapsed to single characters); panels now size to content (capped at 17rem) while triggers stay content-sized.

## v1.0.79 - 2026-08-11
## v1.0.79 - 2026-08-11

### 中文

- 优化:工具行状态最终定稿——完成态什么都不显示（成功是默认态，满屏绿勾纯噪声），只有运行中/失败/被拒出文字。
- 优化:工具组折叠卡也裸掉（与单行工具同一语言），完成态同样不显示标记。
- 新增:思考块标题带火花图标 + 灰紫微光（流式中仍是紫黄流光）。
- 修复:行内路径 chip 的紫色换成正常锌色。
- 修复:输入框三个下拉（权限/effort/模型）宽度随内容自适应，不再空一截。

### English

- Tool rows finalized: success shows nothing at all (only running/failed/denied print text); group fold cards are frameless too; thinking headers get a sparkle icon + muted shimmer; path chips no longer purple; composer selects size to content.

## v1.0.78 - 2026-08-07
## v1.0.78 - 2026-08-07

### 中文

- 优化:工具行减负——状态圆点删除（与右侧状态重复）;"✓ 完成"全文改成只留一枚小勾（运行中/失败仍显示文字）;摘要与工具名重复时（Skill/TodoList）不再显示两遍。
- 新增:Skill 调用带图标（Codex 提取集的扳手）+ 摘要行「使用 Skill」标签。

### English

- Tool rows decluttered: status dot removed (duplicated the right-hand state); "done" is now a bare ✓ (running/failed keep text); summaries identical to the tool name (Skill/TodoList) no longer print twice.
- New: Skill calls get the Codex-extracted wrench icon and a proper summary label.

## v1.0.77 - 2026-08-07
## v1.0.77 - 2026-08-11

### 中文

第二轮全面扫描（渲染层 12 处 + 主进程 10 处，全部逐条验证后修复）：

**安全**
- 修复:更新器安装包文件名路径穿越——URL 里编码的 `%5C`/`..` 解码后能把下载写到目录之外,而下载终点会被 shell.openPath 执行。现在解码后的文件名必须是纯文件名。
- 修复:MCP 服务器名零校验(空名/`__proto__` 原型键会污染对象或静默丢失)。

**流式性能(卡顿治理)**
- 思考块/译文的逐行 markdown 渲染改为按行 memo——原先流式期间父级每帧重渲染,200 行思考块就是 200 次完整 remark 管线重解析;现在只有正在变的最后一行重解析。
- 行内 code/链接节点不再每个都挂 store 订阅(长会话成百上千个订阅者,每帧全跑一遍 selector);点击时现取。
- 消息时间戳的 store 订阅加引用短路(原先任意 store 更新都全量遍历 items)。
- 会话悬停预览卡状态下沉为独立组件——悬停/移开不再整列表重渲染几百行。
- GitToolbar 每次渲染深克隆 git 缓存 → 惰性初始化只克隆一次。

**修复**
- 中文乱码:git 输出按 chunk 转字符串,中文路径/内容跨 chunk 边界必出 U+FFFD——改用流式解码。
- DeepSeek 余额查询的超时只盖到响应头,body 停滞会让余额永远"加载中"直到重启。
- 会话删除的大目录同步删除会把主进程冻住几秒 → 改异步;图片"另存为"/诊断报告导出同理。
- 图片右键"复制/另存"的网络图片分支无超时无大小上限(渲染层可传任意 URL)→ 补 20s 超时 + 20MB 上限。
- kimi 路径探测全部失败时的裸 'kimi' 兜底被永久缓存——装好 kimi 后仍持续 ENOENT 直到重启。
- 设置保存失败静默(未捕获 rejection + 按钮复位装作成功)→ 顶部错误横幅;侧栏 AI 命名同理。
- 会话悬停预览的慢请求竞态(快速掠过多行时旧内容覆盖新行、移开后预览又弹回)。
- 思考翻译状态的刷新竞态(保存设置后旧请求晚返回覆盖新状态)。
- 用量卡钉住后重置倒计时永远冻结 → 低频 tick 驱动。
- 代码块复制按钮的定时器在卸载后触发 + 泄漏。
- 已发送图片记录超限清空导致重复落盘错位。
- kimi 历史连接对反向请求的应答用错连接代(建连中静默不回/换代后错发)。
- gpu 偏好直写主设置文件非原子(崩溃截断)→ 原子写。

### English

Second full sweep (12 renderer + 10 main-process findings, all verified and fixed): update-installer filename path traversal; per-line markdown re-parsing during streaming (now memoized per line); per-node store subscriptions removed; hover-preview state extracted (no more full-list re-renders); git output mojibake on chunk boundaries; DeepSeek balance stuck loading forever on stalled body; sync deletes/writes freezing the main process (now async); un-capped network image fetch; cached 'kimi' fallback path; silent settings-save failures; several request races (session preview, translate status); frozen usage-card countdown; copy-button timer leak; sent-image duplicate recording; wrong-generation ACP responses; non-atomic settings write in gpuBackend; MCP server name validation.

## v1.0.76 - 2026-08-11

### 中文

- 变更:**思考翻译/描述翻译默认走摘要旁路的便宜模型**(如火山引擎方舟),不再依赖百度。百度通道保留,但加了熔断:欠费(54004)、未授权(52003)、签名错(54001)、服务关闭(58002)这类不会自愈的错误触发后,本次运行内不再发起百度请求——此前欠费时思考翻译的重试能把日志刷成每秒上百条。限频(54003)只熔断 60 秒。熔断期间思考翻译自动落到 LLM 通道(配了摘要 key 就不会失去翻译);保存翻译设置会重置熔断。
- 修复:连发多条直达消息时回显去重只对比最近一条,先发的那条会被再插一份(转录出现双份消息)。
- 修复:后台会话 turn 出错时,未确认的直达消息只出账不回收——现在回收进缓冲,切回会话时落回排队区,可一键重发。
- 修复:恢复会话加载失败(session/load 报错)后,排队中的消息还会向已结束的会话再发一份错误、并对失败的会话发隐藏 /usage 轮。
- 修复:ACP 进程崩溃的恢复退避期间,点"停止"/切模型/切权限档会为一条对新进程毫无意义的请求拉起整个 kimi 进程(~300MB)、绕过退避窗口。
- 修复:附件选择器 IPC 失败时的未捕获 promise rejection(现在显示错误提示)。

### English

- Changed: thinking/description translation defaults to the cheap summary-API model (e.g. Volcengine Ark) instead of Baidu. Baidu channel remains but now has a circuit breaker: non-self-healing errors (arrears 54004, unauthorized 52003, bad signature 54001, service closed 58002) trip it for the rest of the run — previously an out-of-quota Baidu key caused a retry storm flooding the log. Rate limiting (54003) cools down for 60s. While tripped, thinking translation falls back to the LLM channel; saving translate settings resets the breaker.
- Fixed: echo dedup only compared the most recent user message, duplicating earlier messages when several direct sends were in flight.
- Fixed: unacked direct messages are now recycled into the queue when a background session's turn errors (previously silently dropped from the ledger).
- Fixed: after a failed session/load, queued messages no longer emit an extra error into the ended session or trigger a hidden /usage turn against the dead ACP session.
- Fixed: stop/model/permission changes during ACP crash-recovery backoff no longer spawn a fresh kimi process just to send a no-op request.
- Fixed: unhandled rejection when the attachment picker IPC fails (now surfaces an error hint).

## v1.0.75 - 2026-08-11

### 中文

- 新增:**Skill/斜杠命令专属卡片**(对齐 Codex 的 Handoff 卡)。以 `/命令` 开头且命中 kimi 可用命令列表的消息不再是普通气泡,而是渐变卡片:闪电图标 + 等宽命令名 + Skill 徽章 + 参数正文 + 命令描述副标题。实机验证 `/status` 全流程。
- 修复:**斜杠菜单回车补全后再按回车发不出去**——补全用 rAF 设光标,可能跑在 React 提交新值之前,`select` 事件读到旧值把菜单带着陈旧上下文重新打开,下一个回车变成二次补全。改为布局副作用中设光标(保证在新值落进 DOM 之后)。另外零匹配时回车不再被空菜单吞掉,会关掉菜单照常发送。
- 修复:**主进程崩溃隐患**——Windows 上 `taskkill` 进程树清理未挂 `error` 监听,spawn 失败(杀软拦截/PATH 异常)是异步事件,`try/catch` 抓不到,会直接掀掉整个主进程。两处(ACP 关闭、kimi web 关闭)都已修。
- 修复:会话重建(改模型/配置后发消息)期间切走会话,消息会被发进**切到的那个会话**、且它的状态被旧会话覆盖——现在检测到切走后,消息折进原会话的后台缓冲并仍送达原桥接,当前会话状态一字不动;重建失败路径同样不再覆盖当前会话的 meta。
- 修复:懒起会话("+新建对话"后第一条消息)期间切走,消息静默被吞(转录里躺着一条从未送达的消息)——现在照常送达原会话。
- 修复:桥接进程死亡(agent:ended)时流式残留不封口——光标块永远闪、悬挂工具卡永远转圈;现在走与正常回合收尾相同的封口。
- 修复:关会话瞬间到达的工具审批请求成为"无主弹窗"(kimi 侧永远等不到应答)——现在如实回 cancelled(与 AskUserQuestion 分支对齐)。
- 修复:唤醒轮流式输出中途用户发新消息,两轮内容会并成一条 assistant 消息——真实轮接管时先封口 steered 流式消息。
- 修复:待办自动催更的三处失灵——已收尾任务无 30 分钟新鲜度窗口(重启后老任务重新触发)、催更配额在静置窗口内被取消时照样扣掉(那批任务永远不会再催)、去重键用了会话重建后会变的桥接 id。
- 修复:多张 Swarm 卡互串——每张卡按任务描述匹配出自己那批子代理,不再显示全会话任务并集。
- 优化:wire 回放的磁盘扫描节流(长静默期从每秒一次降到 5 秒一次)、kimi server 探测加 10 秒 TTL(原先有任务在跑时每 2 秒全量发现+HTTP 探测)、wire 路径解析失败不再永久禁用回放(原先首扫恰逢杀软占目录就整个会话失效)。

### English

- Added: dedicated Skill/slash-command cards (Codex Handoff style) — messages starting with a known `/command` render as a gradient card with icon, monospace command name, Skill badge, args body, and description subtitle.
- Fixed: pressing Enter after slash-menu completion re-completed instead of sending (caret was set via rAF racing React's value commit; now set in a layout effect). Enter with zero menu matches no longer gets swallowed.
- Fixed: potential main-process crash — `taskkill` tree-kill spawns had no 'error' listener; an async spawn failure would take down Electron. Both call sites fixed.
- Fixed: switching sessions during a bridge rebuild or lazy start no longer sends your message into the wrong session, clobbers the foreground session's state, or silently drops the message — it's folded into the original session's background buffer and still delivered.
- Fixed: streaming residue is now sealed when the bridge dies (agent:ended); orphaned permission requests arriving while a session closes are answered with cancelled; a real turn taking over mid-steered-stream no longer merges two turns into one message.
- Fixed: todo auto-nudge freshness window, quota accounting on cancel, and dedup key; Swarm cards no longer show the union of all session subagents.
- Perf: throttled wire-replay disk scans, 10s TTL on kimi server probing, and wire path resolution failures are no longer memoized forever.

## v1.0.74 - 2026-08-10

### 中文

- 修复:**自动唤醒轮真正显示出来了**。v1.0.72 的方案建立在"唤醒内容会从 ACP 推过来"的假设上——实测直连 `kimi acp` 对照验证:后台任务完成后 kimi 内部确实自动唤醒并跑完了整轮(wire.jsonl 全程可见),但 **ACP stdio 对这一轮零推送**(45 秒监听一个字节都没有),所以界面上永远什么都不会出现。现在 Tran 在回合结束且还有后台任务在跑时,直接增量读会话的 wire.jsonl,把唤醒轮的思考、工具卡(含结果)和正文经正常流式管道回放进对话——后台命令、非阻塞子代理、待办更新三条路都实机验证过:运行指示点亮、工具卡完整、结尾定稿、待办卡自动刷新勾选。
- 真实轮开始时回放即停(该轮内容由 ACP 正常推送,不会双写);会话恢复时若有上次遗留的后台任务也会自动挂表接住唤醒。

### English

- Fixed: steered wake-up turns are now actually rendered. A controlled probe against `kimi acp` proved the v1.0.72 assumption wrong — kimi completes the wake-up turn internally (fully visible in wire.jsonl) but pushes zero ACP updates for it. Tran now tails the session's wire.jsonl while background tasks are running and replays the steered turn (thinking, tool cards with results, text) through the normal streaming pipeline. Verified end-to-end for background commands, non-blocking subagents, and todo updates.
- The replay stops the moment a real client turn starts (no double-rendering), and re-arms on session resume when tasks from a previous run are still going.

## v1.0.73 - 2026-08-07

### 中文

- 新增:侧栏双档定稿——**Alt+Q 完全隐藏、Alt+W 缩小成图标条**（Ctrl+B 保留）；默认启动即收起为图标条；**完全隐藏时鼠标悬停窗口左缘浮出完整侧栏**（10px 隐形触发带，移开自动收回）。
- 重做:用户消息导航条回到右缘，保留 Codex 小横线样式（当前节更亮更长，hover 出摘要）。
- 优化:工具卡彻底裸排版——淡底也去了，纯"圆点+图标+文字"，运行中才留一丝紫色底；卡片/思考块间距定档 3px。
- 优化:折叠箭头换 12px V 形图标 + 旋转过渡（继承 v1.0.71）。

### English

- Sidebar dual mode finalized: Alt+Q hides completely, Alt+W collapses to the icon rail (Ctrl+B kept); starts collapsed by default; hovering the window's left edge while hidden reveals the full sidebar as an overlay.
- The user-message navigator moved back to the right edge, keeping the Codex dash style.
- Tool cards are now fully naked (no fill at all; only a whisper of violet while running); spacing settled at 3px; fold chevrons carried over from v1.0.71.

## v1.0.72 - 2026-08-07

### 中文

- 新增:**AI 自动唤醒可见化**。实证发现 kimi 在后台任务/子代理完成时会自动注入通知并让主代理接续干活(全历史 91 例零例外)——但这一轮之前在 Tran 里"三无":不显示运行中、流式态不封口、待办不补拉。现在自动唤醒轮会点亮运行指示,静默收尾时封口并补拉待办真值。
- 修复:**唤醒内容被隐藏轮吞掉**——kimi 的完成通知会注入当时活跃的 turn,若恰逢 Tran 的隐藏查询轮(/usage、/mcp),整段唤醒内容会消失("跑完了也没反应"的真凶)。现在后台任务运行期间不再开隐藏轮。
- 优化:待办自动催更降级为兜底(kimi 自己会唤醒),有任务在跑时不再触发;待办卡横幅文案随之修正。
- 优化:思考块流式性能——折叠预览正则只在收起态计算且只取前 400 字、跟随滚动改 rAF 合帧、便宜摘要 hook 去掉每帧的无效状态更新(边思考边翻译的卡顿来源)。

### English

- New: agent self-wake made visible. kimi auto-resumes the main agent when background tasks/subagents finish (91/91 in wire logs); Tran now lights the running indicator for these steered turns, seals streaming state on quiescence, and re-pulls todos.
- Fixed: wake-up turns being swallowed by hidden query turns (/usage, /mcp) — hidden turns are now skipped while background tasks are running.
- Changed: the todo auto-nudge is demoted to a fallback; thinking-block streaming got cheaper per frame (bounded preview regex, rAF-batched follow scroll, no-op state updates skipped).

## v1.0.71 - 2026-08-07

### 中文

- 优化:思考块与折叠摘要行前面的折叠箭头，从文本字形（▸/▾，又小又糊）换成 12px V 形图标，收起时旋转 -90° 带过渡。

### English

- Changed: fold indicators in thinking blocks and activity summaries are now a 12px chevron with a rotate transition, replacing the tiny text glyphs.

## v1.0.70 - 2026-08-07

### 中文

- 重做:**贴底跟随 / 「回到最新」按钮状态机**。v1.0.69 的「误现修复」有三处误伤,全在输出中暴露:
  - 输出中点开思考/工具卡会被强行拽回底部(补滚不看"用户已主动解除跟随")——现在只有仍处于钉住态才补滚,展开阅读时视图钉在原地;
  - 输出中上一个块自动收起时,浏览器钳制 scrollTop 被误判成"用户上滚",跟随莫名断掉——现在判"上滚"必须有真实输入佐证(滚轮/指针/触摸),纯内容收缩不算;
  - 贴底点一下折叠,「最新」按钮凭空出现——按钮显示与钉住状态解耦,只看视口是否真的离开了底部。
  另外补滚现在尊重跟随锁:点击选中文本的瞬间不再被拽走。

### English

- Reworked: the stick-to-bottom / "back to latest" state machine. The v1.0.69 fix had three regressions, all during streaming: expanding a card yanked you back to the bottom (compensation scroll now respects an explicit un-pin), auto-collapsing blocks were misread as user scroll-ups killing follow (a scroll-up now requires real input evidence), and clicking a bar at the bottom made the button appear (button visibility is now decoupled from the pin state and follows actual viewport geometry). Compensation scrolling also honors the follow lock, so click-to-select no longer drags the view.

## v1.0.69 - 2026-08-07

### 中文

- 新增:**侧栏「隐藏/缩小」双档**（Codex 风）。缩小 = 收成图标条（Ctrl+B）；隐藏 = 连图标条都不留（Alt+Q，或侧栏头部的隐藏按钮），主区铺满，隐藏时标题栏左侧留一个迷你唤回按钮。
- 重做:用户消息导航条改 Codex 同款——对话区**左缘**一列小横线（每条消息一节，当前节更亮更长），无框无底；hover 才浮出摘要列表。原来右侧的圆角条下线。
- 修复:**「回到最新」按钮误现**——在底部时展开思考/工具卡，内容增高被误判成"用户上滚"。现在按 scrollTop 方向区分：只有真的向上滚才解除跟随。
- 修复:输入框聚焦紫边的真正元凶——全局 `textarea:focus-visible` 紫色 outline（键盘聚焦才触发，之前的测试没模拟到）。输入框已豁免，CDP 实测消除。
- 新增:markdown 代码块带头部的卡片——语言标签在左、「复制」按钮在右（点了一下进剪贴板）。
- 新增:思考块正文轻量渲染（流式期保持纯文本保性能，收尾后渲染加粗/行内代码/链接）；**思考翻译边输出边翻**——展开时先翻当前快照，收尾自动补翻全文。
- 优化:摘要行动词去「了」（读取文件/运行命令…）；思考块与工具卡间距微调到 3px 档；工具卡去框试验——不再套卡片盒，裸排版 + 展开区左侧发丝引导线。
- 修复:CJK 加粗解析（「是**X**，」这种组合 CommonMark 不认，`**` 原样漏出）；链接 Codex 化——蓝色无下划线 + 站点 favicon（直连站点取图标，失败回退小箭头）。

### English

- New: sidebar hide/collapse as two distinct levels (Codex-style): collapse to the icon rail (Ctrl+B) or hide entirely (Alt+Q / header button) with a mini restore button in the titlebar.
- Reworked: the user-message navigator is now Codex's left-edge dash strip — no frame, hover reveals summaries.
- Fixed: the "back to latest" button appearing when cards expand at the bottom (scroll-direction now distinguishes real scroll-ups from content growth); the composer's purple focus ring root cause (a global `textarea:focus-visible` outline) is exempted for the composer.
- New: code blocks get a header card (language label + copy button); thinking blocks get light inline rendering after streaming, and thinking translation starts from the expand-time snapshot while streaming, re-translating in full when the stream ends.
- Tweaks: summary verbs dropped the trailing 了; bar spacing tuned; tool cards go frameless (experiment); CJK bold parsing fixed; links are Codex-blue with per-site favicons.

## v1.0.68 - 2026-08-07

### 中文

- 重做:输入框工具栏去框化（Codex 风浑然一体）。权限/effort/模型三个下拉收起时无边无底（裸文本+图标，点开照常浮出面板）；附件、停止、模板按钮去边框;发送按钮改成圆形箭头钮——有内容时浅色实底黑箭头,空时幽灵灰,不再是紫色长条。

### English

- Reworked: the composer toolbar is now frameless (Codex-style). The permission/effort/model selects render as naked text+icon until opened; attach/stop/template buttons lost their boxes; send is a circular arrow button — solid light with a dark arrow when there's content, ghost gray when empty.

## v1.0.67 - 2026-08-07

### 中文

- 修复:**peek 浮层半透明**（正文透上来像没压层）——浮层改实底。顺带挖出一个值得记录的坑：生产构建里 `@layer` 会被 esbuild 展平，"无层胜过层内"的保护在打包后不存在，纯拼选择器优先级；相关规则已按真实级联修正。实底后图标条不再需要隐形切换，衔接不再跳。
- 新增:摘要行「思考 N 段」也带图标（火花）+ 灰紫收敛微光，与动作段同款但更淡。
- 新增:待办卡与正文之间加分隔（间距 + 发丝线）。
- 隐藏:系统消息卡（后台任务通知/cron 触发）不再渲染——完成状态由后台命令 chip 和待办横幅表达，对话流只留人说的话。
- 优化:思考块与工具卡、卡与卡之间的间距收紧（my-1 → my-0.5，思考块 py-1 → py-0.5），不挤但更不松散。

### English

- Fixed: the peek overlay was translucent (content bleeding through) — it's now opaque. Notable root cause: production builds flatten `@layer` via esbuild, so "unlayered beats layered" assumptions silently break after packaging; affected rules were re-written for the real cascade. With the opaque overlay the rail no longer needs the invisible swap, so the handoff is seamless.
- New: the "思考 N 段" summary segment gets a sparkle icon and a muted violet shimmer, matching but quieter than the action segments.
- New: a divider (spacing + hairline) between the todo card and the conversation.
- Hidden: system-message cards (background-task notifications / cron) no longer render — completion is surfaced by the task chip and the todo banner; the conversation keeps only human words.
- Tightened spacing between thinking blocks and tool cards (my-1 → my-0.5, thinking padding py-1 → py-0.5).

## v1.0.66 - 2026-08-06

### 中文

- 修复:**peek 浮出时「工具」区是空盒子**——上版强制展开只开了容器，条目还按收起态渲染成透明。现在浮出时条目正常显示。
- 修复:peek 浮层被 Git 顶栏压住——z-index 60 → 120。
- 修复:**图标条中段悬停不触发浮出**。真凶是整条图标条被设成了窗口拖拽区（`-webkit-app-region: drag`），拖拽区吞掉真实鼠标的悬停事件,只有按钮（no-drag）能触发——正好对应"只有上面和下面能用"。图标条已移出拖拽区。
- 修复:peek 消失太突兀——加退场动画（淡出 + 轻左滑 170ms）。
- 重做:「回到最新」按钮——干净圆钮 + 居中箭头（上次把流光套 SVG 上渲成了残圈）；输出中按钮外圈挂缓慢扩散的紫色脉冲环,动态感在外圈、箭头永远干净。
- 重做:折叠活动摘要行——每段带 Codex 原版小图标 + 自己的淡色微光（读文件天青/编辑紫/命令琥珀/搜索蓝/子代理紫红/待办绿），慢速低对比扫过;"·"分隔点删除,靠间距自然分开。
- 修复:系统消息卡不再只有"系统消息"四个字——从通知正文挖真实标题（如"打包发布 v1.0.64 ✓ 完成"）。
- 优化:输入框聚焦的紫色描边（三层叠加还带呼吸）全撤——改成中性提亮 + 底缘一线极淡 accent,聚焦是个状态不该一直招手。

### English

- Fixed: peek showed an empty tools box (container opened, items stayed invisible); peek z-index raised above the Git topbar; the rail's dead hover zone was caused by the whole rail being a window drag region (drags swallow real-mouse hover) — the rail is no longer a drag region; peek now fades/slides out instead of vanishing.
- Reworked: the "back to latest" button is a clean circle with a centered chevron, and while streaming it gets a slow pulsing ring instead of the broken gradient text.
- Reworked: collapsed activity summary segments carry Codex's original icons plus a faint per-action shimmer (read/edit/bash/web/agent/todo each get their own muted hue); dot separators removed.
- Fixed: system-message cards now surface the real title from the notification body instead of a bare "系统消息".
- Changed: the composer's purple focus ring (three stacked layers, breathing) replaced by a neutral brighten plus a whisper of accent at the bottom edge.

## v1.0.65 - 2026-08-06

### 中文

- 新增:**摘要请求的「开启模型思考」开关（默认关）**。这些任务是 12~16 字的短摘要,推理帮不上忙却极烧额度——实测同一条命令说明,开思考多花 **762 个推理 token**,关掉是 **0**,两边答案质量一样。免费额度按 token 算(推理 token 也算),差 700 倍。只有当某个模型不推理就答不准时才需要打开。
- 新增:**摘要 API 故障提示**。这条链路的失败策略一向是静默回退(命令说明缺失就显示原命令),因为它们都是"有则更好"。但那个设计有盲区:**额度耗尽 / Key 失效**属于不会自愈的故障,静默下去就是"功能悄悄停了",用户完全无从察觉。现在这两类会在运行状态条上显示,点击直达「AI 辅助」页;限流不算(会自愈,退避重试兜得住),同类问题 10 分钟内只提示一次。
- 支持火山方舟:关思考的字段现在也发给 `volces.com`。方舟是聚合平台(豆包/DeepSeek/GLM 都在上面),同一域名后面挂什么模型取决于接入点,所以按整个域名放行而不是逐个模型判断。
- 清理:移除智谱 GLM-4.7-Flash 的预设与相关文案。限流退避逻辑**保留**——它不是某家专属,任何服务在突发并发下都可能 429,只是把厂商专属错误码换成了通用匹配。
- 修复:用量卡判断"是不是 DeepSeek"时读的是旧的 `summaryApiBaseUrl` 字段,而多套配置上线后真正生效的是激活的那一条,两者可能不一致。

### English

- New: **"enable model thinking" toggle for summary requests (off by default).** These are 12–16 character summaries where reasoning doesn't help but burns quota — measured on one command explanation: thinking cost **762 extra reasoning tokens** versus **0** with it off, for answers of identical quality. Free-tier quotas count reasoning tokens too, so the difference is ~700x. Only turn it on if a given model can't answer accurately without it.
- New: **summary-API failure surfacing.** This path has always failed silently by design (a missing command note just shows the raw command) because these features are nice-to-have. That design has a blind spot: **quota exhaustion and invalid credentials don't self-heal**, so silence means the feature just quietly stops working with no way to notice. Those two now appear in the runtime status strip and click through to the AI Assist page. Rate limiting is excluded (it self-heals via backoff), and each issue type is reported at most once per 10 minutes.
- Volcengine Ark support: the disable-thinking field is now sent to `volces.com` as well. Ark is an aggregator (Doubao, DeepSeek and GLM all live behind it) where the model depends on the endpoint, so the whole domain is allow-listed rather than individual models.
- Cleanup: removed the Zhipu GLM-4.7-Flash preset and related copy. The rate-limit backoff **stays** — it isn't vendor-specific; any provider can return 429 under burst concurrency. Vendor-specific error codes were replaced with generic matching.
- Fix: the usage card decided "is this DeepSeek?" from the legacy `summaryApiBaseUrl` field, which can disagree with the profile that is actually active now that multiple profiles are supported.

## v1.0.64 - 2026-08-06

### 中文

- 新增:**会话搜索命令面板**（Codex 同款）。侧栏常驻搜索框撤掉，「最近会话」行改为 🔍 图标；点开或按 Ctrl+K 弹出居中搜索面板：实时过滤会话（标题/路径/分支），↑↓ 选择、Enter 进入、Esc 关闭，底部带「新对话」推荐。
- 修复:**侧栏收起态三宗罪**（CDP 实测定位）：①浮出后分界竖线不消失——元凶是主区面板的一圈 inset 描边，图标条隐形后它还立着，收起态下不再画；②peek 浮出时「工具」区强制展开，不再跟随展开态的收起状态；③图标条的新建对话按钮去紫改中性。
- 修复:悬停触发区实测全轨可达（此前怀疑只有部分位置可触发，CDP 事件链实测整条图标条都行）。
- 修复:「回到最新」按钮——挪到底部居中（Codex 位）；输出中箭头挂流光、静态时素箭头；**点它不再吃跟随锁**（此前按钮自己触发"停留阅读"锁，流式期间怎么点都差一截到不了底）。
- 修复:活动自动折叠不再顶飞阅读位置——折叠改成 sticky 决策，只有当你在底部时才折新收尾的活动组；上翻阅读期间布局绝不变。
- 修复:思考翻译「不可用」轻提示替代永远转圈；云端额度关闭时额度环显示「—」不再弹"读取失败"红框。
- 优化:会话列表单行化——时间不再占第二行（悬停显示），标题单行放满整行宽度,行高收紧一屏多看几条。
- 优化:活动摘要行（思考 N 段 · 运行了命令 ×3…）改成浅底药丸，与真思考块一眼区分；工具名全部中文（read_file/terminal 这类 wire 原始名不再外露）。
- 优化:用量卡额度行去掉「24/100 剩余 76」数字（进度条+百分比已表达），倒计时靠左、具体到期时刻靠右错开;「5 小时 额度」标题缝隙消除。
- 优化:项目下拉去掉逐行 stagger 动画（动画期间截断宽度反复变化，看着像内容一直在变）。
- 优化:品牌去重——标题栏的 Tran 标志移除，全窗口只留侧栏一处并带常静流光。
- 优化:MCP 状态行与顶部运行状态条（● Windows / Agent Kimi CLI x.y.z）下线,空间还给正文。
- 智谱免费档耐心加长:限流退避从 ~22s 放到 ~76s（6 轮，单轮封顶 30s）——"慢一点排队我愿意"。

### English

- New: Codex-style session search palette — the permanent sidebar search box is gone; a 🔍 icon (or Ctrl+K) opens a centered palette with live filtering, keyboard navigation, and a "new chat" suggestion.
- Fixed: collapsed-sidebar trio (verified via CDP): the stray divider line that survived peeking (the main surface's inset ring — no longer painted when collapsed); peek now force-expands the tools section; the rail's new-chat button is no longer purple.
- Fixed: the "back to latest" button — now bottom-centered, animated while streaming, and no longer eats its own follow-lock (previously it could never reach the true bottom during streaming).
- Fixed: auto-folded activity groups no longer yank your reading position — folding is sticky and only happens while you're at the bottom.
- Fixed: translation-unavailable shows a one-line hint instead of spinning forever; disabled cloud quota shows "—" instead of an error box.
- Session rows are single-line now (time moved to hover), titles use the full row width; activity summary rows are subtle pills with fully-Chinese tool labels; usage-card quota rows drop the redundant numbers and split countdown/reset-time apart; project dropdown stagger animation removed; brand deduplicated to the sidebar with a shimmer; MCP row and runtime status strip removed; longer rate-limit patience for free-tier GLM.

## v1.0.63 - 2026-08-06

### 中文

- 新增:**摘要 API 支持多套配置、随时切换**（设置 → AI 辅助）。此前是单份配置,换服务商会把上一家的 baseUrl / 型号 / Key 直接覆盖掉,想换回去得重新找 Key 重填。现在存成列表,点一下切换激活项,旧的全部留着;每条 Key 各自走系统安全存储。旧配置首次运行自动迁移成第一条,旧字段刻意保留——万一回退到旧版本那边还得靠它们工作。
- 新增:**限流串行队列 + 指数退避**。免费档模型(如智谱 GLM-4.7-Flash)并发限 1 QPS 且平台侧常拥塞,而 Tran 的调用是突发并发的——一轮结束后一屏冒出五六个工具卡会同时打五六发。实测 10 条并发:**无防护成功 2/10,加上之后 10/10**。冷却是自适应的,撞过限流才拉开间距,不限流的服务不受拖累。
- 修复:混合思考模型返回空内容。`thinking: {type:'disabled'}` 原先只对 DeepSeek 发,而 GLM-4.7-Flash 不传这个参数时推理会把 `max_tokens` 全吃光、`content` 返回空串——命令说明这类只给几十 token 的任务必然踩中,表现是"模型什么都不回",极难排查。
- 修复:智谱的限流是 **HTTP 200 + body `code:1305`**,不是 429。原代码走"返回内容为空"分支且错误信息里没有 1305,重试判定永远触发不了。现在把响应体的 error 带进错误信息,并区分"限流"与"推理占满预算"两种空返回。
- **设置整合**:摘要 / 命名 API 的配置从「系统」搬到「AI 辅助」页,与翻译引擎放在一起——翻译的「模型翻译」通道走的就是那份 baseUrl + Key,分在两页配用户根本连不起来。侧栏入口「翻译」改名「AI 辅助」。
- 思考翻译新增「跟随上面」并作为**默认**:多数人不需要为描述和思考配两套引擎,但仍可单独指定。
- 用量卡的余额行按服务商自适应:摘要 API 不是 DeepSeek 时不显示余额,并说明原因(该服务未提供公开的余额接口),而不是留一行空白。

### English

- New: **multiple summary-API profiles with instant switching** (Settings → AI Assist). It used to be a single config, so switching providers overwrote the previous baseUrl / model / key outright — going back meant hunting down the key again. Profiles are now a list; switching just changes which one is active and every key is kept (each encrypted via OS secure storage). An existing single config migrates into the first profile on first run, and the legacy fields are deliberately left in place so a downgrade still works.
- New: **serial queue with exponential backoff for rate limits.** Free-tier models (e.g. Zhipu GLM-4.7-Flash) cap at 1 QPS and the platform is often congested, while Tran's calls are bursty — a finished turn can surface five or six tool cards that all fire at once. Measured over 10 concurrent calls: **2/10 succeeded unguarded, 10/10 with the queue.** The cooldown is adaptive, so providers that don't rate-limit are never slowed down.
- Fix: empty responses from hybrid-thinking models. `thinking: {type:'disabled'}` was only sent to DeepSeek; without it GLM-4.7-Flash spends the entire `max_tokens` budget on reasoning and returns an empty `content` — guaranteed for tasks budgeted at a few dozen tokens, and it presents as "the model returns nothing at all".
- Fix: Zhipu signals rate limiting as **HTTP 200 with `code:1305` in the body**, not 429. The old path fell into the "empty content" branch with no trace of 1305 in the error, so the retry check could never fire.
- **Settings consolidation**: the summary/naming API config moved from System to the AI Assist page, next to the translation engine — the "model translation" path uses exactly that baseUrl and key, and splitting them across two pages made the connection invisible. The sidebar entry is renamed from Translate to AI Assist.
- Thinking translation gains a "follow the above" option, now the **default**; it can still be set independently.
- The usage card's balance row adapts to the provider: when the summary API isn't DeepSeek it explains why there's no balance instead of leaving a blank row.

## v1.0.62 - 2026-08-06

### 中文

- 修复:**技能页报错 `session not found`**。会话是懒创建的——新会话的 sessionId 只是渲染层的本地 uid,ACP 后端要等你发出第一条消息才真正启动。这期间点开技能页,后端必然找不到会话,原始 IPC 异常直接砸到界面上。现在返回空列表,并显示「会话还没开始,暂时读不到技能」。
- 顺带修:技能页显示的路径写死了 `~/.kimi-code/skills/`,home 被 `KIMI_CODE_HOME` 指到别处时会把人指向一个空目录,改成 `$KIMI_CODE_HOME/skills/`。
- 新增:**快捷键配置**(设置 → 系统)。列出全部动作、点击键位就地重录、Esc 取消、改过的可一键恢复默认,改动立即生效无需重启。带冲突检测——两个动作绑同一个键时,全局监听只会命中先注册的那个,后者永远不触发,而界面看起来"两个都绑好了",那种坏法最难查。
- 侧栏悬停浮出修两处手感问题:**过于灵敏**(鼠标扫过就弹)加 140ms 进入延迟;**不灵敏**其实是关早了——从窄图标条斜着往浮层移动时,指针有几帧落在两者的空隙上,`pointerleave` 当场触发,现在给 260ms 离开延迟。
- 侧栏浮出时图标条不再透出来:浮层是半透明玻璃底,底下的图标会叠上来。

### English

- Fix: **`session not found` error on the Skills page.** Sessions are created lazily — a new session's id is just a renderer-local uid, and the ACP backend only starts once you send the first message. Opening the Skills page before that guaranteed a backend miss, and the raw IPC exception was surfaced directly. It now returns an empty list and shows "the session hasn't started yet".
- Also fixed: the Skills page hardcoded `~/.kimi-code/skills/` as the skill root, which points at an empty directory when the home is redirected via `KIMI_CODE_HOME`. Now shown as `$KIMI_CODE_HOME/skills/`.
- New: **keyboard shortcut configuration** (Settings → System). Lists every action, click a binding to re-record, Esc cancels, changed ones can be reset. Takes effect immediately. Includes conflict detection — two actions on the same key means the global listener only ever reaches the first-registered one while the UI looks like both are bound.
- Sidebar hover-reveal: added a 140ms open delay (it used to fire when merely brushing past) and a 260ms close delay (the "unresponsive" feel was actually closing too early — moving diagonally from the rail into the panel leaves a few frames in the gap between them, which fired `pointerleave` immediately).
- The collapsed icon rail no longer bleeds through the hover panel, whose glass background is translucent.

## v1.0.61 - 2026-08-06

### 中文

- **安全:云端额度查询改为默认关闭。** 这条链路直连 `api.kimi.com/coding/v1/usages` —— Kimi 的**私有接口**,并复用 CLI 的 OAuth 凭证,用它查额度有账号被封的实际先例。此前的闸门写的是"显式设成 false 才拦",也就是说全新安装(值为 `undefined`)**一律放行**——等于默认就在打私有接口。现在改成必须用户明确打开,开关文案也写明了风险。关闭后 5h / 每周两行显示「—」;上下文那行来自本地 `/usage`,不受影响。
- 需要说明的是:5h / 每周额度**只能**来自那个私有接口。核对过 `kimi.exe` 里 `/usage` 的输出模板(`formatUsageReport`),它只给会话 token 累计和上下文窗口,没有任何额度行——所以关掉之后没有替代数据源。
- 新增:**思考翻译单独设置**(设置 → 翻译)。此前它和「技能/插件描述翻译」共用一个开关,但两者取舍相反:描述是短句、机翻足够且免费;思考过程满篇路径、变量名、命令与报错原文,机翻会一并译坏。合并等于逼用户在「描述省钱」和「思考能读」之间二选一。
- 思考翻译默认「自动」:配了百度密钥走百度(免费额度内不花钱),没配则回落到摘要 API。**回落一律可见**——思考块的译文旁标「未配百度 · 本次用模型翻译(计费)」,设置页也实时显示当前落点。悄悄回落就是悄悄花钱。
- 额度百分比不再显示两位小数,一律取整。
- 折叠活动摘要拉开层次:动作亮、思考暗、次数更小更暗,不再是一行同色文字挤在一起。

### English

- **Security: cloud quota lookup now defaults to OFF.** It calls `api.kimi.com/coding/v1/usages` — a **private** Kimi endpoint — reusing the CLI's OAuth credentials, and there is a real precedent of an account being banned over it. The old gate only blocked when the setting was explicitly `false`, so a fresh install (value `undefined`) was **allowed through** — i.e. it hit the private endpoint by default. It now requires an explicit opt-in, and the toggle spells out the risk. With it off the 5h/weekly rows show "—"; the context row comes from the local `/usage` turn and is unaffected.
- Worth stating plainly: the 5h/weekly figures can **only** come from that private endpoint. `/usage`'s own output template in `kimi.exe` (`formatUsageReport`) yields session token totals and the context window only — no quota lines — so there is no alternative source once it is off.
- New: **thinking translation is now its own setting** (Settings → Translate). It used to share one switch with skill/plugin description translation, but the trade-offs are opposite: descriptions are short sentences where machine translation is fine and free; thinking text is full of paths, identifiers, commands and raw errors that machine translation mangles.
- Thinking translation defaults to "auto": Baidu when its credentials are set (free within quota), otherwise it falls back to the summary API. **The fallback is always visible** — the thinking block labels it and the settings page shows the live channel. A silent fallback is silent spending.
- Quota percentages are rounded to whole numbers.
- The folded activity summary now has visual hierarchy: actions bright, thinking dim, counts smaller and dimmer.

## v1.0.60 - 2026-08-06

### 中文

- 修复:**会话一多,输入框和侧栏「工具」区被挤出屏幕**。workspace 网格的行高按内容 max-content 算,侧栏会话列表把整行撑出视口,连带主列一起变高。现在行高钳在容器内(minmax(0,100%)),侧栏根补 h-full/min-h-0,列表自己滚动。
- 修复:用量卡低分辨率下文字堆叠。「每周额度」被长重置文案压成竖排——现在标题和百分比永不换行,倒计时和具体时刻挪到进度条下的明细行,明细行自然折行。
- 修复:待办「后台任务已结束」横幅误报常驻。旧逻辑是"历史任务里存在一个已收尾任务",而列表有 90+ 条历史,几乎永远为真。加 30 分钟新鲜度窗口,只有刚收尾的任务才提示。
- 翻译配置整合:思考块全文翻译的引擎开关并入「翻译」面板(原来系统页还有一个重复开关),技能描述翻译和思考翻译共用同一个引擎 + 同一把百度密钥。
- MCP 状态行默认收起成一枚胶囊(「● MCP · n」,有异常标橙),点开才看服务器列表。
- 炭灰主题下设置页/工具菜单过黑(半透深黑叠底比对话区还黑),统一抬成 Codex 中性灰;简约风不再清 border-radius(方形框恢复圆角)。
- Claude Code:侧栏收起态悬停浮出完整面板(peek);活动折叠摘要分段渲染——做了什么(工具动作)提亮、想了什么(思考)压暗,次数缩小挂后。

### English

- Fixed: with many sessions, the composer and the sidebar "tools" section were pushed off-screen — the workspace grid row sized to max-content, so a long session list stretched the whole row (and the main column with it). Rows are now clamped (minmax(0,100%)) and the sidebar roots got h-full/min-h-0 so the list scrolls itself.
- Fixed: usage card text piling up at low resolutions — titles and percentages never wrap now; countdown and concrete reset time moved to the detail line under the progress bar, which wraps naturally.
- Fixed: the "background task finished" todo banner showed permanently — it used to fire whenever ANY settled task existed in history (90+ entries). Now only tasks settled within the last 30 minutes trigger it.
- Translation settings unified: the thinking-translation engine moved into the Translate panel (one engine + one Baidu credential for both skill descriptions and thinking blocks).
- MCP status bar now defaults to a collapsed pill (expand to see servers).
- Charcoal theme: settings/tools surfaces no longer pitch black (raised to Codex neutral grays); the flat style no longer strips border-radius (panels are round again).
- Claude Code: hover-to-peek sidebar when collapsed; segmented activity summary rendering (tool actions emphasized, thinking subdued, counts smaller).

## v1.0.59 - 2026-08-05

### 中文

- 工具行图标：不同操作配不同小图标（命令 ›_、搜索网页 🌐、读文件 📖、写/编辑 ✏️、内容搜索 🔍、列目录 📁、子代理 👥）——图标为 Codex 桌面版 app.asar 里实测提取的原版 SVG，不是自己发挥。
- MCP 状态行重样式：服务器收成小胶囊（状态点 + 名称 + 工具数），底部加发丝分割线与对话区分开；文案降噪（connected 由状态点表达、stdio 是默认类型，都不再写出来）。
- 侧栏宽度可拖拽调节（180px 起，持久化保存）；侧栏收起/展开快捷键 Alt+Q（同时保留 Ctrl+B）；移除拖边缘自动隐藏机制（与收起机制重复，语义统一为 collapsed 一种）。

### English

- Per-tool activity icons: distinct glyphs for commands, web search, file reads, edits, content search, directory listing and sub-agents — the actual SVGs extracted from Codex desktop's app.asar, not approximations.
- MCP status bar restyled: compact pills (status dot + name + tool count) with a hairline divider separating it from the conversation; noisier defaults (connected, stdio) no longer spelled out.
- Sidebar width is now draggable (min 180px, persisted); Alt+Q toggles the sidebar (Ctrl+B kept); the drag-to-auto-hide mechanism was removed in favor of the single collapsed state.

## v1.0.58 - 2026-08-05

### 中文

- 排版:随包分发 JetBrains Mono(官方完整 webfonts,400/500 两个字重,OFL-1.1 许可),代码、diff、终端输出不再依赖系统里有没有好等宽字体;界面字体刻意跟随系统(对齐 Codex 桌面版实测行为——它在 Windows 上就是 Segoe UI + 系统中文字体)。
- 主题:炭灰底色对齐 Codex 实测色值。之前是偏蓝的板岩灰(#1e2025/#23262b),Codex 是纯中性灰——主背景 #181818、浮层 #212121,已全部换成实测值。
- 用量卡:移除会员等级(Advanced)标签;DeepSeek 余额行复用"设置 → 系统"里已存的摘要 API key(此前只认专用栏,没填就永远不显示);重置倒计时统一中文单位并显示具体到期时刻——同日只显示"今天 21:34",跨天显示"8月11日 周二 21:34"。
- 思考块全文翻译:默认切到**百度机翻**(认证后 100 万字符/月免费),设置里可切回 DeepSeek(质量更好、按量计费)。百度长文按行切块翻译,保留换行与 markdown 结构。通道没配 key 或接口失败时显示原文并给一句轻提示,不再永远转"翻译中…"。
- Read 工具结果详情:行号拆成独立行号槽 + 分割竖线,剥离行号后再做语法高亮(此前行号混在代码里,既突兀又搞坏高亮);diff 视图的行号槽同步加分隔线。
- 状态行「AI 正在输出中」整行统一流光(此前只有标签闪,计时和排队提示是灰的,看着像断了)。
- 「新建对话」按钮、设置页头部控件(返回对话、版本号)改全圆角。

### English

- Typography: JetBrains Mono is now bundled (official full webfonts, 400/500, OFL-1.1) for code, diffs and terminal output; the UI font deliberately follows the system (matching the measured Codex desktop behavior — Segoe UI + system CJK font on Windows).
- Theme: the charcoal palette now matches Codex's measured values — neutral grays (#181818 base, #212121 elevated) instead of the previous blue-tinted slate.
- Usage card: removed the membership-level (Advanced) label; the DeepSeek balance row reuses the summary API key already stored in Settings → System (previously it only read a dedicated key slot and stayed hidden); reset countdowns use consistent Chinese units and show the concrete reset moment ("今天 21:34" same-day, date + weekday + time when crossing days).
- Thinking-block full translation now defaults to **Baidu MT** (1M chars/month free after verification), switchable back to DeepSeek in Settings. Long text is translated in line-based chunks so newlines and markdown structure survive. When no channel is available the original text is shown with a one-line hint instead of spinning "translating…" forever.
- Read tool results: line numbers get their own gutter with a divider, stripped before syntax highlighting; the diff view gutter gets the same divider.
- The "AI is responding" status line now shimmers as one unit (label + elapsed time + queue hint).
- The "new chat" button and settings header controls are fully rounded.

## v1.0.57 - 2026-08-05

### 中文

- 修复:**删除会话删不掉**。Tran 把 kimi 的数据目录写死成 `~/.kimi-code`,无视 `KIMI_CODE_HOME`。用户把 home 指到别处时,那个旧目录往往还在、格式还对得上 —— 删除于是在一份**搬家前的过期副本**上重写索引、删目录,然后返回成功,而 `session/list` 走的是真 home,条目原样返回。表现就是点删除毫无反应,点几次都没用。
- 同一个写死路径还让另外四处静默失效:AI 会话命名读不到历史消息(退化成兜底标题)、kimi server 的 token 与实例发现找错目录、后台任务的磁盘数据源读空、`session/load` 缺失 plan 文件的补写因白名单不匹配而从不触发。现在 home 解析统一收敛到 `kimiHome.ts` 一处。
- 修复:删除会话时**什么都没删掉却报成功**。索引里没有、目录也找不到时,现在如实报错并说明当前数据目录,不再假装成功 —— 这正是上面那个 bug 需要点三次才让人察觉不对的原因。
- 注意:定位 kimi **可执行文件**的路径仍是 `~/.kimi-code/bin`,不随 `KIMI_CODE_HOME` 走(kimi 自己上报的登录命令就是该路径)。

### English

- Fix: **deleting a session did nothing**. Tran hardcoded kimi's data directory to `~/.kimi-code`, ignoring `KIMI_CODE_HOME`. When the home is redirected elsewhere, that stale directory usually still exists with a matching layout — so the delete rewrote the index and removed directories in a **pre-move copy**, then reported success, while `session/list` reads the real home and returned the entry unchanged. The visible symptom: clicking delete does nothing, no matter how many times you click.
- The same hardcoded path silently broke four other things: AI session naming could not read past messages (falling back to a generic title), the kimi server token and instance discovery looked in the wrong place, the on-disk source for background tasks read empty, and the missing-plan-file recovery after `session/load` never fired because the path failed its whitelist. Home resolution is now centralized in `kimiHome.ts`.
- Fix: deleting a session **reported success while deleting nothing**. When the session is in neither the index nor on disk, it now reports a real error naming the current data directory instead of pretending to succeed — which is exactly why the bug above took three clicks to notice.
- Note: locating the kimi **executable** still uses `~/.kimi-code/bin` and deliberately does not follow `KIMI_CODE_HOME` (that is the path kimi itself reports for its own login command).

## v1.0.56 - 2026-08-05

### 中文

- 视觉收敛(Codex 风):状态指示从三处收成一处 —— 删掉对话底部的「Tran 正在处理…」和消息内的「输出中…」,只留输入框上方的「AI 正在输出中」(计时 + 排队语义最全的那条)。思考块改为完全裸排版:无框无竖条无底,唯一的动态信号是流式时标题的紫黄流光。
- 新增:**完成轮活动折叠**。一整轮回答结束后,连续的思考/工具调用收进一行规则摘要(如「思考 2 段 · 运行了命令 ×5 · 编辑了文件」),点开即还原成完整渲染 —— 纯规则统计,不调总结 API;单个块不多包一层。
- 新增:**主题底色切换**(设置 → 个性化)。深黑(现状)/ 炭灰(Codex 风)两档,即时生效;只换底色台阶,accent 紫色系不动。
- 新增:**DeepSeek 余额**(设置 → 系统)。填 DeepSeek API Key 后,用量卡多一行「余额 · 充值 / 赠金」,走官方公开的 /user/balance 接口;Key 用系统安全存储、界面只回显掩码。官方只暴露余额,没有 token 用量明细。
- 消息时间戳改为默认隐藏、悬停该条才浮出,格式带秒;「新建对话」从紫色主按钮降为中性次要按钮。

### English

- Visual consolidation (Codex-style): three activity indicators collapsed into one — the transcript-foot "Tran is working…" and the in-message "streaming…" lines are gone, leaving only the composer status line (the one with elapsed time and queue semantics). Thinking blocks are now completely unadorned: no frame, no bar, no tint; the only motion is the violet shimmer on the header while streaming.
- New: **finished-turn activity folding**. Once a turn completes, consecutive thinking/tool-call blocks collapse into a single rule-based summary line (e.g. "2 thinking segments · ran 5 commands · edited files"); click to expand back to the full rendering — pure rule counting, no summary API; single blocks are left untouched.
- New: **theme background switch** (Settings → Personalization). Onyx (current) / Charcoal (Codex-like), applied instantly; only the base surfaces change, the violet accent system stays.
- New: **DeepSeek balance** (Settings → System). With a DeepSeek API key saved, the usage card shows a balance row (total / topped-up / granted) via the official public /user/balance endpoint; the key is stored with OS secure storage and only shown masked. The official API exposes balance only, no token usage detail.
- Message timestamps are now hidden until the message is hovered and include seconds; "New chat" is demoted from a violet primary button to a neutral secondary one.

## v1.0.55 - 2026-08-05

### 中文

- 新增:**diff 的代码带语法高亮了**(Codex 风格)。此前只有加/删的红绿底色,代码本身是纯文本;现在按文件扩展名推断语言着色,统一视图与并排视图都有。
- 做法上有个必须的细节:把 diff 还原成"旧文件"和"新文件"两份完整文本各高亮一次再按行切回来 —— 逐行单独高亮会丢掉跨行语境,块注释和模板字符串里的每一行都会被当成独立代码,颜色全错。
- 成对改动的行保留原有的**词级**着色、不叠语法高亮:词级分段是按字符切的,会把语法 token 拦腰截断,两套着色叠在一起更难读;而在一对改动行上,"改了哪几个词"比"这是个关键字"更重要。
- 顺带:「AI 正在输出中」那行改成紫色流光文字。

### English

- New: **syntax highlighting inside diffs** (Codex-style). Previously only the added/removed tint was there and the code itself was plain text; the language is now inferred from the file extension, in both unified and side-by-side views.
- One detail that matters: the diff is reconstructed into complete "old file" and "new file" texts, highlighted once each, then split back per line — highlighting line by line loses cross-line context, so every line inside a block comment or template literal would be treated as standalone code and colored wrong.
- Paired changed lines keep their existing **word-level** tint instead of stacking syntax highlighting on top: word segments are cut by character offset and would slice syntax tokens in half; on a changed pair, "which words changed" matters more than "this is a keyword".
- Also: the "AI is responding" line is now violet flowing text.

## v1.0.54 - 2026-08-05

### 中文

- 修复:**每次打开 Tran 都会凭空多一条 "New Session"**。启动时自动进入上次的项目走的是"立刻起后端会话"那条老路,也就是每开一次应用就真的 `session/new` 一个空会话落盘;进来还没说话就切到历史会话,那条空会话就永远留在列表里了。
- 「新建对话改为懒创建」当初只覆盖了侧栏的新建按钮,**漏了启动这条路径**,所以同一个毛病换个入口又冒了出来。现在两条路统一:先只把界面切成空会话,等真的发第一条消息才起后端 —— 没说话就没有会话。
- 实测确认:修复前仅启动一次,磁盘会话目录 104 → 105;修复后 105 → 105,不再新增。

### English

- Fixed: **every launch of Tran left behind an extra "New Session"**. Auto-entering the last project on startup still used the eager path, so each launch really did `session/new` an empty session on disk; switch to a history session before saying anything and that empty shell stayed in the list forever.
- The earlier "lazy session creation" change only covered the sidebar's new-chat button and **missed the startup path**, so the same defect resurfaced through a different entry point. Both paths now behave the same: the UI switches to an empty session immediately and the backend session is only created when you actually send the first message.
- Verified empirically: before the fix a single launch took the on-disk session count from 104 to 105; after the fix it stays at 105.

## v1.0.53 - 2026-08-05

### 中文

- 修复:**任务栏/开始菜单图标在小尺寸下偏"一块纯黑方块"**。设计没有任何改动,问题出在亚像素量化:白 T 的横笔在 32px 上算出来是 2.87 像素,被舍成 2 像素,一下丢掉 30% 的墨量(256px 白色占比 11.6%,32px 只有 6.2%)。现在 ≤48px 的档位把笔画宽度向上取整重绘,白色占比回到 8% 上下。**底板、圆角、底部颗粒质感和紫点一个像素都没动**,只有 T 变厚实了。
- 清理:`scripts/generate-icon.cjs` 原本是早已废弃的橙底白 F(老 Forge 图标)生成器,与在用的图标毫无关系,留着只会误导。现改写为上述小尺寸字形加粗工具,可重复执行且幂等。

### English

- Fixed: **the taskbar / Start-menu icon read as a near-black tile at small sizes**. The design is unchanged; the cause was sub-pixel quantization — the white T's bar computes to 2.87px at 32px and got floored to 2px, losing 30% of its ink (white coverage: 11.6% at 256px vs 6.2% at 32px). Sizes ≤48px now redraw the glyph with stroke widths rounded up, bringing coverage back to ~8%. The tile, corners, bottom grain texture and purple dot are untouched — only the T got its weight back.
- Cleanup: `scripts/generate-icon.cjs` was a long-dead generator for the orange-and-white "F" (legacy Forge icon) with no relation to the icon actually shipping. It is now the small-size glyph-weight tool described above, and is idempotent across runs.

## v1.0.52 - 2026-08-05

### 中文

- 修复:**「改动」面板的还原对新增/重命名/未跟踪目录全都无效**。新增文件和重命名后的新路径在 HEAD 里根本不存在,`git checkout HEAD -- <路径>` 必然报 pathspec 错误,点了还原只弹一句英文 git 报错;未跟踪目录因为没开递归删除会抛 EISDIR。现在按改动类型分派:新增走撤索引+删文件、重命名 checkout 旧路径再移除新路径、未跟踪递归删除,AA 冲突这类 HEAD 里没有的情况也有兜底。已用真实仓库逐项验证。
- 修复:**重命名文件的 diff 显示成整文件新增**。只把新路径交给 git 会让 pathspec 滤掉旧路径、rename 检测失效,现在两个路径一起传。
- 修复:**空仓库(还没有任何提交)下改动面板看不到内容**。没有 HEAD 时改用空树对象作基准,已暂存的文件不再显示成"无改动"。
- 修复:**刚发出的消息可能在会话重启后消失**。历史合并的指纹去重里,按 id 命中的条目不消耗计数,导致与历史同文的新消息被误判为"已落盘"而丢弃(例如历史里有过"继续",再发一条"继续")。
- 修复:**超过 20MB 的图片附件静默消失**。此前只在主进程日志里留一行,界面上毫无反应;现在会明确告诉你哪个文件没能附加、为什么,粘贴失败也不再无声无息。
- 修复:**ACP 断线重连期间的两处竞态**。恢复窗口内新消息会撞上还没 load 完的会话报错、并发的真实回复会被历史回放吞掉;现在恢复期间挂会话级闸门,消息排队等恢复完成,恢复中二次断线也能继续处理。
- 修复:会话在等权限时被销毁后,重新打开会复活那个早已取消的权限弹窗(作答会落到失效的 requestId)。
- 优化:**首屏 bundle 从 1758KB 降到 1604KB**。设置、MCP、技能、翻译等七个全屏面板改为按需加载,点开才拉对应的代码块。

### English

- Fixed: **Changes-panel revert did nothing for added / renamed / untracked-directory files**. Added files and rename targets don't exist in HEAD, so `git checkout HEAD -- <path>` always failed with a pathspec error; untracked directories threw EISDIR without recursive removal. Revert now dispatches on change type (unstage+delete for added, checkout-old + remove-new for renames, recursive delete for untracked), with a fallback for AA conflicts. Verified case by case against a real repository.
- Fixed: renamed files rendered as whole-file additions (passing only the new path made git's rename detection fail); empty repositories (no commits yet) showed nothing in the Changes panel (now diffed against the empty-tree object).
- Fixed: **a just-sent message could vanish after a session restart** — id-matched entries didn't consume their fingerprint count, so a new message identical to an older one was mistaken for already-persisted and dropped.
- Fixed: image attachments over 20MB disappeared silently; the UI now names the skipped file and the reason (paste failures too).
- Fixed: two races during ACP reconnection (messages sent mid-recovery hit a not-yet-loaded session; concurrent real replies were swallowed by history replay) — recovery now holds a per-session gate. Also fixed a cancelled permission prompt coming back to life when reopening a session that was destroyed while waiting.
- Improved: **first-paint bundle down from 1758KB to 1604KB** — seven full-screen panels (settings, MCP, skills, translate, …) now load on demand.

## v1.0.51 - 2026-08-05

### 中文

- 新增:**「改动」面板(Codex 风格)**。Git 顶栏新增「改动」入口,聚合展示工作区相对 HEAD 的全部改动:文件列表带状态标记与 +N/−N 行数统计,点击文件懒加载完整 diff(复用行内高亮的 DiffView),支持单文件还原(跟踪文件还原到 HEAD、未跟踪文件删除,均有确认弹窗)。未跟踪文件合成"全新增"diff 展示。
- 新增:**ACP 连接断开自动恢复**(#3)。kimi 进程意外退出时不再直接报错拆会话:保留已输出内容、就地封口流式消息,退避重建连接(1s/3s/8s),有会话 id 的自动 resume 复活,恢复成功/失败都有明确的状态卡提示。不会自动重发你的消息。
- 新增:**运行状态可视化**(#5)。侧栏会话列表给正在运行的会话加呼吸点标识;输入区忙碌时显示原因(等待权限确认/等待回答问题/AI 正在输出/子任务后台运行中)。
- 新增:设置页「云端套餐额度显示」开关。额度环的数据来自 Kimi 云端私有接口(复用 CLI 登录凭证),现在可以明确关闭,关闭后不发任何相关请求、不碰凭证文件。
- 修复:**MCP 配置写错文件**(#62)。此前写入旧 Claude 后端的 `~/.claude.json`,Kimi 根本不读;现在写 `~/.kimi-code/mcp.json`(跟随 KIMI_CODE_HOME),添加的 MCP server 终于能生效了。
- 修复:**跨目录切换会话不再产生空会话壳**(#47),resume 失败时如实报错并可重试,不再静默新建。
- 修复:**切换会话后子代理面板状态不再错乱**(#23),运行计数/计时/权限请求纳入后台快照,切回后如实恢复。
- 修复:**中文用户名下找不到 kimi**。`where.exe` 输出是 GBK 编码,此前按 UTF-8 解码导致路径乱码、后端起不来;现在正确解码并加了 PowerShell 探测兜底。
- 修复:**Windows 进程回收**。关闭/退出时用 taskkill 整树终止 kimi 子进程(npm 安装的 cmd 包装此前杀不干净,历史查询每空闲一轮泄漏一个约 300MB 的进程);升级/探测子进程超时也会被终止。
- 修复:**切换会话时流式输出的两类错乱**:旧会话残留的流式片段不再产生"永远打字中"的幽灵气泡;新会话的首字不再被旧会话积压阻塞数秒。
- 修复:**重启会话(改 MCP/切运营商)后对话不再重复**,历史合并改用内容指纹去重。
- 修复:一批数据安全防线——会话索引读取失败时不再误删历史会话目录;更新下载只接受本项目 GitHub Releases 的 URL;设置页 API Key 不再明文回传渲染层(改掩码回显);图片附件加 20MB 上限。
- 修复:权限弹窗因界面重载丢失后,会话不再永久卡"忙碌"(重新挂载时重投权限请求 + 24 小时硬上限兜底)。
- 优化:日志目录迁移到 userData(打包版此前可能落在只读目录导致日志丢失);大 diff 渲染加配对上限不再冻结界面;长会话流式期间的多处全量扫描改为增量/缓存;历史加载的 O(n²) 配对改建索引。
- 界面:设置/技能等子页面返回按钮吸顶(#35);发送消息后视图跳到底部并恢复跟随(#36);思考月亮改纯渐变球(#37);"AI 正在思考"指示不再挤动 chip 行(#39);消息旁常显 HH:mm 时间戳、悬停看完整时间(#43)。

### English

- New: **Changes panel (Codex-style)**. A "Changes" entry in the Git toolbar aggregates the whole working tree vs HEAD: file list with status letters and +N/−N counts, lazy-loaded per-file diffs (reusing the inline-highlight DiffView), and per-file revert (tracked → HEAD, untracked → delete, both behind confirm dialogs). Untracked files render as synthesized all-added diffs.
- New: **automatic recovery from ACP disconnects** (#3). When the kimi process dies unexpectedly, Tran no longer errors out and tears the session down: streamed output is preserved and sealed, the connection is rebuilt with backoff (1s/3s/8s), sessions with ids auto-resume, and clear status cards mark both outcomes. Your prompt is never auto-resent.
- New: **run-state visibility** (#5). Sidebar sessions show a breathing dot while running; the composer explains why it is busy (waiting for permission / waiting for your answer / AI responding / subtasks running in background).
- New: a settings toggle for **cloud plan-usage display**. The quota rings hit a private Kimi cloud endpoint reusing the CLI's OAuth credentials; you can now switch that off entirely — no requests, no credential file access.
- Fixed: **MCP config written to the wrong file** (#62) — it went to the legacy `~/.claude.json`, which Kimi never reads; it now goes to `~/.kimi-code/mcp.json` (honoring KIMI_CODE_HOME), so added servers actually take effect.
- Fixed: cross-project session switching no longer silently creates empty session shells (#47); subagent panel state survives session switches (#23); GBK decoding of `where.exe` output (Chinese usernames could not find kimi at all); Windows process-tree cleanup via taskkill (npm-installed kimi leaked ~300MB orphans); ghost "typing" bubbles and first-token starvation when switching sessions mid-stream; duplicated transcripts after session restarts.
- Fixed: a batch of data-safety guards — orphan sweep aborts when the session index is unreadable (previously could wipe session history), update downloads only accept this repo's GitHub Releases URLs, the summary API key is masked instead of returned in plaintext, image attachments capped at 20MB, and permission prompts lost to a renderer reload are re-delivered instead of leaving the session busy forever.
- Improved: logs moved to userData (packaged builds could land in read-only dirs); large diffs no longer freeze the UI (pairing cap); several per-token full-array scans replaced with incremental/cached paths; O(n²) history pairing now indexed.
- UI: sticky back buttons on sub-pages (#35), send-jumps-to-bottom (#36), pure-gradient thinking moon (#37), stable chip row (#39), always-on HH:mm message timestamps with full time on hover (#43).

## v1.0.50 - 2026-07-31

### 中文

- 优化:**托盘图标换成无边界的衬线 T**。原先是「紫色圆角方块 + 顶部高光渐变 + 一圈内白边 + 白色 T」,在托盘里就是一个紫色小方块,跟旁边一排系统图标的语言完全不一样。现在只有紫色的字形本身,背景透明,和系统托盘那些单色图标是一套。字形也从几何体换成衬线体(横笔两端略加厚 + 底部衬线脚),并放大到 62% 宽 —— 去掉底板之后,字形要自己承担整个图标的视觉重量。
- 备注:斜体带弯钩和加起笔的花体都试过,72px 下确实好看,但托盘实际渲染到 16px 会把钩和起笔全糊掉,只剩一个歪着的 T。衬线脚是唯一在 16px 下还留得住的装饰。任务栏/开始菜单/安装程序用的图标是另一套资源文件(`build/icon.ico`),这一版没动。

### English

- Improved: **the tray icon is now a borderless serif "T"**. It used to be a purple rounded square with a gradient, an inner white rim and a white T — which read as a purple blob next to the monochrome system tray icons. Now it is just the glyph in accent purple on transparency. The letterform also moved from geometric to serif (slightly flared bar ends plus a slab foot) and grew to 62% width, since without the plate the glyph has to carry the icon on its own.
- Note: italic-with-hook and full calligraphic variants were tried; they look good at 72px but the tray renders at 16px, where the flourishes dissolve into a lopsided T. The slab foot is the only ornament that survives at that size. The taskbar/installer icons are separate asset files (`build/icon.ico`) and were not touched.

## v1.0.49 - 2026-07-31

### 中文

- 恢复:**5 小时滚动窗口与每周额度的圆环回来了**,和上下文一起是三个环,悬停/点击浮出预览卡(各窗口百分比、已用/上限、重置倒计时,以及输入/输出/缓存命中的 token 明细)。上下文那条也从进度条改回圆环。
- 说明清楚这次恢复的**不是** v1.0.46 删掉的那条:额度走 `GET api.kimi.com/coding/v1/usages`,Bearer 用 Kimi Code CLI 自己的 OAuth access_token(过期自动 refresh),是官方接口 + CLI 自己的凭证。**复用浏览器 Cookie 打网页 MembershipService RPC 的 `quotaService` / `kimiWebChat` 继续保持删除**,不再以任何形式回来。
- 已知情况:Kimi 账号被封禁期间,该接口对新签发的 token 也返回 401,两个额度环会显示「—」,预览卡里会写明失败原因。上下文环不受影响(它来自本地 ACP 的 `/usage`)。解封后自动恢复,不需要改配置。
- 优化:空态页面改回大标题形态,标题加**紫色流光**动画(4.5s 一轮,比"思考中"那条慢一倍,不抢注意力;开启「减少动态效果」时自动静止)。去掉那四个建议按钮 —— 它们看着像功能,实际只是把词填进输入框,占了一整行却没解决任何问题。

### English

- Restored: **the 5-hour rolling window and weekly quota rings are back**, alongside context — three rings, with a hover/pin preview card (per-window percentage, used/limit, reset countdown, plus the input/output/cache-read token breakdown). The context indicator went back to a ring instead of a bar.
- To be explicit, this is **not** what v1.0.46 removed: quota comes from `GET api.kimi.com/coding/v1/usages` with the Kimi Code CLI's own OAuth access token (auto-refreshed). The browser-cookie MembershipService RPC path (`quotaService` / `kimiWebChat`) stays deleted and is not coming back in any form.
- Known: while the Kimi account is suspended, that endpoint returns 401 even for a freshly issued token, so the two quota rings show "—" and the preview card states why. The context ring is unaffected (local ACP `/usage`). It recovers on its own once the account is restored.
- Improved: the empty state is back to a headline, now with a **purple shimmer** animation (4.5s sweep, half the speed of the "thinking" shimmer so it doesn't compete; static under reduced-motion). The four suggestion buttons are gone — they looked like features but only prefilled the composer.

## v1.0.48 - 2026-07-31

### 中文

- 变更:**你的发言改回右对齐**。中间那版试过「与 AI 同列 + 左侧竖线」,实际用下来不行 —— 两个人说话左边界完全一样,扫一眼分不出谁是谁,一条细竖线扛不住这个活。现在靠位置区分说话人,但不做玻璃气泡那套描边+渐变+投影,只要一块很淡的底;右边界仍与 AI 正文列齐平,宽度按内容走、封顶 76%,贴日志贴报错照样铺得开。
- 修复:**待办条比 AI 回复宽一截**(14px)。两边都写 92%,但待办条挂在滚动容器**外面**、消息行在里面,父容器差着一条滚动条的宽度(实测 1007 vs 977),同样的百分比算出来就不一样。改成固定 56rem —— 三者的父容器中心本来就重合,宽度一致边界就一致,任何窗口尺寸下都对齐。
- 修复:用户发言的居中被一条 `margin: 0.85rem 0` 简写冲掉(它把左右外边距一起写成 0),表现是整条左移一格、右边界对不上。改用 `margin-block`。
- 优化:**空态页面整块降调**。原先是「80px 圆角方块装一个终端图标 + 24px 紫色渐变大标题 + 四个方头方脑的按钮」,每个元素都在抢注意力,而这个页面本身没有信息量。现在图标去掉外框只留线条并压暗,标题去掉渐变降到 19px,四个建议改成小号淡底 chip,纵向也收紧一档。

### English

- Changed: **your messages are right-aligned again.** The interim "same column as the AI, with a left accent rule" did not hold up — both speakers shared a left edge, so a glance could not tell them apart, and a hairline rule is not enough signal. Position now distinguishes the speaker, but without the glass bubble's border, gradient and shadow — just a faint fill. The right edge still lines up with the AI column; width follows content, capped at 76%, so pasted logs still spread out.
- Fixed: **the todo bar was 14px wider than AI replies.** Both said 92%, but the todo bar sits outside the scroll container while message rows sit inside, so their parents differ by a scrollbar's width (1007 vs 977) and the same percentage resolves differently. Now a fixed 56rem — the parents already share a center, so equal widths mean equal edges at any window size.
- Fixed: the user row's centering was being clobbered by a `margin: 0.85rem 0` shorthand, which also zeroed the horizontal auto-margins. Uses `margin-block` now.
- Improved: **the empty state is much quieter** — the boxed icon, the 24px gradient headline and the chunky buttons all competed for attention on a page that carries no information. Now an unboxed dimmed glyph, a plain 19px title, and small low-contrast suggestion chips.

## v1.0.47 - 2026-07-31

补 v1.0.46 与 DeepSeek 实测报告之间对不上的几处。

### 中文

- 修复:**破坏性命令的说明会把危险的那一半吃掉**。12 个字装不下一条命令的全部含义,模型挑重点说,而挑掉的常常正是危险的部分 —— 实测 `git reset --hard HEAD~1` 被概括成「撤销最近一次提交」(Flash 和 Pro 都一样),丢弃未提交改动这件事整个消失;`git push --force-with-lease` 被说成「安全推送认证分支」,"强制"没了。换更强的型号解决不了,12 字的预算摆在那里。现在两道防护:少样本里加一条破坏性命令做示范,出来之后再按标志位查一遍(`--force` / `--hard` / `--delete` / `prune` / `rm` / `Remove-Item` / 管道到 shell / `-Recurse -Force`),对应的危险词一个都没留住就把这条说明判废 —— 界面上命令原文一直都在,去掉注解看到的就是原始命令。用报告里 20 条真实输出回归:判废 3 条(正是报告点名的那 3 条),其余 17 条零误杀。
- 修复:**摘要请求没传 temperature**,吃服务端默认的 1.0,而实测报告那 62 次调用全程是 `0.2` —— 跑的和测的不是一套。现在按实测传 0.2;若所配服务不接受(个别型号只允许固定值),自动去掉重打一次。
- 文档:更正三处已经不成立的注释 —— 思考翻译"走免费通道"(那条通道 v1.0.46 已随网页接口删除,现在走用户自己的 key,是全 app 最贵的一次调用)、`temperature` 会被 400(那是 reasoner 系型号的限制,不适用于 flash/pro)、以及并不存在的 `summaryNotesEnabled` 开关。

### English

- Fixed: **command notes dropped the dangerous half of destructive commands.** Twelve characters cannot hold a command's full meaning, and what the model drops is often the risky part — `git reset --hard HEAD~1` became "undo the last commit" on both Flash and Pro, losing the discarded working tree entirely. A stronger model does not fix this; the budget does. Now guarded twice: a destructive command in the few-shot examples, and a post-check against destructive flags (`--force`, `--hard`, `--delete`, `prune`, `rm`, `Remove-Item`, pipe-to-shell, `-Recurse -Force`). If none of the matching risk words survived, the note is discarded — the raw command is always on screen, so dropping the annotation shows exactly that. Replayed against the 20 real outputs in the benchmark: 3 discarded (precisely the 3 the report flagged), 0 false positives on the rest.
- Fixed: **summary requests sent no temperature**, taking the server default of 1.0, while all 62 benchmark calls ran at `0.2`. Now sends 0.2, with a single retry without it if the configured service rejects it.
- Docs: corrected three comments that no longer hold — thinking translation "uses the free channel" (removed in v1.0.46; it now bills the user's own key and is the most expensive call in the app), `temperature` causing a 400 (a reasoner-family restriction, not flash/pro), and a `summaryNotesEnabled` toggle that does not exist.

## v1.0.46 - 2026-07-30

### 中文

- 安全调整：彻底移除 Kimi 网页内部接口、Cookie/Session 登录、套餐总额度查询及相关后台轮询。
- 用量展示只读取当前 Kimi ACP 会话的 `/usage` 结果，显示上下文占用及输入、输出、缓存 token；不再请求网页版服务。
- 会话命名、命令说明、思考摘要与翻译改走用户配置的 OpenAI 兼容 API。Base URL、模型和 API Key 均可在 Tran 内填写，API Key 使用 Electron `safeStorage` 加密保存。
- 默认摘要服务改为 DeepSeek API，默认模型为 `deepseek-v4-flash`；短总结请求显式关闭思考模式，减少延迟和费用。

### English

- Security: removed all Kimi web-internal API, cookie/session login, plan-quota lookup, and related background polling code.
- Usage now comes only from the active Kimi ACP session's `/usage` response, showing context usage plus input, output, and cache tokens.
- Session titles, command notes, thinking summaries, and translations now use a user-configured OpenAI-compatible API. Base URL, model, and API key are configurable in Tran; the key is encrypted with Electron `safeStorage`.
- DeepSeek is the default summary provider with `deepseek-v4-flash`; thinking is explicitly disabled for short summary requests to reduce latency and cost.

## v1.0.45 - 2026-07-30

### 中文

- 变更:**「+ 新建对话」不再立刻建会话**,改成发出第一条消息时才建。此前一点就在后端落一个会话,kimi 给它的标题恒为 "New Session"—— 于是每点一次、每开一次窗口,侧栏就多一条你从没说过话的空会话。没说话就没有会话,也就没有空壳要清理。(开机启动和切换项目仍是立即创建,那两条路径这版没动。)
- 修复:侧栏那些残留的空会话。原先的过滤是「最近 10 分钟更新过的无标题会话就放行」,太宽——任何刚被写过的空壳都会现身、过一会儿又自己消失,看着像时好时坏。现在只放行**本进程当前还持有的**那个会话(也就是你正开着的),历次运行留下的一律不列。
- 修复:「后台命令」chip 明明没有命令在跑却一直闪流光。轮结束后仍挂在 running/pending 的工具块是没等到结果帧的残留(中断、历史重放缺帧都会留下),它们被当成"在跑"。现在前台工具只在轮内才算在跑;后台任务不受影响,它们本来就跨轮存活。
- 修复:切会话时会话悬停预览卡卡在左上角不消失。收起只挂在行的 `pointerleave` 上,而切会话会重建列表行,旧元素直接消失,事件根本不触发。
- 修复:切到别的项目的会话时,侧栏整个列表先清空再重填,表现为"目录收缩重载一次"。现在留着旧列表,新数据到了原地替换。
- 优化:悬停预览卡的摆位夹住四边——左边至少推到侧栏之外(此前压在项目选择器上),右边和下边不超出窗口。
- 优化:输入框不聚焦时也有边界了。简约风把玻璃面板的底和描边一起拆了,于是不聚焦时整个输入区一点框都没有;聚焦时又跳到一圈会呼吸的紫色渐变。现在常驻淡底加发丝描边,聚焦只把描边染成低饱和的紫,呼吸光环在简约风下关掉。
- 优化:空态页面。图标框和四个建议原先挂在玻璃类上,简约风下等于没有样式,是四个浮在底色上的裸字;现在自带底色。四个建议也从假按钮改成真按钮,点一下把话填进输入框。
- 优化:待办条、目标条与 AI 回复对齐同一条居中的正文列(此前它们仍是左对齐)。

### English

- Changed: **"New chat" no longer creates a session immediately** — the backend session is created when you send the first message. Previously every click (and every app launch) persisted a session that kimi titles "New Session", so the sidebar filled up with conversations you never had. (Startup and project switching still create eagerly; not touched in this version.)
- Fixed: leftover empty sessions in the sidebar. The old filter passed any untitled session modified in the last 10 minutes, so shells appeared and then vanished on their own. Now only the session this process currently holds is exempt.
- Fixed: the "background commands" chip shimmered as if something were running when nothing was. Tool blocks left at running/pending after a turn ends are stale frames (interrupts, replays with missing frames); foreground tools now only count as running inside a turn.
- Fixed: the session hover preview could stick in the top-left corner when switching sessions — it was only dismissed on the row's `pointerleave`, and switching rebuilds the rows.
- Fixed: opening a session in another project blanked and refilled the whole sidebar list.
- Improved: the hover preview is clamped on all four sides — pushed clear of the sidebar on the left, kept inside the window on the right and bottom.
- Improved: the composer has a visible border when not focused, and a much gentler one when focused (no breathing gradient ring in the minimal style).
- Improved: the empty state has real surfaces again, and the four suggestions are real buttons that fill the composer.
- Improved: the todo and goal bars share the same centered column as AI replies.

## v1.0.44 - 2026-07-30

### 中文

- 变更:**默认界面风格改为简约**。玻璃那套仍在设置 → 外观里,已经选过的不受影响;这一条只改新装机的第一眼。
- 修复:**自动待办催更会连着发**。开了「后台任务结束后自动请求待办更新」之后,同一批任务被反复催,聊天记录里出现一串一模一样的机器发言。防重复只记了「上一次已收尾任务集合」这个字符串,而这个集合会抖动——多一个子 Agent 收尾、服务端清掉过期任务、轮询拿到一份不完整的列表,都会让它与上次不等,于是再催一轮;组件重挂载还会把这个记录清空。现改成按任务 id 记账(每个任务终身只催一次)、每个会话最多催 2 次,主进程再加一道 5 分钟冷却闸——无论上游怎么判,都不可能连着发。
- 优化:简约风下**用户发言与 AI 回复共用一列**。AI 回复是主体,现在整列在页面里居中;用户发言对齐到同一条左右边界,不再顶到最左边、也不再比 AI 那条宽。此前写的 62rem 封顶比实际列宽还大,等于没生效。
- 优化:加粗再降一档。上一版降到 600 并没有用——微软雅黑只有 Regular/Bold 两档,600 按字体匹配规则往上取,落回的还是 700。现改成 500 加提亮到近白,靠亮度而不是字重做强调。
- 优化:待办卡片默认收起。展开着长期占住正文顶部,一屏五六条把正在读的对话往下挤;标题行本身已经写了「已完成 2/5」。
- 优化:删掉输入框上方那个「待办 (n/m)」chip。正文顶部已经常驻一张待办卡片,同一份数据在一屏里出现两次。
- 优化:**切换会话时列表不再重排**。会话按最后修改时间倒序,而打开一个会话就会刷新它的时间戳——于是每切一次,刚点的那条就窜到最上面,其余整体下移,想回上一条得重新找。现在显示顺序在本次运行内保持稳定(置顶项和新建会话仍在最前),重启后回到时间序。
- 优化:侧栏会话按所属分组缩进,组头(项目 / 时间段)从 10px/半透明抬到 11px 加粗并带条目数——此前组头比会话行还淡,从属关系读不出来。
- 优化:侧栏顶部整体压扁,「按时间 / 按项目」并进「最近会话」标题行,省掉一整行,列表可视区更长。

### English

- Changed: **the minimal style is now the default**. Glass is still available under Settings → Appearance, and an explicit existing choice is preserved; this only changes what a fresh install looks like.
- Fixed: **auto todo-nudge fired repeatedly**. With "auto-request a todo update after background tasks finish" enabled, the same batch was nudged over and over, filling the transcript with identical machine-sent messages. Deduplication keyed off a single string of the last settled-task set, which churns (another sub-agent settles, the server prunes an expired task, a poll returns a partial list) — any change re-armed it, and a component remount cleared it entirely. Now tracked per task id (each task nudges at most once ever), capped at 2 per session, with a 5-minute cooldown enforced in the main process.
- Improved: in the minimal style, **user messages and AI replies share one column**. The AI reply is the main body, so the column is now centered in the page, and user messages align to exactly the same left and right edges instead of running to the far left and past the AI's right edge. The previous 62rem cap was wider than the column itself and never applied.
- Improved: bold is lighter again. Dropping to 600 last version did nothing — Microsoft YaHei ships only Regular and Bold, and CSS font matching rounds 600 up to 700. Now 500 plus a near-white color, so emphasis comes from lightness rather than weight.
- Improved: the todo card starts collapsed, and the duplicate "todo (n/m)" chip above the composer is gone.
- Improved: **the session list no longer reorders when you switch sessions**. Opening a session refreshes its timestamp, which pushed it to the top and shifted everything else down. Display order is now stable for the run (pinned and newly created sessions still come first).
- Improved: sessions are indented under their group header, and the header (project or time bucket) is larger, brighter, and shows a count.
- Improved: the sidebar header is more compact — the grouping toggle moved into the "Recent" row, freeing a full row for the list.

## v1.0.43 - 2026-07-30

### 中文

- 新增:界面风格开关(设置 → 外观 → 界面风格),玻璃 / 简约二选一,切换即时生效。默认仍是玻璃。简约风:面板不再描边和投影,分区靠背景深浅;「新建对话」降为次要按钮,强调色收回给「进行中」状态和发送键;你的发言从右侧气泡改为左对齐加一条竖线(贴日志、贴代码时更好读);AI 回复保持居中全宽,只在宽屏下封顶留白。
- 新增:**思考过程整段译成中文**。模型内部推理用什么语言 Tran 控制不了,所以 Kimi 的思考大量是英文——折叠态有中文摘要还好,展开之后就是一屏英文。现在展开时按需翻译(不展开不花这次调用),判据是「CJK 占比 < 15%」而非「有没有英文」,夹几个英文术语的中文思考不会被整段翻。译出来了才给「看原文 / 看译文」切换;失败就安静显示原文。走已实证免费的网页通道,缓存命中 0ms。
- 优化:简约风的八处修补——弹层补回不透明底(此前「子 Agent」「待办」点开是透明的);悬停时间戳改挂右侧留白(左对齐后原位置正好压在正文上);用户发言与 AI 正文统一封顶 62rem;底色从近黑的 #05060A 抬到 #101116(玻璃拆掉后死黑一片,卡片的层次看不出来);连续发言之间补间距;输入框快捷键提示改为聚焦才显示;思考进行中改用流光文字,去掉前面那颗转圈的月亮;思考摘要阈值从 120 字降到 70(120 太高,一屏里常出现「有的有摘要、有的没有」,看着像坏了)。
- 修复:markdown 列表**没有项目符号**。Tailwind 的 preflight 会把 `ul/ol` 的 `list-style` 重置成 none,而样式里只补回了缩进、没补回符号 —— 于是所有分点都塌成「缩进的普通段落」,层级信息全丢。现写回圆点/数字,嵌套层级用不同符号区分。
- 修复:AI 回复的加粗过重。`<strong>` 此前吃浏览器默认的 700,而字体栈里**没有中文字族**,中文回落到系统字体后 700 在深色底上会发胖。降到 600 并禁用合成粗体。

### English

- Added: UI style switch (Settings → Appearance), glass or minimal, applied instantly. Glass remains the default. Minimal drops panel borders and shadows in favor of background steps, demotes the "New chat" button, and renders your own messages left-aligned with an accent rule instead of a right-side bubble (much better for pasted logs and code). AI replies stay centered and full-width, capped only on wide screens.
- Added: **thinking blocks translated to Chinese**. Tran can't control what language the model reasons in, so Kimi's thinking is largely English — fine while collapsed (there's a Chinese summary), unreadable once expanded. Expanding now translates on demand, gated on "CJK ratio < 15%" rather than "contains English", so Chinese thinking with a few English terms is left alone. The original/translation toggle appears only if translation succeeded; failures silently show the original. Runs on the zero-cost web channel; cache hits are instant.
- Improved: eight fixes to the minimal style — opaque backgrounds restored for popovers (the sub-agent and todo chips opened transparent), hover timestamps moved to the right gutter, user messages capped at the same 62rem as AI replies, base background lifted from near-black #05060A to #101116, spacing between consecutive user messages, composer shortcut hints shown only on focus, in-progress thinking uses shimmering text instead of a spinner, and the thinking-summary threshold lowered from 120 to 70 characters.
- Fixed: markdown lists had no bullets. Tailwind's preflight resets `list-style` to none and the stylesheet only restored the indent, so every list collapsed into indented prose and lost its structure.
- Fixed: bold text in AI replies was too heavy — `<strong>` inherited the browser default 700, and with no CJK family in the font stack Chinese fell back to a system font that blooms at 700 on a dark background.

## v1.0.42 - 2026-07-30

### 中文

- 新增:待办不再只等模型推送。会话打开后、每轮结束时、以及开着时每 10 秒,Tran 会直接从 kimi 本地 server 拉待办真值(零 token)。此前待办只有模型跑 turn 且恰好调 todo_list 时才会更新,切走再切回或重启后面板就是空的——这是「待办更新总是不及时」的一半原因。
- 新增:后台任务结束后可自动请求一次待办更新(设置 → 系统,**默认关闭**)。它是一次完整对话轮,实测约 88000 token(约订阅额度的 0.26%),而你下次随便发条消息模型本来就会收到完成通知并更新待办——所以它买到的只是「提前」。开启后每批任务只发一次、只在会话空闲时发,发过会在待办卡片上标明。
- 新增:命令一句话说明与思考块摘要。Kimi 没给 description 的 bash 命令旁边显示用途;思考块折叠时显示一句概括,替代原来的前 60 字截断。按内容哈希落盘缓存,不在流式期间请求。
- 新增:总结类请求默认走 www.kimi.com 的对话通道 —— 实测这条在额度流水里记 FEATURE_CHAT、**扣费为 0**,而 Kimi Code 端点每次约 0.0001。凭证复用「额度明细」那条登录态。该通道会限流,被拒时自动回落,不影响功能。
- 修复:「探测可用型号」把不存在的型号全报可用。Kimi 的 chat 端点不校验 model 值,随便写个名字也回 200(实测连 gpt-4o 和现编的名字都"通"),所以「打得通」证明不了型号存在。现改为先拉服务端 /models 目录,目录之外的标警告且不可选。
- 修复:删除会话时不清理该会话在本地留下的权限档与草稿,日积月累会写满 localStorage 配额,表现为草稿静默存不上。
- 修复:本地存的权限档不校验就重放给后端,老版本留下的值会让后端行为不可预期。
- 修复:额度查询失败时无限回落陈旧缓存 —— 掉登录后额度环会永远显示旧数字且不报错。现在缓存超过 5 分钟就如实报错。
- 修复:AI 生成的短标题会切在词中间(如"压缩 Electron "),标题是长期存盘的,切坏一次就一直难看。
- 优化:删除 301 行无人引用的死代码。

### English

- Added: todos no longer wait for the model to push them. Tran now pulls the authoritative todo list straight from the local kimi server (zero tokens) when a session opens, after each turn, and every 10s while open. Previously todos only changed when the model happened to call `todo_list` during a turn, so the panel was empty after switching sessions or restarting.
- Added: optional auto-request for a todo update after a background task finishes (Settings → System, **off by default**). It costs a full conversation turn — measured at ~88,000 tokens (~0.26% of the subscription) — and your next message would have updated the todos anyway, so it only buys you "sooner". When on, it fires once per batch, only while the session is idle, and is labeled on the todo card.
- Added: one-line explanations for bash commands, and summaries for thinking blocks. Cached to disk by content hash; never requested during streaming.
- Added: summary requests now default to the www.kimi.com chat channel — measured as **zero-cost** in the balance ledger (recorded as FEATURE_CHAT), versus ~0.0001 per call on the Kimi Code endpoint. Reuses the existing quota-panel login. Falls back automatically when rate-limited.
- Fixed: "probe available models" reported every candidate as available. Kimi's chat endpoint does not validate the `model` value (even `gpt-4o` and a made-up name return 200), so a successful call proves nothing. It now reads the server's `/models` catalog first.
- Fixed: deleting a session left its permission mode and draft in localStorage forever, eventually exhausting the quota and making drafts silently fail to save.
- Fixed: stored permission modes were replayed to the backend without validation.
- Fixed: quota lookups fell back to a stale cache indefinitely — after a logout the usage ring would show old numbers forever without erroring.
- Fixed: AI-generated short titles could be cut mid-word.
- Changed: removed 301 lines of unreferenced dead code.

## v1.0.41 - 2026-07-29

### 中文

- 修复:思考中动画（彗星/转圈）被流式渲染 remount 反复重置回第一帧的问题,动画现在连续播放不卡顿。
- 优化:消息时间戳改为悬停显示,不再每条消息常驻占用视觉空间。
- 新增:Diff 视图行内高亮与行号;附件缩略图预览。

### English

- Fixed: the thinking animation (comet/spinner) was remounted by streaming renders and kept resetting to its first frame; it now plays continuously.
- Changed: message timestamps now show on hover instead of on every message.
- Added: inline highlight and line numbers in the diff view; attachment thumbnails.

## v1.0.40 - 2026-07-29

### 中文

- 修复:设置读取瞬时失败会把空配置覆写回真实文件(#51)。readFileSync 与 JSON.parse 共用一个 catch,任一失败都退回空默认值并写进 cache,随后任意一次保存就把 providers/projects/apiKey/百度密钥永久抹掉。Windows 上杀软占用文件即可触发。现区分「文件不存在」与「读取失败」,读失败时拒绝落盘并先重试读取。
- 修复:MCP 配置解析失败时把 ~/.claude.json 整个覆写(#52)。读-改-写里解析失败返回 {},随后写入把整个文件替换成只剩 mcpServers——与模块自己的注释直接矛盾。现解析失败抛错、放弃写入。
- 修复:AcpClient 可掀掉主进程(#53)。close() 只设 closing 不设 closed 也不置空 child,而守卫是 (closed || !child),'close' 事件到达前全部放行,数据写进已 kill 的进程 stdin;而 stdin 又没有 'error' 监听,EPIPE 成为未处理流错误直接崩主进程。
- 修复:ACP 子进程退出时不回收、stderr 无限增长(#54)。AgentBridge 新增 dispose(),退出时 kill 子进程;stderr 只保留尾部 64KB。
- 修复:六处 JSON store 非原子写入(#55)。新增 atomicWrite.ts(tmp+rename),goals/AI 标题/会话标题/token/凭证不再因写一半崩溃而全量丢失。
- 修复:setWindowOpenHandler 不校验协议就 openExternal(#56)。与相邻的 will-navigate 白名单不一致,file:/smb:/自定义协议都会被交给操作系统。
- 修复:后台会话的流式 delta 抢占前台显示预算(#57)。pending 是单一全局队列,后台 delta 消耗每帧字符预算,后台的任何结构性事件还会 flushAll 把前台缓冲整块倒出,破坏 #8 调好的匀速吐字。现按 sessionId 分流,前台路径逻辑与速率常量零改动。
- 修复:工具卡片在流式期间 remount 丢展开状态(#58)。blocks 含空洞时用过滤后下标做 key,空洞填上后续 key 整体前移。改用过滤前的原始下标。
- 修复:附件不按会话隔离(#59)。A 会话加的附件会跟着 B 发出去;切换时清空并作废在途异步读取。
- 修复:token 过期判定与并发刷新(#60)。expires_at 为数字时 Date.parse 得 NaN 恒判过期,把轮换 refresh_token 转个不停;并发刷新重复消费轮换 token 导致误报「需要重新登录」。
- 修复:kimi-server 反复拉起(#25)。ensureKimiServer 无失败记忆,每次轮询都重新 spawn;ipc.ts 的退避阶梯因 #34 的磁盘回退导致 swarmFailures 恒为 0 而从不启动。现加 5 分钟拉起冷却。
- 修复:冷启动被同步全树遍历阻塞(#18)。sweepOrphanSessionDirs 排在 createWindow() 之前,移到之后并 setImmediate 让出一轮。
- 修复:MCP 面板与 WSL 面板完全没有返回入口(#35),补吸顶返回栏。
- 修复:运行中发送消息不回底(#36)。已修的是直发路径,但 turn 忙时消息进 pendingQueue、items 不变,effect 不触发——而排队正是运行中发送的默认路径。
- 修复:健壮性与泄漏合集 14 条(#61)——swarm 定时器不 unref、init 看门狗从不取消、后台会话 Map 无上限增长、历史缓存 LRU 从未实现、切会话漏重置 slashCommands、乐观移除失败不回滚、updater fd 泄漏与预发布版本比较、git ref 参数注入校验等。
- 新增:待办卡显示陈旧度与「后台任务已结束」提醒。kimi 源码实证:后台任务的完成通知只在「下一轮」注入 agent(原文 "The completion arrives automatically in a later turn"),所以发下一条消息之前待办物理上不会更新。Tran 靠磁盘任务记录比 agent 先知道,现在把这个时间差告诉用户,不自动发消息。
- 新增:Kimi Code CLI 版本检查(设置→系统)。查本机 `kimi --version` 对比 npm 最新版,给出升级命令并支持复制。刻意不自动安装——升级要重连 ACP,正在跑的对话会断。

### English

- Fixed: a transient settings read failure overwrote the real config with defaults (#51) — `readFileSync` and `JSON.parse` shared one catch, so any failure fell back to empty defaults *and cached them*; the next save then wiped providers/projects/apiKey permanently. Now distinguishes "missing" from "unreadable" and refuses to persist after a read failure.
- Fixed: MCP config save clobbered all of `~/.claude.json` when the file was momentarily unparseable (#52).
- Fixed: AcpClient could take down the main process (#53) — `close()` left the write guards open until the async `'close'` event, and `child.stdin` had no `'error'` listener, so EPIPE became an unhandled stream error.
- Fixed: the ACP child process was never killed on quit; stderr grew unbounded (#54).
- Fixed: six JSON stores used non-atomic writes (#55) — new `atomicWrite.ts` (tmp+rename).
- Fixed: `setWindowOpenHandler` called `openExternal` with no protocol allowlist (#56), inconsistent with the adjacent `will-navigate` guard.
- Fixed: background-session stream deltas consumed the foreground display budget, and background structural events dumped the foreground buffer in one slab (#57), undoing the #8 pacing work. Now routed per session; the foreground path and rate constants are unchanged.
- Fixed: tool cards remounted mid-stream and lost their expanded state (#58) — keys used the post-filter index over a sparse array.
- Fixed: composer attachments were not scoped per session (#59).
- Fixed: numeric `expires_at` always parsed as expired, and concurrent refreshes double-spent the rotating refresh token (#60).
- Fixed: kimi-server was re-spawned on essentially every poll (#25) — `ensureKimiServer` had no failure memory, and the existing backoff never engaged because the #34 disk fallback kept the poll "successful".
- Fixed: cold start blocked on a synchronous full-tree sweep (#18); MCP/WSL panels had no back button at all (#35); sending while a turn was running did not re-pin to bottom (#36).
- Fixed: 14 robustness and leak issues (#61).
- Added: todo card staleness indicator and a "background task finished" notice. Per kimi's own source, background completions are only injected "in a later turn", so the todo genuinely cannot update until you send another message — Tran knows sooner (disk task records) and now says so, without sending anything on your behalf.
- Added: Kimi Code CLI version check (Settings → System). Check-only by design — upgrading restarts the ACP connection and would kill a running turn.

#### 验证

- `npm run typecheck` 与 `npm run build` 全绿
- 运行时行为未验证(审查环境为 Linux 容器,应用为 Windows 专用)——本版建议先小范围验证

## v1.0.39 - 2026-07-29

### 中文

- 修复:正文流式仍卡顿(#8 第四轮,分型埋点定案)。思考到达 131 字/秒 > 限速 110(全程有水匀速),正文到达仅 84 字/秒 < 110(缓冲抽空退化跟随阵发)——统一限速对思考有效对正文失效。现分型限速:正文 75 字/秒(略低于平均到达,持续蓄水),思考/工具保持 110。确定性重放实测:正文 257/263 桶恒速、仅 1 次停顿(原 9 次)。埋点同步分型(`__streamProbe.dump()` 可分 thought/text 取数)。
- 修复:导航条高亮偏移与长跳卡闪(#50)。高亮根因:react-virtuoso 的 rangeChanged 上报含 overscan 的渲染范围(顶部多 ~900px)非真实视口——改按 DOM 实际几何计算 + 贴底特判(在底部=高亮最新条);长跳(>40 行)改瞬时定位(原 smooth 边滚边重测高导致卡半途振荡)。真实 1195 条消息会话 CDP 复测:底部高亮正确、长跳 1.8s 一次到位零振荡。

### English

- Fixed: body-text streaming still stuttered (#8, round 4 — per-type instrumentation). Thinking arrives at 131 chars/s (above the 110 cap → always buffered, smooth), body text at only 84 chars/s (below the cap → buffer starves, display follows the bursts). Rates are now per-type: body 75 chars/s (just under average arrival), thinking/tools stay 110. Deterministic replay: 257/263 buckets steady with a single stall (was 9). The probe is per-type too (`__streamProbe.dump()`).
- Fixed: nav-rail highlight offset and janky long jumps (#50). The highlight used virtuoso's overscan-inclusive range (≈900px above the real viewport) — now computed from actual DOM geometry with an at-bottom special case; long jumps (>40 rows) use instant positioning instead of smooth scrolling through re-measurements. Verified via CDP on the real 1195-message session: correct highlight, 1.8s single-shot jumps.

#### 验证

- 吐字:分型埋点 + 到达轨迹确定性重放;导航:真实长会话 CDP 复测三点
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.38 - 2026-07-28

### 中文

- 修复:待办卡状态卡旧帧(#49)。根因:每个用户 turn 结束后紧跟的隐藏轮(/usage、/mcp)会吞掉该轮除 agent_message_chunk 外的一切事件,而后台子代理恰在此时收尾推最后一帧全量 plan——"全部完成"帧被静默吞掉且无补偿,待办卡永远停在旧状态。现 plan 帧(会话级全量、幂等)移出隐藏轮拦截,与 replay 白名单处理一致。
- 修复:chip 流光动效不触发(#46 的实际缺口)——Composer 的 chip 运行中计数没接 #32 的真实状态源(后台子代理恒数不到、计数恒 0)。现 countRunningTools 传入 swarmTasks(磁盘任务记录),后台运行中计数/流光/“N/总数”显示全部生效。

### English

- Fixed: todo card stuck on a stale frame (#49). Root cause: the hidden turns (/usage, /mcp) that run right after every user turn swallow all events except text chunks — and background sub-agents typically finish and push their final full plan frame exactly in that window. Plan frames (session-level, idempotent) are no longer intercepted by hidden turns, matching the replay whitelist.
- Fixed: chip shimmer never triggering (the real gap behind #46) — the composer's chip running-count didn't use the #32 disk-backed task source, so background agents were never counted. countRunningTools now receives swarmTasks, enabling the count, the shimmer, and the "N/total" display.

#### 验证

- typecheck/build 全绿;#49 根因与时序链完整复现论证

## v1.0.37 - 2026-07-28

### 中文

- 修复:跨目录切换会话会真实新建空会话(#47,CDP 复现铁证)。根因:openSessionCrossProject 借道 switchProject,后者无条件 startSession 全新空壳;空壳 session/new 在途时治理跳过删除,永久落盘。现跨项目打开只 setLastProject + openSession(带 targetCwd,attach/重放走原有路径),实测 A→B→A 往返零新增且回程命中后台 attach。
- 新增:用户消息定位导航条(#48,Kimi Web 同款)。对话区右缘一列细条(每条用户消息一节),hover 展开摘要面板(前 24 字,最多 30 条),当前视口消息高亮,点击平滑跳转;跳转与滚动意图体系协调(离开底部阅读,回底自动恢复跟随)。

### English

- Fixed: switching sessions across directories created real empty sessions (#47, reproduced via CDP). Root cause: openSessionCrossProject borrowed switchProject, which unconditionally starts a fresh session shell; the in-flight shell escaped cleanup and persisted. Cross-project open now only sets lastProject and calls openSession with a target cwd — A→B→A round trips create zero new sessions and hit background attach on return.
- Added: user-message navigation rail (#48, Kimi Web style) — a right-edge rail of ticks (one per user message), hover expands a summary panel (24-char previews, up to 30), the in-viewport message is highlighted, and clicking smooth-scrolls to it, integrated with the scroll-intent system.

#### 验证

- #47 CDP 复现修复前后对照(零新增、attach 命中、空壳治理无误删)
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.36 - 2026-07-28

### 中文

- 优化:输入框手动拖拽高度不再持久化(#38 后续)。顶边手柄带隐蔽易误拖,此前误拖一次手动高度即写入 localStorage 永久锁死自动增高(需手动点"恢复自动高度")。现手动高度只在本次运行内生效,重启自动恢复;"恢复自动高度"按钮保留用于当次立即还原。

### English

- Improved: manually dragged composer height is no longer persisted (#38 follow-up). The invisible drag strip made accidental locks permanent via localStorage (requiring a manual "restore auto height" click). Manual height now only lasts for the current run — restart heals it; the restore button remains for immediate recovery.

## v1.0.35 - 2026-07-28

### 中文

- 修复:侧边栏"全部"视图冒出大量莫名空会话/疑似幽灵工作区(#42)。真相:不存在自动注册项目的代码,幻影来自探针/测试目录的脏会话进"全部"视图按 cwd 分组。修复:项目增删改全部改归一化路径比较(正反斜杠重复条根除),空壳会话豁免收窄为仅当前项目 cwd。
- 新增:消息时间戳(#43)。用户气泡右下角与 AI 块末常驻小灰字(今天 HH:mm/昨天 HH:mm/更早带日期,对齐 Kimi Web);历史消息因 ACP 重放无时间字段保持"诚实缺省"不显示。
- 修复:顶部待办条宽度对齐(#44)——#9 收窄工具 bar 时漏了 PlanCard,现同为 max-w-[92%]。
- 新增:历史对话显示粘贴给 AI 的图片(#45)。kimi ACP 重放不回传图片,现发送时按会话存 IndexedDB,历史重放按文本匹配补回附件;缩略图/点击预览/右键菜单全部复用现有路径。局限:纯图片(无文本)消息历史里无法恢复。
- 新增:chip 运行中流光动效(#46)。后台命令/子 Agent/待办 chip 有运行中项时文字紫黄流光扫过(与彗星动画同色系),归零立即静态。

### English

- Fixed: phantom empty sessions / ghost workspace entries in the "All" sidebar view (#42). No auto-project-registration code ever existed — the phantom rows were dirty probe/test sessions grouped by cwd. Project add/remove/rename now uses normalized path comparison (kills slash-form duplicates), and the empty-shell exemption is scoped to the current project.
- Added: message timestamps (#43) — small gray time on user bubbles and at the end of assistant blocks (today HH:mm / yesterday / with date, Kimi Web style); history messages honestly show nothing since ACP replay carries no timestamps.
- Fixed: todo bar width aligned (#44) — PlanCard was missed when tool bars were unified to max-w-[92%].
- Added: pasted images visible in conversation history (#45). ACP replay never returns images, so sent images are stored per-session in IndexedDB and re-attached by text match on replay; thumbnails/preview/context menu reuse existing paths. Limitation: image-only messages (no text) cannot be recovered.
- Added: shimmer animation on chips with running items (#46) — background-command / sub-agent / todo chip text sweeps purple-yellow while anything is running, static again when done.

#### 验证

- typecheck/build 全绿;#42 机制经代码 + git 历史 + 用户 settings 三方验证

## v1.0.34 - 2026-07-28

### 中文

- 修复:流式吐字"快一阵卡一下"根因落定(#8 第三轮,埋点实测)。kimi 后端到达本身就是阵发的(实测平均仅 69 字/秒,瞬时 200~480 后静默 0.2~0.7s,17 秒内 40 次停顿),280 字/秒限速器从不启动、显示=跟随到达;渲染侧证伪(commit <3ms,掉帧 0.2%)。基础速率 280→**110 字/秒**(贴近平均到达),到达快时蓄水、静默时恒速放水,实测输出节奏标准差 11.3→4.6、停顿次数 40→25、停顿总时长 11.4s→9.3s;残余停顿是到达完全中断的物理极限(缓冲放无可放)。另:埋点模块常驻(`window.__streamProbe.dump()`),后续流式体感问题可直接取数。
- 优化:思考动画改彗星环绕(用户选定)——紫黄渐变彗星头绕轨公转(1.2s),conic 拖尾沿切线渐隐、中心区域干净,深浅底各相位离屏目检通过。
- 调查:Kimi Web 的 bash 可读摘要确认为工具调用自带 description(无二次 AI 总结),Tran 已是同优先级;本仓库会话内模型调用将全程携带 description。

### English

- Fixed: "burst then stall" streaming root-caused with instrumentation (#8, round 3). Kimi's arrival is inherently bursty (measured avg 69 chars/s: 200–480 bursts followed by 0.2–0.7s silences, 40 pauses in 17s), so the 280 chars/s limiter never engaged and display simply followed arrival; the render side was exonerated (commits <3ms, 0.2% dropped frames). Base rate lowered 280→**110 chars/s** to track the average arrival — buffering fills during bursts and drains at a constant rate through silences. Measured: cadence SD 11.3→4.6, pauses 40→25, dead time 11.4s→9.3s; residual stalls are the physical limit of arrival fully stopping. A lightweight probe ships in builds (`window.__streamProbe.dump()`) for future diagnostics.
- Improved: thinking animation is now a comet (user-selected) — a purple-yellow comet head orbiting with a fading conic tail, clean center, verified across phases on dark/light backgrounds.
- Investigation: Kimi Web's readable bash labels are the tool call's own description (no secondary AI summarization) — Tran already shares that priority; model calls in this repo's sessions will now always carry descriptions.

#### 验证

- 流式埋点复测:节奏 SD 11.3→4.6,掉帧 14→1;彗星 4 相位 × 深浅底目检
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.33 - 2026-07-28

### 中文

- 修复:长 turn 被 15 分钟硬超时掐断(#41)。用户轮 session/prompt 不再设硬超时,改为静默监督:turn 期间任何事件(含权限/fs 请求)重置活跃计时;纯静默 15 分钟提示"已 X 分钟无响应 [继续等待][打断]"(决定权给用户,每 15 分钟复读);纯静默 2 小时才自动 cancel 兜底(僵尸恢复由 cancel+retry 兜着)。忙碌态显示 mm:ss 运行计时;后台会话同样收得到告警。隐藏轮(/usage、/mcp)与握手超时保持原样。
- 优化:流式吐字改严格匀速(#8 二次反馈)。按时间计费(非帧计费,120Hz 高刷屏不再速率翻倍)恒定 280 字/秒;积压 <800 字只起缓冲不变速,超限线性渐进加速(上限 1800 字/秒防猛倒)。实测稳态 264~303 字/秒(±6%),无"一坨+停顿"。
- 修复:markdown 中 data: URL 图片渲染为破图(#26-1)——react-markdown v10 默认协议白名单不含 data:,现放行 `data:image/*`(其余协议仍按默认过滤)。
- 修复:kimi web 实例发现的时间戳解析恒 NaN(started_at/heartbeat_at 是 epoch ms 数字被按字符串解析),兼容数字/字符串两种形态。
- 排查:丢壳后疑似静默退出(#26-2)无实锤排除——丢壳日志是正常退出路径的最后动作(果非因),代码链路无 app.quit/close 误触发路径。

### English

- Fixed: long turns killed by the 15-minute hard timeout (#41). User-turn session/prompt no longer has a hard timeout; a stall watchdog now resets on any session event (including permission/fs requests). After 15 minutes of pure silence Tran shows "no response for X min [keep waiting] [interrupt]" (repeating every 15 min); only 2 hours of silence triggers an automatic cancel (zombie recovery still backed by cancel+retry). The busy indicator shows an mm:ss elapsed timer, and background sessions receive stall notices too. Hidden-turn and handshake timeouts unchanged.
- Improved: streaming output is now strictly constant-rate (#8 follow-up). Time-based metering (not per-frame — no more double speed on 120Hz displays) at a steady 280 chars/sec; backlog under 800 chars only buffers, beyond that a linear ramp accelerates (capped at 1800 chars/sec). Measured 264–303 chars/sec (±6%) with no dump-and-pause.
- Fixed: data: URL images rendering as broken (#26-1) — react-markdown v10's default protocol whitelist lacks data:; `data:image/*` is now allowed (other protocols still filtered).
- Fixed: kimi web instance discovery timestamp parsing always NaN (epoch-ms numbers parsed as strings).
- Investigated: the "silent exit after discarding an empty shell" (#26-2) is exonerated — the shell-discard log is the last action of the normal quit path (effect, not cause).

#### 验证

- 匀速:合成高压测试稳态 280 字/秒 ±6%;真实消息链路无猛倒模式
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.32 - 2026-07-28

### 中文

- 修复:子 Agent 面板仍全部"运行中"(#34)。根因:kimi 0.29 的 REST tasks API 只覆盖 web server 托管的会话,ACP 启动的后台任务恒返回空,校正永不命中。现改读磁盘真实记录(~/.kimi-code/sessions/.../agents/main/tasks/,ACP 主代理实时写)与 REST 合并,运行状态与耗时真实可信;server 不可用时也能用磁盘数据降级。
- 修复:Bash 摘要"迟迟不来"(#40)。#30 的 JSON 快照守卫把摘要需要的 command 一并丢弃,权限等待窗口只剩"准备执行…"。现守卫拦截时从流式残片抢救 command/description 实时喂给摘要(权限未批准即显示命令主干);并修复闭合帧把整段输入 JSON 当正文的问题。
- 修复:输入框不自动增高的真相(#38)——顶边有一条贯穿整宽的隐形拖拽手柄带,误拖一次手动高度即永久锁死自动模式,且恢复途径(双击隐形手柄)无任何可见提示。现锁定态显示"恢复自动高度"按钮。
- 优化:思考月亮去斑纹(#37)——纯紫黄渐变球,conic 色盘绕心自转,静态受光/背光保留球体侧视感,无任何斑点。
- 优化:"AI 正在思考中"指示挪到待办 chip 右侧(#39),后台命令/子 Agent/待办三个 chip 位置实测三态纹丝不动。
- 修复:设置/技能/说明/翻译/运营商五个子页面"返回对话"吸顶(#35),滚动任意位置可返回。
- 修复:发送消息自动滚动到底部(#36)——直发/排队落回/自动消息三条路径覆盖,历史重放与子代理转发不误触。

### English

- Fixed: sub-agent panel stuck at "all running" (#34). Root cause: kimi 0.29's REST tasks API only covers web-server-hosted sessions — ACP-launched background tasks always return empty, so the correction never matched. Now reads the on-disk task records (written in real time by the ACP parent) merged with REST; states and durations are real, with disk fallback when the server is down.
- Fixed: Bash summaries "never arriving" (#40). The #30 input-snapshot guard also discarded the command text, leaving "preparing…" for the whole permission-wait window. The guard now salvages command/description from the streaming fragments (summary appears before approval), and the closing frame no longer dumps raw input JSON as the card body.
- Fixed: real cause of the composer not auto-growing (#38) — an invisible full-width drag strip above the input locks a manual height forever with no visible way back. A "restore auto height" button now appears when locked.
- Improved: thinking moon is now a clean gradient sphere (#37) — conic purple-yellow sweep rotating around the center, static lit/shadow sides, no speckles.
- Improved: the "thinking" indicator moved right of the todo chip (#39); the three chips' positions are pixel-stable across states.
- Fixed: back-to-chat headers are sticky in settings/skills/help/translate/providers panels (#35).
- Fixed: sending a message scrolls to bottom (#36) across direct/queued/auto paths, without misfiring on history replay or sub-agent forwards.

#### 验证

- 磁盘任务记录实测:43 个后台任务 ack task_id 零 miss;摘要抢救 9 用例全过;chip 三态坐标实测;月亮 8 相位目检
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.31 - 2026-07-28

### 中文

- 优化:GPU 进程内存大幅下降(起步 898→437MB,-51%;空闲 4 分钟稳定 -39%,零波动)。玻璃拟态的 filter/screen-blend 离屏表面剥除(Vulkan 简化样式推广为默认,玻璃质感变素),并重新启用窗口遮挡停帧。
- 修复:kimi-server 起不来——kimi 0.29 移除了 `kimi server run`,迁移到 `kimi web --no-open`(新实例发现机制 + pid 存活校验),stdout 捕获 deprecated 直接判死,轮询改指数退避(15s→5min 封顶),退出时清理进程树。swarm/子代理状态轮询恢复。
- 修复:Ctrl+S(打断并发送)吞消息。直达发送的消息从未入队,撞僵尸 turn 失败后彻底悬空;现加未确认台账,失败自动回收到待重发队列,Ctrl+S 在输入框为空但有待发消息时直接重发。
- 修复:子 Agent 面板状态不可信。后台 agent 的运行中状态/耗时改由 kimi server 轮询按 taskId 校正(此前是启动时的静态猜测);悬挂工具块在 turn 结束/历史重放时统一封口为已停止。
- 修复:Bash 工具卡片显示流式输入 JSON 残片(kimi 在输入未闭合时把输入快照当输出推流),现拦截该快照并加"准备执行…"兜底。
- 新增:输入框草稿按会话持久化(localStorage),切视图/切会话/重启不丢,发送即清(附件不持久化)。
- 修复:检查更新/下载更新不走代理(Node 裸连 GitHub),改用 Electron net 模块走 Chromium 网络栈(自动遵循系统代理),代理环境下实测下载安装器通过。
- 优化:思考月亮再改版——紫黄渐变球体(左上受光/右下背光的侧视体积感),球面月海斑纹无缝平移表现自转(1.8s/圈),14px 下各相位目检均为一颗完整小球。

### English

- Improved: big GPU memory reduction (898→437MB at startup, -51%; stable -39% over 4 idle minutes with zero drift). The glass filter/screen-blend offscreen surfaces are removed (Vulkan simplified styles promoted to default — flatter frosted look), and native window-occlusion throttling is re-enabled.
- Fixed: kimi-server never coming up — kimi 0.29 removed `kimi server run`; migrated to `kimi web --no-open` (new instance discovery + pid liveness checks), deprecated output now fails fast, polling uses exponential backoff (15s→5min cap), and the process tree is cleaned up on quit. Swarm/sub-agent status polling works again.
- Fixed: Ctrl+S (interrupt & send) swallowing messages. Direct-sent messages were never queued and vanished on failure; an ack-ledger now recycles them into the resend queue, and Ctrl+S resends when the input is empty but messages are pending.
- Fixed: sub-agent panel trustworthiness. Background agents' running state and duration are now corrected against kimi server polling by taskId (previously a static guess from launch text); hung tool blocks are sealed as stopped on turn end / history replay.
- Fixed: Bash tool cards showing raw input-JSON fragments (kimi streams input snapshots as output before the input closes); now filtered with a "preparing…" fallback.
- Added: per-session composer drafts persisted to localStorage — survives view switches, session switches, and restarts (attachments excluded).
- Fixed: update check/download ignored proxies (raw Node https); now uses Electron net (Chromium stack, honors system proxy) — verified by downloading an installer through a local proxy.
- Improved: thinking moon reworked again — a purple-yellow gradient sphere (lit/shadowed sides for a 3D globe look) with seamless surface-feature drift for rotation (1.8s/turn), verified across phases at 14px.

#### 验证

- GPU A/B(打包版真实配置):起步 -51%,空闲零波动;kimi web spawn/discover/probe/kill 四段实测;更新走代理实测下载 94MB 安装器
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.30 - 2026-07-28

### 中文

- 修复:"another turn is active"僵尸 turn 自动恢复。所有 session/prompt(用户轮与 /usage、/mcp 隐藏轮)统一走恢复入口:撞 another turn → 自动 cancel → 等 2 秒 → 原样重发,用户无感;重试仍失败才显示错误。同时修复僵尸 turn 的一个产生源(隐藏轮与用户轮并发互撞,现互斥 + busy 跳过)。实测确认 turn 互斥为连接级、cancel 仅对自身连接有效,恢复路径与协议行为对齐。
- 修复:子 Agent 面板状态在切换会话后丢失(运行计数归 0、耗时变"—"、运行中显示完成态)。swarmTasks 与 modePanel 纳入后台缓冲的快照/折叠/attach 恢复链路。
- 优化:后台命令/子 Agent/待办浮层加宽(子 Agent 30rem、其余 24rem),子 Agent 描述改两行截断,可预览完整大意。
- 修复:待办已完成打勾偏移的真根因——动画类 `.tran-check-pop` 的 `display: inline-block` 覆盖了圆圈的 flex 居中(只有已完成项带动画类,所以只有打勾偏);另修 PlanCard 同款问题并统一 SVG 勾选。
- 优化:无 description 的 Bash 调用显示规则化摘要(去 env 前缀/管道重定向截断/git 剥配置噪声/curl 聚焦目标 URL),不再是整段裸命令。

### English

- Fixed: automatic recovery from "another turn is active" zombie turns. All session/prompt calls (user turns and hidden /usage, /mcp turns) go through a recovery path: on the error, Tran cancels, waits 2s, and retries the original payload — invisible to the user; only a second failure surfaces an error. Also fixed a zombie-turn source (hidden turns racing user turns; now mutually exclusive with busy guards). Verified empirically that turn exclusivity is per-connection and cancel only affects the owning connection.
- Fixed: sub-agent panel state lost across session switches (running count reset, durations gone, running shown as done). swarmTasks and modePanel are now folded into the background-session snapshot/fold/attach pipeline.
- Improved: wider popovers for background commands / sub-agents / todos (30rem for sub-agents, 24rem others) with two-line description clamping.
- Fixed: real root cause of the off-center todo check — the `.tran-check-pop` animation class's `display: inline-block` overrode the circle's flex centering (only completed items have the class, hence only they were off); PlanCard had the same bug and now shares the SVG check.
- Improved: Bash calls without a description now show a rule-based summary (env prefixes stripped, pipes/redirects truncated, git config noise removed, curl focused on the target URL) instead of the raw command.

#### 验证

- ACP 跨连接实验:turn 互斥为连接级、跨连接 cancel 无效、load 不转发实时流(`.scratch/acp-turn-ownership/`)
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.29 - 2026-07-28

### 中文

- 修复:图标底部月壤纹理偏弱。v1.0.26 的修斑压暗区延伸过深误伤底部纹理带(亮度 71.5→46.0),现压暗区收敛回 T 竖笔正下方、新增底部提亮通道,量化指标对齐 Kimi 桌面版(meanLum 76.1 vs 72.4,高亮覆盖率 8.9% vs 8.0%),底部纹理饱满贴底。
- 优化:额度悬浮卡数据源切换为 RPC 精确值(两位小数):月度额度(原"总额度",含 Kimi Code 分项与重置时间)、5 小时额度、每周额度;沿用 60s 缓存,悬停卡秒开。token 用量与上下文窗口展示不变。额度明细弹层精简为只含加油包卡片与使用明细列表。
- 优化:思考月亮动画改实心月盘——紫黄渐变圆盘 + 外发光 + conic 高光扫带旋转,14px 下清晰可辨,读作"月光扫过月面"(旧抠瓣新月方案在小尺寸下像两轮新月对转)。

### English

- Fixed: weak bottom regolith texture in the icon. v1.0.26's de-smudge dimming reached too deep into the texture band (luminance 71.5→46.0); the dim zone is now confined to under the T stem and a bottom brighten pass was added, matching the Kimi desktop icon's measured profile (meanLum 76.1 vs 72.4).
- Improved: usage hover card now reads precise two-decimal RPC data — monthly quota (formerly "total", with Kimi Code sub-figure and reset time), 5-hour and weekly quotas; same 60s cache so the card still opens instantly. Token/context displays unchanged. The quota detail panel now only shows the booster wallet card and the usage-action list.
- Improved: thinking moon is now a solid disc — purple-yellow gradient with outer glow and a rotating conic highlight sweep, crisp at 14px (the old crescent-cut design read as two thin crescents).

#### 验证

- v1.0.28 打包版 12 项冒烟自检全部通过(独立 profile + CDP 驱动)
- 图标 256 档与 Kimi 母版并排目检;月亮动画离屏渲染多相位目检
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.28 - 2026-07-27

### 中文

- 修复:最大化/还原按钮"疑似失效"。功能层本来正常,但标题栏按钮永远显示"最大化"图标、状态完全不可见(含双击标题栏原生切换也不同步)。现按钮在最大化/还原图标间切换,窗口原生事件同步转发。
- 新增:"启动时最大化"设置项(设置 → 系统),创建窗口时直接最大化,无跳变。
- 优化:冷启动不再被 where.exe 阻塞。kimi 命令解析原来在启动关键路径上串行 spawnSync 最多 3 次(实测单次 ~84-150ms 卡死事件循环),改为异步并发 + Promise 缓存。启动耗时构成分析:Chromium 加载 1.1s(dev)、kimi ACP 自身启动 ~1.5s(不可优化),Tran 侧主进程工作 <50ms。
- 优化:历史查询连接的 kimi acp 进程(~300MB)原为常驻——TTL 只在下次查询时惰性判断。现空闲 30 秒主动回收,再查自动重建,内存 footprint 明显下降。
- 新增:对话内图片右键菜单(AI 输出图、用户附件、预览大图):复制图片、另存为 PNG,覆盖 data:/http(s):/file:/blob: 各形态。
- 分析:内存构成测量(#19)——两个 kimi acp 各 ~300MB 是大头(kimi CLI 自身足迹),Electron 侧主进程 120MB/渲染 139MB;`kimi server run` 守护进程为 kimi 系共享设计,Tran 退出后常驻(kimi desktop/CLI 复用),未改动。

### English

- Fixed: maximize/restore button "seemingly dead". The toggle worked, but the titlebar button always showed the maximize glyph with no state feedback (even native double-click toggles didn't sync). The button now switches between maximize/restore icons, driven by forwarded window events.
- Added: "maximize on startup" setting (Settings → System), applied before first show.
- Improved: cold start no longer blocked by where.exe. Kimi command resolution did up to 3 serial spawnSync calls (~84–150ms event-loop stalls) on the startup path; now async, concurrent, and Promise-cached. Startup breakdown: Chromium load 1.1s (dev), kimi ACP boot ~1.5s (not ours to optimize), Tran main-process work <50ms.
- Improved: the history-query kimi acp process (~300MB) used to stay resident — TTL was only checked lazily on next query. It is now actively reaped after 30s idle and rebuilt on demand.
- Added: image context menu in conversations (AI output, user attachments, preview pane): copy image, save as PNG; handles data:/http(s):/file:/blob: sources.
- Analysis: memory profile (#19) — the two kimi acp processes (~300MB each) dominate (kimi CLI's own footprint); Electron main 120MB / renderer 139MB; the `kimi server run` daemon is a shared kimi-ecosystem design (persists after exit), left as-is.

#### 验证

- CDP 驱动独立实例实测:最大化切换/启动最大化/历史进程 30s 回收重建/内存构成
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.27 - 2026-07-27

### 中文

- 新增:紫黄旋转月亮思考动画(纯 CSS,无依赖)。思考块、"输出中…"、"Tran 正在处理…"、输入区忙碌提示四处呼吸点统一替换为 Kimi Web 同款旋转新月;遵循 prefers-reduced-motion。
- 优化:后台命令/子 Agent 浮层改造。最新条目在前、运行中置顶并高亮;默认只显示活跃项 + 最近 8 条,历史归档为"查看全部"折叠;子 agent 与 Bash 条目优先显示可读意图(description/prompt),裸命令收进展开详情。
- 修复:新建会话落错目录。根因是启动项目匹配用裸 === 比较路径——session/list 写回的正斜杠路径与项目列表的反斜杠永不匹配,回退到列表第一项(恰好是用户目录)。现统一归一化比较(含 ProjectSwitcher 高亮/去重/删除判定)。
- 新增:MCP 状态条。会话上方显示各 MCP server 名称、连接状态、transport、工具数(如"yuque · connected · 19 tools (stdio)"),带刷新按钮;经隐藏 /mcp 轮获取(本地直返不耗 token),打开会话自动查询、pending 自动补查。
- 新增:查询类斜杠命令(/usage、/status、/mcp)输出不再混入对话流,改渲染为可折叠的状态卡片。
- 优化:会话 AI 自动命名升级。首轮结束仍用首条消息快速命名;攒够前 3 次真实发言后精修一次标题(只覆盖 AI 标题,手动命名不动),命名更准。

### English

- Added: purple-yellow rotating moon thinking animation (pure CSS, no deps), replacing the breathing dot in thinking blocks, "outputing…", "Tran is processing…", and the composer busy hint; honors prefers-reduced-motion.
- Improved: background-command/sub-agent popovers. Newest first, running items pinned and highlighted; collapsed by default to active + 8 recent with a "show all" archive toggle; sub-agent and Bash rows now show readable intent (description/prompt) instead of raw commands.
- Fixed: new sessions landing in the wrong directory. Root cause: startup-project matching compared paths with bare `===` — the forward-slash path written back from session/list never matched the back-slash project list, falling back to the first entry (the user home). Comparisons are now normalized (including ProjectSwitcher highlight/dedupe/remove).
- Added: MCP status bar above the transcript — per-server name, status, transport, tool count (e.g. "yuque · connected · 19 tools (stdio)") with a refresh button, fetched via a hidden /mcp turn (local, no token cost), auto-queried on session open with pending retry.
- Added: query-type slash commands (/usage, /status, /mcp) render as collapsible status cards instead of chat messages.
- Improved: AI session naming. First turn still names from the first message; after 3 real user messages the title is refined once (AI titles only, manual names untouched).

#### 验证

- kimi acp 0.29 实测:cwd 下发、/mcp 输出解析、多会话并发均通过
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.26 - 2026-07-27

### 中文

- 优化:图标字形体量对齐 Kimi 桌面版。实测 T 的白色覆盖率仅为 K 的一半(2.9% vs 6.1%),且母版竖笔是紫渐变、下半截隐入深色背景(即"竖笔偏短"观感根源)。现扁平档按 K 实测几何重绘(竖笔底对齐、笔画加粗补偿 T 比 K 少两笔斜划,覆盖率 5.4%≈K 的 89%),母版 T 手术换为全白,任务栏/桌面/安装器/应用内图标全套重建;托盘图标保持现状。另修复 touchup 脚本原地回读导致纹理累积压暗的幂等性问题。
- 修复:流式输出吐字僵硬。delta 经 IPC 不均匀成批到达,旧实现每帧全量倾倒导致节奏忽大忽小;现按字符预算匀速滴出(细流保底 6 字/帧,爆发自适应放大,约 50ms 内消化)。
- 修复:流式期间强制下滚。点击/悬停停留在某个内容块上、或滚轮上翻时解除跟随;回到底部附近(阈值 2→40px)恢复跟随,"↓ 最新"按钮显式钉住。
- 修复:流式文本块换行时右侧发虚——块级右缘渐变 mask 作用到了每一行,已移除(流式光标保留)。
- 优化:思考/工具/文本块间距收紧(对齐 Kimi Web 观感);分组工具调用 bar 与其他 bar 等宽。
- 优化:输入框自动增高的上限提到 8~10 行(原有自动扩展机制正常,手动拖拽高度会覆盖自动模式,双击手柄恢复)。
- 修复:关闭英文拼写检查(textarea spellCheck=false + webPreferences 会话级关闭,不再满屏红色波浪线)。

### English

- Improved: icon glyph mass now matches the Kimi desktop icon. Measured white coverage of the T was only half of the K (2.9% vs 6.1%), and the master's gradient stem faded into the dark background (the "short stem" look). Flat renders are redrawn from measured K geometry (stroke widened to compensate for the T's missing diagonal strokes, 5.4% coverage ≈ 89% of K), the master T is now full white, and the whole ICO set is rebuilt; tray icon unchanged. Also fixed the touch-up script's non-idempotent texture darkening.
- Fixed: jerky streaming. Deltas arrive in uneven IPC batches and were dumped whole each frame; output now drips at a steady character budget (min 6 chars/frame, bursts absorbed within ~50ms).
- Fixed: forced scroll-down during streaming. Clicking/hovering a block or wheeling up releases follow; returning near the bottom (threshold 2→40px) resumes it, and the "↓ latest" button pins explicitly.
- Fixed: right-edge blur on wrapped lines in streaming text — a block-level gradient mask applied to every line; removed (stream cursor kept).
- Improved: tighter block spacing (Kimi Web parity); grouped tool-call bars now match other bars' width.
- Improved: composer auto-grow cap raised to ~8–10 lines (auto-grow itself already worked; a manually dragged height overrides it — double-click the handle to reset).
- Fixed: English spellcheck disabled (textarea + session-level), no more red squiggles.

#### 验证

- 图标:ICO 全 10 档逐帧目检,扁平档与 Kimi K 并排体量相当
- 流式:CDP 驱动 dev 实例真实发消息采样,吐字步进均匀无大跳块
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.25 - 2026-07-27

### 中文

- 新增:额度明细面板(对齐 Kimi 网页版"我的额度/使用明细")。用量圆环悬停卡底部新增"额度明细 →"入口,面板内含:总用量(两位小数百分比 + 重置时间,附 Kimi Code 分项)、5 小时/7 天/Code 5 小时/Code 7 天各行用量(百分比 + 重置时间)、额度加油包卡片(开关状态、余额/总额、本月消费/上限)、使用明细逐条消耗记录(标题、时间、消耗百分比,分页加载更多)。
- 数据通路:复用 kimi-desktop 的 MembershipService RPC(JSON over HTTP,原生两位小数精度),登录态优先读取本机 kimi-desktop 的 token 缓存并自动刷新;读不到时兜底弹出 Kimi 网页登录窗(登录一次后本地复用)。token 值不进任何日志。

### English

- Added: quota detail panel (mirrors the Kimi web "My Quota / Usage Details" page). A new "额度明细 →" entry at the bottom of the usage-ring hover card opens a panel with: total usage (two-decimal percentage + reset time, with the Kimi Code sub-figure), 5-hour / 7-day / Code 5-hour / Code 7-day windows, booster wallet card (status, balance/total, monthly spend/limit), and a paged per-action consumption list.
- Data path: reuses kimi-desktop's MembershipService RPC (JSON over HTTP, native two-decimal precision). Auth prefers the local kimi-desktop token cache with automatic refresh; falls back to an embedded kimi.com login window (one-time, reused locally). Token values never touch logs.

#### 验证

- 三个 RPC 端点(GetSubscriptionStats / ListBalanceActions / token refresh)均用真实 token 实测通过;明细分页 pageToken 翻页正常
- `npm run typecheck` 与 `npm run build` 全绿

## v1.0.24 - 2026-07-27

### 中文

- 修复:ACP 超时后的连锁故障。session/prompt 超时(长任务/阻塞型子代理)此前只丢弃请求——agent 侧 turn 继续空跑、迟到响应被静默丢弃,后续消息易撞"上一轮仍在进行中"。现超时后主动向该会话补发 session/cancel;并修复 initialize 失败时 kimi acp 进程泄漏(反复重试会堆积多个 nodejs 进程)。
- 修复:会话列表"冻结"。侧边栏历史列表走一条长期存活的独立 ACP 进程,其内部快照过期后 Tran 没有失效机制(手动杀进程后反而能刷新一次)。现历史连接空闲 30 秒自动重建,外部(Kimi Web 等)新会话最多延迟 30 秒可见。
- 新增:后台续跑。切换会话不再取消正在进行的 turn——切走的会话在后台继续处理,侧边栏实时显示运行中标识,切回时直接接续流式输出(同连接多会话并发已经实测验证)。
- 新增:侧边栏会话列表显示"运行中"呼吸点;输入区在 AI 输出中显示明确忙碌提示与已排队条数。
- 修复:turn 报错后会话卡死在"输出中"。现正确复位运行状态,排队消息可一键重发或清空。
- 新增:报错横幅与错误诊断面板可手动关闭。
- 修复:会话历史缓存把空数组当有效命中的隐患。

### English

- Fixed: cascade failures after ACP timeouts. A timed-out session/prompt (long tasks, blocking subagents) used to just drop the request — the agent-side turn kept running, late responses were silently discarded, and follow-up messages hit "another turn in progress". Tran now sends session/cancel after a timeout, and initialize failures no longer leak kimi acp processes (retries used to pile up nodejs processes).
- Fixed: "frozen" session list. The sidebar history list used a separate long-lived ACP process whose internal snapshot went stale with no invalidation (killing it was the only refresh). The history connection now rebuilds after 30s idle, so external sessions (Kimi Web etc.) appear within 30 seconds.
- Added: background continuation. Switching sessions no longer cancels the in-flight turn — sessions keep processing in the background, the sidebar shows a live running indicator, and switching back reattaches to the stream (concurrent multi-session turns on one connection verified empirically).
- Added: running badge (breathing dot) on sidebar session items; the composer now shows an explicit busy hint with queued-message count while the AI is streaming.
- Fixed: sessions stuck in "outputing" state after a turn error. Running state now resets correctly, and queued messages can be resent or cleared.
- Added: error banner and diagnostic panel can be dismissed manually.
- Fixed: session history cache treating an empty array as a valid hit.

#### 验证

- `npm run typecheck`(node + web 双 tsconfig)与 `npm run build`(main/preload/renderer)全绿
- ACP 同连接多会话并发 turn 实测:真并行、通知带 sessionId 可路由(`.scratch/acp-concurrency-test`)

## v1.0.23 - 2026-07-23

### 中文

- 优化:图标"修斑"。kimi 克隆图标的月壤纹理在 T 竖笔正下方有一片亮颗粒,任务栏小尺寸下糊成一坨白渍(与 Kimi 桌面版对比明显,其纹理紧贴底边)。现调暗 T 下方区域的亮颗粒(羽化过渡,纹理整体上移出字母周围),并保持底边纹理带不变。
- 优化:ICO 改为尺寸自适应——16~48px 使用无纹理扁平渲染(黑底 + 白 T + 紫点,小尺寸零污渍);64~256px 使用修斑后的纹理母版高质量缩小。任务栏、桌面、安装器图标在小尺寸下彻底干净。
- 新增:`scripts/touchup-icon.ps1` 图标修斑/重建脚本,可重复执行。

### English

- Improved: icon "de-smudge". The regolith texture in the Kimi-clone icon had a bright grain clump right under the T stem, which blurred into a white smudge at taskbar sizes (unlike the Kimi desktop icon, whose texture hugs the bottom edge). The bright grain under the T is now dimmed with a feathered falloff; the bottom texture band is unchanged.
- Improved: size-adaptive ICO — 16–48px entries render a texture-free flat design (near-black tile, white T, purple dot) so small sizes are spotless; 64–256px entries downscale the touched-up textured master.
- Added: `scripts/touchup-icon.ps1` to re-apply the touch-up and rebuild the icon set.

#### 验证

- 母版与 ICO 各尺寸逐项目检(48px 扁平干净,128px 纹理贴底)

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
