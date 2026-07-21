interface CommandBlockProps {
  label: string
  command: string
}

import { useUiStore } from '../store/uiStore'

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
        <div className="mb-5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => useUiStore.getState().setView('chat')}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">说明</h1>
        </div>
        <p className="mb-5 mt-1 text-xs leading-relaxed text-zinc-500">
            Tran 通过 ACP 驱动本机的 Kimi Code CLI。请先按下文安装并完成登录。官方文档：
            {' '}
            <ExternalLink href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html">
              kimi.com/code/docs
            </ExternalLink>
          </p>

        <div className="space-y-4">
          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">系统要求</h2>
            <div className="mt-3 grid gap-2 text-xs leading-relaxed text-zinc-500 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                Windows 10 1809+，x64 或 ARM64
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                需要 Git for Windows（Kimi 的 shell 环境）
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                需要可访问网络
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2">
                Kimi Code 账号（OAuth）或 Kimi Platform API key
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
              打开 PowerShell，普通用户权限即可，不需要以管理员身份运行。安装脚本会把 kimi 可执行文件放到 PATH 上。
            </p>
            <CommandBlock label="安装" command="irm https://code.kimi.com/kimi-code/install.ps1 | iex" />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="检查版本" command="kimi --version" />
              <CommandBlock label="升级" command="kimi upgrade" />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              也可以用 npm 安装（需要 Node.js 22.19+）：<code className="text-zinc-400">npm install -g @moonshot-ai/kimi-code</code>
            </p>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">首次登录</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              在终端运行 <code className="text-zinc-400">kimi</code> 进入交互界面，输入{' '}
              <code className="text-zinc-400">/login</code> 按提示完成登录（Kimi Code OAuth 或 Kimi Platform API key）。
              登录成功后重启 Tran 即可开始会话；Tran 会复用 CLI 已有的登录状态，无需再次登录。
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <CommandBlock label="启动 CLI" command="kimi" />
              <CommandBlock label="登录" command="/login" />
            </div>
          </section>

          <section className="glass-panel-soft rounded-2xl p-4">
            <h2 className="text-sm font-semibold text-zinc-200">数据位置</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              Kimi Code CLI 的配置、会话记录和日志默认保存在{' '}
              <code className="text-zinc-400">~/.kimi-code/</code>
              。Git Bash 装在自定义路径时，把 KIMI_SHELL_PATH 设为 bash.exe 的绝对路径。
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
