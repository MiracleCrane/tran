# [P0] AcpClient 向已 kill 的进程写 stdin 且无 error 监听，可掀掉主进程

标签：`bug` `P0`

## 根因

两个缺陷叠加成一条崩溃路径。

### 1. `close()` 不设 `closed`、不置空 `child`

`cli/src/main/agent/AcpClient.ts:135-139`：

```ts
close(): void {
  this.closing = true      // ← 只设了这个
  this.child?.kill()
  this.rejectAll(...)
}
```

而 `write()`（:234）与 `request()`（:93）的守卫是：

```ts
if (this.closed || !this.child) throw ...
```

`'close'` 事件是**异步**到达的。在它到达之前，`closed` 仍是 `false`、`child` 仍非空，守卫**全部放行** —— 数据被写进刚 kill 的进程 stdin。

### 2. `child.stdin` 没有 `'error'` 监听

`spawn()`（:146-170）给 `stdout` / `stderr` / `child` 都挂了监听，**唯独 stdin 没有**。往断开的管道写触发 EPIPE，Node 以 stdin 的 `'error'` 事件异步投递 —— **无监听器的流错误会掀掉 Electron 主进程**。

## 触发场景

agent 进程中途崩溃，在 `'close'` 事件到达前，任一排队的 `notify('session/cancel')` 或 `request` 写入死管道。

## 附带问题

`request()`（:93）在返回 Promise 之前**同步 throw**，绕过调用方的 `.catch()`（`KimiBackend.setModel:332-338`、`setPermissionMode:347-354` 都指望它），一路抛到 `prepareSession`（:722 无 catch）拆掉整个会话。

## 修复方向

1. `close()` 同步置 `closed = true` 并断开 `child` 引用
2. `child.stdin` 补 `'error'` 监听（记录不抛）
3. 即发即忘路径（`notify`/`respond`/`respondError`）吞掉写入异常 —— 进程已退出是正常竞态
4. `request()` 改为返回 rejected promise

## 备注

逐行核对确认，**不依赖运行时猜测**。
完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-03。
