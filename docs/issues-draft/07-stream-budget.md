# [P1] 后台会话的流式 delta 抢占前台显示预算

标签：`bug` `P1`

## 根因

`streamBatcher.ts` 的 `pending`（:40）是**单一全局队列**，混装前台与所有后台会话的 delta。而 `applyStreamBatch`（`sessionStore.ts:3002-3023`）会把后台 delta 立即折进各自的离屏缓冲。

两个后果：

### A. 预算被看不见的文字吃掉

后台会话的 delta 排在前台之前，消耗 `drainBudget` 的每帧字符预算 —— 可见文字变慢，而被消耗掉的预算用在了永远不显示的内容上。

### B. 后台事件把前台缓冲整块倒出

后台会话的**任何**非 delta 事件（`tool_progress` / `result` / `system` / `agent:ended`）进入 `pushAgentEvent` 都会触发 `flushAll()`，取消 rAF 并把**前台**缓冲一次性倒出 —— 直接破坏 v1.0.39 刚调好的匀速吐字。

## 修复方向

按 `e.sessionId === meta?.sessionId` 分流：

- 后台 delta 直接 `applyStreamBatch([batch])`（不排队、不计预算、不触发 rAF）
- 后台结构性事件不再 `flushAll()`（不同会话状态独立，顺序按会话保证）
- **前台路径逻辑与速率常量保持零改动**

## 备注

⚠️ 这条落在 #8 四轮调优的成果上，改动需要对照 `__streamProbe.dump()` 复测前台节奏。
逻辑推导确认，**未实测观感影响**。
完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-08。

关联：#8
