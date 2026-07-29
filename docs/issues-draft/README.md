# 待建 GitHub Issues（2026-07-29 代码审查）

本目录是**待粘贴到 GitHub Issues 的草稿**，不是本地 issue 系统。

审查会话的 GitHub token 只有读权限（创建 issue 返回
`403 Resource not accessible by integration`），因此无法直接建。每个文件一条
issue，标题与正文可直接复制到 GitHub。

建完后本目录可以删掉。

## 清单

| 文件 | 建议标题 | 标签 |
|---|---|---|
| `01-settings-data-loss.md` | [P0] settings.ts 读取瞬时失败会把空配置覆写回真实文件 | `bug` `P0` |
| `02-mcpconfig-clobber.md` | [P0] mcpConfig 解析失败时把 ~/.claude.json 整个覆写 | `bug` `P0` |
| `03-acpclient-crash.md` | [P0] AcpClient 向已 kill 的进程写 stdin 且无 error 监听，可掀掉主进程 | `bug` `P0` |
| `04-acp-child-leak.md` | [P1] ACP 子进程退出时不回收 + stderr 无限增长 | `bug` `P1` |
| `05-atomic-writes.md` | [P1] 六处 JSON store 非原子写入，写一半崩溃即全量丢失 | `bug` `P1` |
| `06-openexternal.md` | [P1] setWindowOpenHandler 不校验协议就 openExternal | `bug` `P1` |
| `07-stream-budget.md` | [P1] 后台会话的流式 delta 抢占前台显示预算 | `bug` `P1` |
| `08-transcript-key.md` | [P1] Transcript 用过滤后下标做 key，流式期间工具卡片 remount | `bug` `P1` |
| `09-attachment-leak.md` | [P1] 附件不按会话隔离，切会话后串到别的会话 | `bug` `P1` |
| `10-token-refresh.md` | [P1] token 过期判定与并发刷新缺陷 | `bug` `P1` |
| `11-mcp-write-path.md` | [P0] MCP 写入路径疑似与 Kimi 后端不通（加了没反应） | `bug` `P0` |
| `12-misc-robustness.md` | [P2] 健壮性与泄漏合集（12 条） | `bug` `P2` |

## 相关

- 完整审查报告：`docs/CODE-REVIEW-2026-07-29.md`
- 修复分支：`claude/software-testing-code-review-koli26`
- **注意**：#11 是唯一未修复的（需要产品决策），其余已在分支上修复
