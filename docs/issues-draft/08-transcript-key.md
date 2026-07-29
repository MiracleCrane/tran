# [P1] Transcript 用过滤后下标做 key，流式期间工具卡片 remount

标签：`bug` `P1`

## 现象

流式输出过程中，已展开的工具卡片突然收起、或展开状态跑到了别的卡片上。

## 根因

`Transcript.tsx:427-429`：

```tsx
item.blocks.filter((b) => !!b).map((block, i) => ... key={i})
```

`blocks` 在流式期间含 `undefined` 空洞（子代理事件交错，文件头 :66-69 注释自己写了）。用**过滤后**下标做 key，空洞被填上时后续 key 整体前移：

```
blocks = [text, <hole>, tool]  → 过滤后 key: 0(text), 1(tool)
hole 填入 thinking             → 过滤后 key: 0(text), 1(thinking), 2(tool)
                                          ↑ key=1 从 tool 变成 thinking
```

React 认为是不同元素 → 工具卡片在 key=2 重新挂载，`ToolCallCard`/`ThinkingBlock` 的展开状态（`userToggled`）、滚动位置丢失或错位。

## 修复方向

改用**过滤前**的原始下标（先 `map` 成 `{block, index}` 再 filter），或用 `block.toolUseId` 等稳定标识。

## 备注

完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-09。
