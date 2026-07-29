# [P1] ACP 子进程退出时不回收 + stderr 无限增长

标签：`bug` `P1`

## 现象（用户可自行验证）

关闭 Tran 后，任务管理器里是否残留 kimi 进程？长时间开着一个会话，主进程内存是否持续上涨？

## 根因 1：子进程从不被 kill

`AcpClient.close()` 只在 `spawn()` 的初始化失败分支被调用（`AcpClient.ts:184`）。

- `KimiBackend.close(sessionId)`（:356-370）—— 只做会话级清理 + 发 `session/cancel`
- `AgentBridge.shutdown()`（:154-158）—— 只逐个 `close(sessionId)`
- `handleClientClose()` —— 只把引用置空

**没有任何路径 kill 子进程。** Windows 上子进程不随父进程退出而回收。

## 根因 2：stderr 无限累积

`AcpClient.ts:69, 155-159`：

```ts
this.stderr += chunk      // 只在 close 时被消费一次，从不裁剪
```

长会话 + 话痨 agent → 主进程堆随 stderr 量线性增长。

## 修复方向

1. `AgentBackendAdapter` 加可选 `dispose()`，`AgentBridge.shutdown()` 在会话清理后逐个调用
2. `KimiBackend.dispose()` 停掉所有 stall 定时器并 `client.close()`
3. stderr 只保留尾部（如 64KB）

## 备注

调用链核对确认。完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-04 F-05。
