# [P1] 六处 JSON store 非原子写入，写一半崩溃即全量丢失

标签：`bug` `P1`

## 根因

以下位置全是裸 `writeFileSync`，无 tmp+rename：

| 文件 | 行 | 丢失内容 |
|---|---|---|
| `mcpConfig.ts` | 35-37 | `~/.claude.json` 全部 |
| `goalStore.ts` | 46-54 | 全部 goals |
| `aiTitles.ts` | 50-57 | 全部 AI 标题 |
| `sessionTitles.ts` | 35-37 / 52-54 / 82-87 | 全部会话标题（含手动重命名） |
| `quotaService.ts` | 75-88 | 额度 token |
| `usageService.ts` | 98 | OAuth 凭证 |

写入中崩溃/断电 → JSON 截断 → 下次 `load()` 命中 catch → **静默重置为 `{}`**。

自恢复（不崩），但数据没了。

## 修复方向

统一改 tmp+rename。**`sessionDelete.ts:80-82` 已经是正确写法：**

```ts
const tmp = `${indexPath()}.tmp`
writeFileSync(tmp, ..., 'utf8')
renameSync(tmp, indexPath())
```

建议抽成公共工具（同目录 tmp —— 跨盘 rename 会退化成非原子的复制+删除）。

## 备注

完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-06。
