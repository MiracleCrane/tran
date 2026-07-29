# [P2] 健壮性与泄漏合集（12 条）

标签：`bug` `P2`

代码审查发现的潜伏型问题，单条影响有限，集中记录。完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-14 ~ F-27。

## 渲染层

| # | 位置 | 问题 |
|---|---|---|
| 1 | `Composer.tsx:760` | 回车/上下键不判断输入法组词。**注：实测非活 bug** —— 真实 Windows 输入法确认候选词时 Chromium 派发 `key:"Process"`/`keyCode:229`，不命中 `'Enter'` 分支。仅作防御补齐 |
| 2 | `sessionStore.ts:871-876` | 后台会话全在跑时 `find(!running)` 返回空 → `break` → Map 无上限增长，每个缓冲还在持续累积 items |
| 3 | `sessionStore.ts:283` | `sessionHistoryCache` 的 `lastTouched` 一直写但从不用于淘汰，只能靠外部 `pruneSessionHistoryCache` 收缩 |
| 4 | `sessionStore.ts` ×4 | 切会话四条路径漏重置 `slashCommands`（`planEntries`/`contextUsage`/`mcpServers`/`goal`/`elicitationQueue` 都重置了，唯独它没有）→ 上个会话的斜杠命令残留 |
| 5 | `sessionStore.ts:1282-1298` | init 看门狗 60s 定时器从不取消，快速切会话会攒一堆（有守卫不会误触发，但闭包白留 60s） |
| 6 | `sessionStore.ts` ×2 | `answerElicitation`/`respondPermission` 乐观移除后 IPC 失败不回滚 → 卡片消失但 turn 仍在等一个用户再也给不了的回复 |

## 主进程

| # | 位置 | 问题 |
|---|---|---|
| 7 | `ipc.ts:800-852` | swarm 轮询定时器不 `unref`，窗口销毁/重载/隐藏到托盘时都不停，会一直自我续期 |
| 8 | `updater.ts:206-209` | 下载流出错时 `createWriteStream` 未 destroy → fd 泄漏；Windows 上句柄没关会让 `unlinkSync` 失败，残留半个 exe |
| 9 | `updater.ts:35-45` | `normalizeVersion` 把 `1.2.0-beta` 与 `1.2.0` 视为相等 → 预发布升正式版判定为「无更新」 |
| 10 | `KimiBackend.ts:211-223` | `error` 为 null/非对象时取 `.data` 抛 TypeError，掩盖原始错误 |
| 11 | `KimiBackend.ts` | `handleClientClose` 不停 stall 定时器（要等下次 60s tick 自检）；`session/new` 在途被关闭时 `pendingNotifications` 条目永久残留 |
| 12 | `kimiServerApi.ts:204` | `/error/i` 会命中任何含 "error" 的输出（`0 errors`、含 error 的警告、URL），误杀已启动的 server |
| 13 | `git.ts` ×4 | ref 名以 `-` 开头会被 git 当选项解析（参数注入，非 shell 注入 —— `spawn` 不经 shell） |
| 14 | `ipc.ts` | 项目路径入参未校验类型（`path.trim()` 对非字符串抛 TypeError）；导出诊断报告的 `writeFileSync` 无保护（同级 `saveImageAs` 有） |

## 关于 #13 的一个反面记录

最初的修复方案是加 `--` 分隔符。**实测（git 2.43）发现会直接改坏功能：**

```
$ git checkout -- feature
error: pathspec 'feature' did not match any file(s) known to git
```

`git checkout -- <name>` 语义是「从索引恢复该路径的文件」，不是切分支。
`--end-of-options` 在 `branch`/`revert` 可用，但 `checkout` 不支持。

最终方案是**校验入参**（拒绝 `-` 开头），这是唯一对所有子命令都安全的做法。

这条记录值得留着：看起来正确的安全加固也可能引入功能回归。
