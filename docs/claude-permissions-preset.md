# Claude Code 权限规则预设（Tran 的 Claude 后端用）

Tran 的 Claude 后端走 `claude -p --output-format stream-json`，**非交互模式没有
TTY**，所以 Claude Code 自己那套内联授权提示（`1. Yes / 2. Yes, don't ask again
/ 3. No`）不会出现，Tran 也拿不到挂接点弹自己的框。

工具能不能跑，完全由两样东西决定：

1. `--permission-mode`（Tran 的权限档选择器映射过去）
2. `~/.claude/settings.json` 里的 `permissions` 规则

**所以规则要提前配好。** 下面是一份可直接用的预设。

---

## 放哪

| 文件 | 作用范围 | 备注 |
|---|---|---|
| `~/.claude/settings.json` | 全局（所有项目） | **推荐放这里**。`defaultMode: "auto"` 只有放这里才生效 |
| `<项目>/.claude/settings.json` | 单个项目，会进 git | 团队共享规则用 |
| `<项目>/.claude/settings.local.json` | 单个项目，不进 git | 个人临时覆盖 |

⚠️ 实测（v2.1.220 二进制内的说明原文）：

> `"permissions": {"defaultMode": "auto"}` … It MUST go in the user file: an
> `"auto"` defaultMode in project `.claude/settings.json` or
> `.claude/settings.local.json` is **ignored as repo-controllable** — only
> policy, user, and CLI-flag sources may grant auto mode.

即项目级文件里写 `auto` 是**无效**的，必须写在用户级。

---

## 规则语法

```
Tool(pattern)
```

- `Bash(git *)` —— 通配符匹配
- `Bash(npm run:*)` —— 前缀匹配（旧写法，官方提示改用 `*`）
- `Read(./.env)` / `Edit(//etc/*)` —— 路径匹配
- 裸 `Edit` / `Read` —— 该工具全部放行
- **`deny` 优先于 `allow`**

---

## 预设：写进 `~/.claude/settings.json`

成品文件就在同目录：[`claude-settings.json`](./claude-settings.json)（内容与下面一致，
可直接整份拷到 `~/.claude/settings.json`）。

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": [
      "Bash(rm -rf *)",
      "Bash(rm -fr *)",
      "Bash(rmdir /s *)",
      "Bash(del /f *)",
      "Bash(del /q *)",
      "Bash(format *)",
      "Bash(diskpart*)",
      "Bash(mkfs*)",
      "Bash(dd if=*)",

      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git reset --hard*)",
      "Bash(git clean -fd*)",
      "Bash(git filter-branch*)",
      "Bash(git filter-repo*)",
      "Bash(git update-ref -d*)",

      "Bash(npm publish*)",
      "Bash(npm unpublish*)",
      "Bash(pnpm publish*)",
      "Bash(yarn publish*)",

      "Bash(curl * | sh*)",
      "Bash(curl * | bash*)",
      "Bash(iwr * | iex*)",
      "Bash(irm * | iex*)",
      "Bash(*Invoke-Expression*)",

      "Bash(reg add *)",
      "Bash(reg delete *)",
      "Bash(sc delete *)",
      "Bash(sc stop *)",
      "Bash(schtasks /create*)",
      "Bash(schtasks /delete*)",
      "Bash(taskkill /f*)",
      "Bash(shutdown*)",
      "Bash(net user *)",
      "Bash(net localgroup *)",
      "Bash(*Set-ExecutionPolicy*)",

      "Read(./.env)",
      "Read(./.env.*)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(**/id_rsa)",
      "Read(**/id_ed25519)",
      "Read(**/*.pem)",
      "Read(**/*.pfx)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.claude.json)",
      "Read(~/.claude/credentials*)",
      "Read(~/.kimi-code/credentials/**)",
      "Read(~/.kimi-code/server.token)",

      "Edit(./.env)",
      "Edit(./.env.*)",
      "Edit(**/.env)",
      "Edit(**/.env.*)",
      "Edit(~/.ssh/**)",
      "Edit(~/.aws/**)",
      "Edit(~/.claude.json)",
      "Edit(~/.claude/settings.json)",
      "Edit(~/.kimi-code/**)",
      "Write(**/.env)",
      "Write(**/.env.*)",
      "Write(~/.ssh/**)",
      "Write(~/.claude/settings.json)",

      "Edit(//etc/*)",
      "Edit(//Windows/*)",
      "Edit(C:/Windows/**)"
    ],
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "NotebookEdit",
      "TodoWrite",
      "Task",
      "WebSearch",

      "Bash(ls *)",
      "Bash(dir *)",
      "Bash(cat *)",
      "Bash(type *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(find *)",
      "Bash(where *)",
      "Bash(echo *)",
      "Bash(pwd)",
      "Bash(cd *)",
      "Bash(date *)",
      "Bash(whoami)",

      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git show*)",
      "Bash(git branch*)",
      "Bash(git checkout*)",
      "Bash(git switch*)",
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(git fetch*)",
      "Bash(git pull*)",
      "Bash(git stash*)",
      "Bash(git remote*)",
      "Bash(git rev-parse*)",
      "Bash(git merge-base*)",

      "Bash(npm run *)",
      "Bash(npm test*)",
      "Bash(npm ci)",
      "Bash(npm install)",
      "Bash(npm view *)",
      "Bash(npm ls*)",
      "Bash(pnpm *)",
      "Bash(node *)",
      "Bash(npx tsc*)",
      "Bash(python *)",
      "Bash(python3 *)",
      "Bash(pip list*)",
      "Bash(go build*)",
      "Bash(go test*)",
      "Bash(cargo build*)",
      "Bash(cargo test*)"
    ]
  }
}
```

---

## 有意留在「问/拦」之外的几类

这些**没放进 allow**，所以在 `defaultMode: "default"` 下会被拦下（非交互模式
下等于拒绝执行）。如果你的工作流需要，自己往 `allow` 里加：

| 类别 | 例子 | 为什么不默认放行 |
|---|---|---|
| 推送到远端 | `git push`（非 force） | 会改远端状态，建议自己把关 |
| 部署/CI 触发 | `jenkins-cli`、`kubectl`、`docker push` | 你提到用 Jenkins，按需加 `Bash(curl *jenkins*)` 之类 |
| 装包 | `npm install <pkg>` | 引入新依赖是决策，不是操作 |
| 抓网页 | `WebFetch` | 会把内容带进上下文 |

想让某类"问一下"而不是直接拦，可以用 `ask`（与 `allow`/`deny` 同级），
不过我**没有实测过 `ask` 在非交互模式下的行为** —— 没有 TTY 时它可能等价于拒绝。
建议先用 allow/deny 二分。

---

## ⚠️ 这套规则挡什么、不挡什么

**挡的是手滑，不是绕过。** 匹配是对**命令字符串**做的，不理解语义：

```
Bash(rm -rf *)  拦得住：  rm -rf ./build
                拦不住：  bash -c "rm -rf ./build"
                          find . -name build -delete
                          git clean -fdx
                          node -e "require('fs').rmSync('build',{recursive:true})"
```

所以：

1. **真正不能碰的目录，别让 agent 进** —— 用 `--add-dir` / `additionalDirectories`
   把工作区限定在项目内，比事后拦命令可靠得多
2. **重要工作先提交** —— git 是最实在的兜底
3. 别把这套规则当安全边界，它是**防误操作**的

---

## 配完怎么验

```bash
claude doctor          # 校验配置文件能否解析
claude                 # 进 TUI 后 /permissions 看生效的规则
```

Tran 侧把权限档设为「默认」，映射过去就是 `--permission-mode default`，即
按上面的规则走。
