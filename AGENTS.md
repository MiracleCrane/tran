## Agent skills

### Issue tracker

Issues live in **GitHub Issues** on `MiracleCrane/tran` (priority labels: `P0-top` / `P0` / `P1` / `P2`). See `docs/agents/issue-tracker.md` for the local-markdown conventions (used only if the project ever switches back).

No `gh` CLI on this machine. Use the GitHub REST API directly:

- Auth: `printf "protocol=https\nhost=github.com\n\n" | git credential fill` → `password=` token (never echo it)
- Proxy required: `curl -x http://127.0.0.1:7897` (direct api.github.com is unreachable)
- POST bodies with Chinese text: write JSON to a temp file and `--data-binary @file` (inline quoting mangles UTF-8)

### Domain docs

Single-context layout — one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 发版流程（惯例）

改代码 → `npm run typecheck` → `npm run build` → commit/push → tag `vX.Y.Z` → `npm run build:win` → GitHub Release（API 创建 + 上传 `Tran-X.Y.Z-setup.exe`）→ 下载最新release安装包到默认下载路径 →  用户卸载重装验证 → 关闭对应 issue。版本号在 `cli/package.json`，changelog 在 `cli/CHANGELOG.md`（中英双语）。

### 已知环境坑

- **奇安信天擎（企业杀软）**：会扫描新解包的 exe，导致 electron-builder 在 `win-unpacked.tmp → win-unpacked` rename 时 EPERM/EBUSY。对策：失败后 `sleep 45`，手动 `mv win-unpacked.tmp win-unpacked`，再重试（最多几轮即过）。
- **git push 需代理**：`git -c http.proxy=http://127.0.0.1:7897 push`。
- **用户常驻安装版 Tran**（`D:\software\Tran`）：测试一律用独立 `--user-data-dir` 的 dev/打包实例 + CDP（`--remote-debugging-port`），绝不杀用户的 Tran.exe / node 进程。
