import { useState } from 'react'
import type { McpServerEntry, McpScope, McpServerConfigInput } from '../../shared/ipc'

interface Props {
  cwd: string
  mode: 'add' | 'edit'
  /** The server being edited (null in add mode). */
  editing: McpServerEntry | null
  /** Names already in use — used for the uniqueness check in add mode. */
  existingNames: string[]
  onClose: () => void
  /** Called after a successful save; caller restarts the session to apply. */
  onSaved: () => void
}

type Transport = 'stdio' | 'sse' | 'http'
type EditView = 'form' | 'json'

const NAME_RE = /^[A-Za-z0-9_-]+$/

/** env/headers textarea (`KEY=VALUE` / `KEY: VALUE` per line) → record. */
function parsePairs(text: string, sep: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(sep)
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

function pairsToText(rec: Record<string, string> | undefined, sep: ':' | '='): string {
  if (!rec) return ''
  return Object.entries(rec)
    .map(([k, v]) => `${k}${sep} ${v}`)
    .join('\n')
}

function argsToText(args: string[] | undefined): string {
  return (args ?? []).join('\n')
}

function argsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

export default function McpServerFormModal(props: Props): JSX.Element {
  const { mode, editing, existingNames, onClose, onSaved } = props
  const isEdit = mode === 'edit'

  const cfg = editing?.config
  const initTransport: Transport =
    cfg?.type === 'sse' || cfg?.type === 'http' ? cfg.type : 'stdio'
  const initScope: McpScope =
    editing?.scope === 'project' || editing?.scope === 'local' ? editing.scope : 'user'

  const [name, setName] = useState(editing?.name ?? '')
  const [scope, setScope] = useState<McpScope>(initScope)
  const [transport, setTransport] = useState<Transport>(initTransport)
  const [command, setCommand] = useState(cfg?.command ?? '')
  const [argsText, setArgsText] = useState(argsToText(cfg?.args))
  const [envText, setEnvText] = useState(pairsToText(cfg?.env, '='))
  const [url, setUrl] = useState(cfg?.url ?? '')
  const [headersText, setHeadersText] = useState(pairsToText(cfg?.headers, ':'))
  const [view, setView] = useState<EditView>('form')
  const [jsonText, setJsonText] = useState('')
  /** The complete original config (edit mode) or {} (add mode). Carries advanced
   *  keys the form doesn't surface so they survive form editing and JSON edits. */
  const [fullConfig, setFullConfig] = useState<Record<string, unknown>>(() =>
    editing?.config ? { ...editing.config } : {}
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  /** Merge the full original config (preserves advanced keys the form doesn't
   *  surface) with the current form fields. Opposite-transport keys are dropped
   *  so switching stdio↔remote doesn't leave stale entries behind. */
  function buildConfig(): McpServerConfigInput {
    const base: Record<string, unknown> = { ...fullConfig }
    const args = argsFromText(argsText)
    const env = parsePairs(envText, '=')
    const headers = parsePairs(headersText, ':')
    if (transport === 'stdio') {
      delete base['url']
      delete base['headers']
      return {
        ...base,
        type: 'stdio',
        command: command.trim(),
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {})
      }
    }
    delete base['command']
    delete base['args']
    delete base['env']
    return {
      ...base,
      type: transport,
      url: url.trim(),
      ...(Object.keys(headers).length ? { headers } : {})
    }
  }

  /** Populate the structured fields from a parsed config object, and adopt it as
   *  the new full-config source of truth (so JSON edits carry into form mode). */
  function applyConfigToForm(parsed: unknown): void {
    const p = (parsed ?? {}) as Record<string, unknown>
    setFullConfig({ ...p })
    const t = p['type'] === 'sse' || p['type'] === 'http' ? (p['type'] as Transport) : 'stdio'
    setTransport(t)
    setCommand(typeof p['command'] === 'string' ? p['command'] : '')
    setArgsText(argsToText(p['args'] as string[] | undefined))
    setEnvText(pairsToText(p['env'] as Record<string, string> | undefined, '='))
    setUrl(typeof p['url'] === 'string' ? p['url'] : '')
    setHeadersText(pairsToText(p['headers'] as Record<string, string> | undefined, ':'))
  }

  /** Switch between structured form and raw-JSON editor, carrying state across. */
  function switchView(target: EditView): void {
    if (target === view) return
    if (target === 'json') {
      setJsonText(JSON.stringify(buildConfig(), null, 2))
      setView('json')
    } else {
      try {
        applyConfigToForm(JSON.parse(jsonText))
        setView('form')
      } catch (e) {
        setError('JSON 解析失败,无法切回表单:' + (e instanceof Error ? e.message : String(e)))
      }
    }
  }

  const submit = async (): Promise<void> => {
    setError(null)
    const finalName = name.trim()

    if (!isEdit) {
      if (!finalName) return setError('请填写服务器名称。')
      if (!NAME_RE.test(finalName))
        return setError('名称只能包含字母、数字、下划线和连字符。')
      if (existingNames.includes(finalName)) return setError('该名称已被使用,请换一个。')
    }

    let config: McpServerConfigInput
    if (view === 'json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(jsonText)
      } catch (e) {
        return setError('JSON 解析失败:' + (e instanceof Error ? e.message : String(e)))
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return setError('JSON 必须是一个对象。')
      }
      config = parsed as McpServerConfigInput
    } else {
      if (transport === 'stdio') {
        if (!command.trim()) return setError('stdio 类型需要填写启动命令。')
      } else {
        if (!url.trim()) return setError(`${transport} 类型需要填写 URL。`)
      }
      config = buildConfig()
    }

    setSaving(true)
    try {
      await window.api.saveMcpServer({
        cwd: props.cwd,
        scope,
        name: isEdit ? (editing?.name ?? finalName) : finalName,
        config
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'
  const labelCls = 'mb-1.5 block text-xs text-zinc-500'

  return (
    <div className="tran-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="tran-modal-panel max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="text-base font-semibold text-zinc-100">
            {isEdit ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
          </h2>
          <div className="ml-auto inline-flex rounded-lg border border-border-subtle bg-bg-elev p-0.5 text-[11px]">
            <button
              onClick={() => switchView('form')}
              className={`rounded-md px-2.5 py-1 transition ${
                view === 'form' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              表单
            </button>
            <button
              onClick={() => switchView('json')}
              className={`rounded-md px-2.5 py-1 transition ${
                view === 'json' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              原始 JSON
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="my-server"
              className={`${inputCls} font-mono disabled:opacity-60`}
            />
          </div>

          <div>
            <label className={labelCls}>作用域</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as McpScope)}
              disabled={isEdit}
              className={`${inputCls} disabled:opacity-60`}
            >
              <option value="user">用户(全局)</option>
              <option value="project">项目(.mcp.json)</option>
              <option value="local">本地(仅此项目)</option>
            </select>
          </div>

          {view === 'form' && (
            <div>
              <label className={labelCls}>类型</label>
              <select
                value={transport}
                onChange={(e) => setTransport(e.target.value as Transport)}
                disabled={isEdit}
                className={`${inputCls} disabled:opacity-60`}
              >
                <option value="stdio">本地进程(stdio)</option>
                <option value="sse">远程(SSE)</option>
                <option value="http">远程(HTTP)</option>
              </select>
            </div>
          )}
        </div>

        {view === 'json' ? (
          <div className="mt-3">
            <label className={labelCls}>服务器配置(JSON)</label>
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder={'{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "..."],\n  "env": { "KEY": "..." }\n}'}
              className={`${inputCls} resize-y font-mono text-xs leading-relaxed`}
            />
            <p className="mt-1.5 text-[11px] text-zinc-600">
              JSON 模式支持全部字段(如 <code>timeout</code>、<code>alwaysLoad</code> 等)。保存时将原样写入配置文件。
            </p>
          </div>
        ) : transport === 'stdio' ? (
          <>
            <div className="mt-3">
              <label className={labelCls}>启动命令 *</label>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div className="mt-3">
              <label className={labelCls}>参数(每行一个)</label>
              <textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={3}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                className={`${inputCls} resize-y font-mono`}
              />
            </div>
            <div className="mt-3">
              <label className={labelCls}>环境变量(每行一个,格式 KEY=VALUE)</label>
              <textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                rows={3}
                placeholder={'API_KEY=sk-...\nNODE_ENV=production'}
                className={`${inputCls} resize-y font-mono`}
              />
            </div>
          </>
        ) : (
          <>
            <div className="mt-3">
              <label className={labelCls}>URL *</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div className="mt-3">
              <label className={labelCls}>请求头(每行一个,格式 KEY: VALUE)</label>
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                placeholder={'Authorization: Bearer ...'}
                className={`${inputCls} resize-y font-mono`}
              />
            </div>
          </>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <p className="mt-4 text-[11px] text-zinc-600">
          保存后会重开当前会话以应用新配置(对话历史会保留)。
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-bg-elev px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中…' : '保存并应用'}
          </button>
        </div>
      </div>
    </div>
  )
}
