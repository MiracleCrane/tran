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

export default function HelpPanel(): JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-zinc-100">说明</h1>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            macOS 版 Claude Code 安装说明。官方文档：
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
                macOS 12 Monterey 或更高版本
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                Apple Silicon（arm64）或 Intel（x64），4 GB+ 内存
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
              <h2 className="text-sm font-semibold text-zinc-200">官方安装脚本</h2>
              <span className="rounded bg-accent/20 px-2 py-0.5 text-[10px] font-medium text-accent">
                推荐
              </span>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-zinc-500">
              打开“终端”（Terminal），普通用户权限即可，不需要 sudo。脚本会自动下载并安装到
              <code className="text-zinc-400"> ~/.claude/local</code>。
            </p>
            <CommandBlock label="安装" command="curl -fsSL https://claude.ai/install.sh | bash" />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="检查版本" command="claude --version" />
              <CommandBlock label="诊断安装" command="claude doctor" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              第一次运行 <code className="text-zinc-400">claude</code> 后，按提示完成登录。
            </p>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">Homebrew 安装</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              如果你已安装 <ExternalLink href="https://brew.sh">Homebrew</ExternalLink>，可以用它来安装和更新。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="安装" command="brew install claude-code" />
              <CommandBlock label="更新" command="brew upgrade claude-code" />
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">npm 安装</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              如果已安装 Node.js（建议 20+），也可以通过 npm 全局安装。
            </p>
            <div className="mt-3">
              <CommandBlock
                label="安装"
                command="npm install -g @anthropic-ai/claude-code"
              />
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">配置文件位置</h2>
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 font-mono text-xs leading-relaxed text-zinc-400">
              配置：~/.claude/settings.json<br />
              会话：~/.claude/projects/&lt;项目&gt;/
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              从“访达”前往：按 <code className="text-zinc-400">⌘ ⇧ G</code>，输入
              <code className="text-zinc-400"> ~/.claude</code> 回车即可。
            </p>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">可选：Git</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              macOS 自带 Git（需先安装 Xcode Command Line Tools）。若未安装，可在终端运行下面的命令。
            </p>
            <div className="mt-3">
              <CommandBlock label="安装命令行工具" command="xcode-select --install" />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
