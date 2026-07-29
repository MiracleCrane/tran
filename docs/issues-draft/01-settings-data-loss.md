# [P0] settings.ts 读取瞬时失败会把空配置覆写回真实文件（providers/apiKey 永久丢失）

标签：`bug` `P0`

## 根因

`cli/src/main/settings.ts:271-287`（v1.0.39）：

```ts
try {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  cache = normalizeSettings(raw)
  ...
} catch {
  cache = normalizeSettings({})   // ← 读失败和文件损坏走同一条路
  cacheMtimeMs = mtimeMs
}
```

`readFileSync` 与 `JSON.parse` 共用一个 `try`，**任一失败都退回空默认值并写进 cache**。随后 `save()` 把这份空 cache 覆写回真实文件：

```
读取瞬时失败 → cache = {} → 用户改任意一项设置 → save() → 文件被空配置覆盖
```

## 影响

丢失：providers、projects、apiKey、百度翻译密钥。
**无备份、无原子写入，不可恢复。**

## 触发条件

读取瞬时失败。Windows 上由杀软/备份/索引程序占用文件产生（EBUSY/EPERM）。
`AGENTS.md` 自己记录了「奇安信天擎会扫描新解包的 exe，导致 EPERM/EBUSY」，不是纯理论场景。

## 修复方向

1. 区分「文件不存在」（可安全重建）与「读取/解析失败」（底下可能压着好数据，禁止覆写）
2. 读失败打标记，`save()` 先重试读取，成功则把改动合并到**磁盘上的真实设置**之上，仍失败则放弃本次持久化
3. 改原子写入（tmp+rename）。`sessionDelete.ts:80-82` 已有正确写法

## 备注

静态审查发现，**未实测触发**；行号与逻辑已逐行核对。
完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-01。
