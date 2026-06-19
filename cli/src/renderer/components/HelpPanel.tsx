import { useEffect, useState } from 'react'
import { onForgeEvent } from '../events'

interface CommandBlockProps {
  label: string
  command: string
}

function CommandBlock({ label, command }: CommandBlockProps): JSX.Element {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-200">
        {command}
      </pre>
    </div>
  )
}

function ExternalLink({ href, children }: { href: string; children: string }): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
    >
      {children}
    </a>
  )
}

const WSL_CLAUDE_INSTALL_COMMAND = [
  'npm install -g @anthropic-ai/claude-code',
  'mkdir -p "$HOME/.local/bin"',
  'ln -sfn "$(npm prefix -g)/bin/claude" "$HOME/.local/bin/claude"',
  'hash -r'
].join('\n')

const WSL_CLAUDE_VERIFY_COMMAND = [
  'command -v claude',
  'claude --version'
].join('\n')

export default function HelpPanel(): JSX.Element {
  const [wslSupportEnabled, setWslSupportEnabled] = useState(false)

  useEffect(() => {
    const refresh = (): void => {
      void window.api.getPreferences().then((prefs) => setWslSupportEnabled(!!prefs.wslSupportEnabled))
    }
    refresh()
    return onForgeEvent('wslSupportChanged', refresh)
  }, [])

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-zinc-100">说明</h1>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Windows 版 Claude Code 安装说明。官方文档：
            {' '}
            <ExternalLink href="https://code.claude.com/docs/en/setup">
              code.claude.com/docs/en/setup
            </ExternalLink>
          </p>
        </div>

        <div className="space-y-4">
          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">系统要求</h2>
            <div className="mt-3 grid gap-2 text-xs leading-relaxed text-zinc-500 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                Windows 10 1809+ 或 Windows Server 2019+
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                x64 或 ARM64 处理器，4 GB+ 内存
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                需要可访问网络
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                Claude Code 可用账号或 Console/API 账号
              </div>
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-zinc-200">PowerShell 安装</h2>
              <span className="rounded bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                推荐
              </span>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-zinc-500">
              打开 PowerShell，普通用户权限即可，不需要以管理员身份运行。
            </p>
            <CommandBlock label="安装" command="irm https://claude.ai/install.ps1 | iex" />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="检查版本" command="claude --version" />
              <CommandBlock label="诊断安装" command="claude doctor" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              第一次运行 <code className="text-zinc-400">claude</code> 后，按提示完成登录。
            </p>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">WinGet 安装</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              如果你习惯用 Windows 包管理器，可以用 WinGet 安装和更新。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="安装" command="winget install Anthropic.ClaudeCode" />
              <CommandBlock label="更新" command="winget upgrade Anthropic.ClaudeCode" />
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">CMD 安装</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              如果当前窗口是 CMD，而不是 PowerShell，可以使用下面的命令。
            </p>
            <div className="mt-3">
              <CommandBlock
                label="安装"
                command="curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd"
              />
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">可选：Git for Windows</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              Windows 原生 Claude Code 可以不安装 Git for Windows；如果安装了，它可以使用 Git Bash 工具。
              下载地址：
              {' '}
              <ExternalLink href="https://git-scm.com/download/win">
                git-scm.com/download/win
              </ExternalLink>
            </p>
          </section>

          {wslSupportEnabled && (
          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">WSL 版本</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              如果 Forge 设置里启用了“使用 WSL 内 Claude”，需要进入 WSL 终端后安装并配置 Claude Code。
              推荐用 npm 安装；Windows 原生版和 WSL 版是两套环境，配置文件也不同。
            </p>
            <div className="mt-3 grid gap-3">
              <CommandBlock label="WSL 内安装" command={WSL_CLAUDE_INSTALL_COMMAND} />
              <div className="grid gap-3 sm:grid-cols-2">
                <CommandBlock label="检查版本" command={WSL_CLAUDE_VERIFY_COMMAND} />
                <CommandBlock label="PowerShell 验证" command="wsl.exe --exec /usr/bin/env claude --version" />
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 font-mono text-xs leading-relaxed text-zinc-400">
              Windows: C:\Users\&lt;用户名&gt;\.claude<br />
              WSL: ~/.claude
            </div>
          </section>
          )}
        </div>
      </div>
    </div>
  )
}
