import { useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

interface Diagnosis {
  title: string
  detail: string
}

function diagnose(error: string): Diagnosis {
  const text = error.toLowerCase()
  if (text.includes('api_retry') || text.includes('retry')) {
    return {
      title: 'API 重试耗尽',
      detail: 'Provider 在多次重试后仍失败，常见原因是网络抖动、限流、上游 5xx 或代理超时。'
    }
  }
  if (text.includes('auth') || text.includes('401') || text.includes('403') || text.includes('unauthorized')) {
    return {
      title: '认证或额度问题',
      detail: '检查当前 Provider 的 Token/API Key、账号权限、余额和是否使用了正确的鉴权方式。'
    }
  }
  if (text.includes('model') || text.includes('not found') || text.includes('invalid')) {
    return {
      title: '模型名可能无效',
      detail: '当前模型可能不被该 Provider 支持。去 Provider/Profile 或模型列表里确认模型 ID。'
    }
  }
  if (text.includes('wsl.exe') || text.includes('wsl') || text.includes('spawn')) {
    return {
      title: 'WSL 命令失败',
      detail: '检查默认 WSL、claude 是否安装、工作目录映射和 ~/.claude/settings.json。'
    }
  }
  if (text.includes('network') || text.includes('timeout') || text.includes('econn') || text.includes('fetch')) {
    return {
      title: '网络连接失败',
      detail: '检查代理、DNS、Provider Base URL 和本机网络连通性。'
    }
  }
  return {
    title: '会话运行错误',
    detail: '错误来自 Claude 进程或 SDK。复制诊断日志后可以继续定位具体命令、Provider 和模型。'
  }
}

export default function ErrorDiagnosticPanel(): JSX.Element {
  const error = useSessionStore((s) => s.status.error)
  const meta = useSessionStore((s) => s.meta)
  const [copied, setCopied] = useState(false)

  if (!error || !meta) return <></>

  const diagnosis = diagnose(error)

  const copyLogs = async (): Promise<void> => {
    const log = await window.api.getDiagnosticLog().catch((e) => String(e))
    const body = [
      `Diagnosis: ${diagnosis.title}`,
      `CWD: ${meta.cwd}`,
      `Model: ${meta.model}`,
      `Error: ${error}`,
      '',
      log
    ].join('\n')
    await navigator.clipboard?.writeText(body).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="bg-transparent px-6 pb-2">
      <div className="mx-auto flex max-w-5xl items-start gap-3 rounded-xl border border-red-900/35 bg-red-950/20 px-3 py-2 text-xs">
        <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-400" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-red-200">{diagnosis.title}</div>
          <div className="mt-0.5 text-zinc-400">{diagnosis.detail}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-red-300/80" title={error}>
            {error}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void copyLogs()}
          className="shrink-0 rounded-lg border border-red-900/40 bg-black/20 px-2 py-1 text-[11px] text-red-100 transition hover:bg-red-950/50"
        >
          {copied ? '已复制' : '复制诊断日志'}
        </button>
      </div>
    </div>
  )
}
