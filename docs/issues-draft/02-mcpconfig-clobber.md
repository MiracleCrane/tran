# [P0] mcpConfig 解析失败时把 ~/.claude.json 整个覆写

标签：`bug` `P0`

## 根因

`cli/src/main/mcpConfig.ts:27-33, 70`（v1.0.39）：

```ts
function readJson(path) {
  try { return JSON.parse(readFileSync(path,'utf8')) }
  catch { return {} }        // ← 解析失败 → 空对象
}

const root = existsSync(path) ? readJson(path) : {}
const servers = locateServers(root, cwd, scope)
servers[name] = config
writeJson(path, root)         // ← 用空对象+一个 mcpServers 覆写整个文件
```

`saveMcpServer` 是读-改-写。文件瞬时不可解析时添加 MCP server，会把它替换成只剩 `mcpServers` 的内容。

**与模块自己的注释直接矛盾：**
> Each operation is a read-modify-write that only touches the target `mcpServers` subtree, **leaving every other key in the file untouched.**

## 影响

`~/.claude.json` 与 `claude` CLI 共用，含认证、projects、历史，全部丢失。

（`deleteMcpServer` 无此问题：key 不存在时会在写入前 `return false`。）

## 修复方向

解析失败/非对象时**抛错、放弃写入**。`McpServerFormModal.tsx:182-186` 已有 try/catch 并展示错误文案，会变成用户可见提示而非静默破坏。同时改原子写入。

## 备注

静态审查发现，**未实测触发**。
另见 #11（本文件写入的路径本身可能就是错的）。
完整报告见 `docs/CODE-REVIEW-2026-07-29.md` F-02。
