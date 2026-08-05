# Changelog

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
