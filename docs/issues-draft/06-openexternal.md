# [P1] setWindowOpenHandler 不校验协议就 openExternal

标签：`bug` `P1`

## 根因

`cli/src/main/index.ts:229-232`：

```ts
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  void shell.openExternal(url)      // ← 无任何校验
  return { action: 'deny' }
})
```

而紧邻的 `will-navigate`（:234-244）却做了限制：

```ts
if (!['http:', 'https:', 'mailto:'].includes(next.protocol)) return false
```

**两处不一致。**

## 影响

渲染层被注入或出 bug 时，`window.open('file:///…')`、`smb:`、以及各种系统自定义协议处理器都会被直接交给操作系统。`openExternal` 等于把 URI 交给 OS 执行。

## 修复方向

抽出共用的协议白名单，两处都走同一套校验。顺带统一处理 `openExternal` 的 promise 拒绝（未注册协议处理器时会 reject，`index.ts:80/230/240` 三处都是裸 `void`，会产生未处理拒绝）。

## 备注

完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-07。
