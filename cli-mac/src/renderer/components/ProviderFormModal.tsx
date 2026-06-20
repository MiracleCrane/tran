import { useState } from 'react'
import type { Provider, ProviderAuthType, ProviderBackend } from '../../shared/ipc'

interface Props {
  /** Provider being edited, or a blank one for add mode. */
  provider: Provider
  isEdit: boolean
  backend?: ProviderBackend
  onClose: () => void
  onSaved: () => void
}

export default function ProviderFormModal({ provider, isEdit, backend, onClose, onSaved }: Props): JSX.Element {
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [token, setToken] = useState(provider.token)
  const [authType, setAuthType] = useState<ProviderAuthType>(provider.authType)
  const [model, setModel] = useState(provider.model)
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setError(null)
    if (!baseUrl.trim()) {
      setError('请填写 API 地址(Base URL)。')
      return
    }

    const finalProvider: Provider = {
      id: provider.id,
      name: name.trim() || baseUrl.trim(),
      baseUrl: baseUrl.trim(),
      token,
      authType,
      model: model.trim() || 'claude-opus-4-8'
    }

    setSaving(true)
    try {
      if (backend) await window.api.saveProviderForBackend(backend, finalProvider)
      else await window.api.saveProvider(finalProvider)
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border-subtle bg-bg-panel p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent" />
          <h2 className="text-base font-semibold text-zinc-100">
            {isEdit ? '编辑运营商' : '添加运营商'}
          </h2>
        </div>

        <div className="mt-1">
          <label className={labelCls}>名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="智谱代理 / Anthropic 官方"
            className={inputCls}
          />
        </div>

        <div className="mt-3">
          <label className={labelCls}>API 地址(Base URL)*</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com"
            className={`${inputCls} font-mono`}
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            对应 <code className="text-zinc-500">ANTHROPIC_BASE_URL</code>。
          </p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>鉴权方式</label>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as ProviderAuthType)}
              className={inputCls}
            >
              <option value="bearer">Bearer Token</option>
              <option value="apikey">API Key</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>默认模型</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="claude-opus-4-8"
              className={`${inputCls} font-mono`}
            />
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">
          {authType === 'bearer'
            ? 'Bearer Token 会通过 ANTHROPIC_AUTH_TOKEN 发送。'
            : 'API Key 会通过 ANTHROPIC_API_KEY 发送。'}
        </p>

        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <label className={labelCls + ' mb-0'}>密钥 / Token</label>
            <button
              type="button"
              onClick={() => setShowToken((s) => !s)}
              className="text-[11px] text-zinc-500 transition hover:text-zinc-300"
            >
              {showToken ? '隐藏' : '显示'}
            </button>
          </div>
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={authType === 'bearer' ? 'PROXY_MANAGED / Bearer token' : 'sk-ant-...'}
            className={`${inputCls} font-mono`}
          />
          <p className="mt-1 text-[11px] text-zinc-600">
            走本地代理时可填 <code className="text-zinc-500">PROXY_MANAGED</code>。
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <p className="mt-4 text-[11px] text-zinc-600">
          保存活动运营商会同步写入当前后端的 Claude 配置；非活动运营商会在切换时写入。
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
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
