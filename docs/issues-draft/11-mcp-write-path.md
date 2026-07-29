# [P0] MCP 写入路径疑似与 Kimi 后端不通（加了没反应）

标签：`bug` `P0`

## 现象（待你确认）

在 Tran 界面添加 MCP server，面板刷新后大概率看不到 —— 因为读写两端不是同一个地方。

## 根因

`cli/src/main/mcpConfig.ts` 的模块注释：

> Persists MCP servers to the same config files **`claude mcp`** uses, since the **Agent SDK** has no API for writing them

这是**旧 Claude 后端的残留**。当前代码库所有路径都指向 `~/.kimi-code/`：

| 用途 | 路径 |
|---|---|
| sessions | `~/.kimi-code/sessions/` |
| credentials | `~/.kimi-code/credentials/kimi-code.json` |
| server token | `~/.kimi-code/server.token` |
| bin | `~/.kimi-code/bin/` |
| **MCP 配置** | **`~/.claude.json`** ← 只有这里不一样 |

`App.tsx` 的 TODO 也印证迁移未完成：

> TODO(providers): 运营商面板深度绑定旧 Claude 后端，kimi-only 阶段入口已隐藏

## 读写不通

| 方向 | 实现 |
|---|---|
| **读** | 跑隐藏 `/mcp` 轮问 Kimi CLI 要列表，缓存进 `session.mcpServers`（`KimiBackend.ts:1013`） |
| **写** | 写 `~/.claude.json`（Kimi 不读） |

写进了 Kimi 不读的文件，面板刷新时又去问 Kimi，自然看不到。

## 验证方法（几分钟）

1. 在 Tran 里添加一个 MCP server，看面板刷新后是否出现
2. 看机器上是否被凭空创建了 `~/.claude.json`（本机不用 claude CLI 的话不该有这文件）

## 为什么还没修

仓库里查不到 Kimi Code 从哪读 MCP 配置（`/mcp` 由 CLI 自己管）。乱改路径会比现状更糟，需要先确认 Kimi Code 的实际配置位置。

确认后的两条路：
- 改写 Kimi 的配置路径
- 或暂时禁用入口并给出说明

## 备注

**这是唯一一条未修复的**（需要产品决策，不是纯技术问题）。
完整报告见 `docs/CODE-REVIEW-2026-07-29.md` Q-01。

关联：#2（同一文件的数据覆写问题）
