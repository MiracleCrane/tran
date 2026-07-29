# [P1] token 过期判定与并发刷新缺陷

标签：`bug` `P1`

## 问题 1：`expires_at` 为数字时恒判过期

`usageService.ts:50-53`：

```ts
function expiryMs(creds: OAuthCredentials): number {
  const parsed = Date.parse(String(creds.expires_at ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}
```

接口声明是 `expires_at?: string | number`（:32）。若 CLI 写入 epoch 数字：

```
Date.parse("1690000000000") → NaN → 记为 0
→ expiryMs - EXPIRY_SKEW_MS < Date.now() 恒为真
→ 每次调用都强制刷新
```

因 `refresh_token` 轮换且每次写回（:98），会**把轮换 token 转个不停**并反复写盘。

## 问题 2：并发刷新重复消费轮换 token

`quotaService.ts:134-156` 与 `usageService.ts:84-103` 都**无在飞去重**。

- `fetchQuotaOverview`（:304）与 `fetchQuotaActions`（:383）是独立入口，不共享 inflight 守卫
- `usageService.getValidAccessToken` 被 `aiTitles` 复用（:83 注释写明）

并发时两个调用拿**同一个** `refresh_token` 去换。服务端轮换后，第二个请求持已作废 token → 失败 → 该调用方误报「需要重新登录」。

## 修复方向

1. `expiryMs` 分别处理数字（区分秒/毫秒量级）与 ISO 字符串
2. 两处各加在飞 promise 合并

## 备注

完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-11 F-12。
