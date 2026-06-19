import { useEffect, useState } from 'react'
import type { TranslateEngine, TranslateTestResult } from '../../shared/ipc'
import { ToolPanelAlert, ToolPanelButton } from './ToolPanelChrome'

/** Translate engine management page. Pick which engine translateTexts()
 *  routes through (LLM provider vs Baidu) and configure/test Baidu credentials. */

function RadioDot({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-accent' : 'border-zinc-600'
      }`}
    >
      {on && <span className="h-2 w-2 rounded-full bg-accent" />}
    </span>
  )
}

export default function TranslatePanel(): JSX.Element {
  const [engine, setEngine] = useState<TranslateEngine>('llm')
  const [appId, setAppId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TranslateTestResult | null>(null)

  useEffect(() => {
    void window.api.getTranslateConfig().then((c) => {
      setEngine(c.engine)
      setAppId(c.baidu.appId)
      setSecretKey(c.baidu.secretKey)
      setLoaded(true)
    })
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.saveTranslateConfig({
        engine,
        baidu: { appId: appId.trim(), secretKey: secretKey.trim() }
      })
      setSavedAt(true)
      setTimeout(() => setSavedAt(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.api.testTranslate(appId.trim(), secretKey.trim()))
    } finally {
      setTesting(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'
  const labelCls = 'mb-1.5 block text-xs text-zinc-500'

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">加载中…</div>
    )
  }

  const cardCls = (on: boolean): string =>
    `cursor-pointer rounded-xl border px-4 py-3 transition ${
      on ? 'border-accent/50 bg-bg-panel' : 'border-border-subtle bg-bg-panel hover:border-zinc-700'
    }`

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">翻译</h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            技能 / 插件描述翻译所用引擎。百度翻译专用接口独立计费,不受大模型限流影响。
          </p>
        </div>

        {/* engine selector */}
        <section className="space-y-2">
          <button type="button" onClick={() => setEngine('llm')} className={`block w-full text-left ${cardCls(engine === 'llm')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={engine === 'llm'} />
              <span className="text-sm font-medium text-zinc-100">运营商模型翻译</span>
              {engine === 'llm' && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              使用当前激活运营商的 /v1/messages 接口翻译。翻译质量高,但与大模型共享额度,近期频繁限流。
            </p>
          </button>

          <button type="button" onClick={() => setEngine('baidu')} className={`block w-full text-left ${cardCls(engine === 'baidu')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={engine === 'baidu'} />
              <span className="text-sm font-medium text-zinc-100">百度翻译</span>
              {engine === 'baidu' && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              走百度通用翻译 API,独立额度、响应快,适合大量短文本描述。
            </p>
          </button>
        </section>

        {/* baidu credentials (only when baidu is the chosen engine) */}
        {engine === 'baidu' && (
          <section className="space-y-4 rounded-xl border border-border-subtle bg-bg-panel p-4">
            <div>
              <label className={labelCls}>App ID</label>
              <input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="百度翻译 App ID"
                className={`${inputCls} font-mono`}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label className={labelCls}>密钥 (Secret Key)</label>
              <div className="flex gap-2">
                <input
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  type={showSecret ? 'text' : 'password'}
                  placeholder="百度翻译密钥"
                  className={`${inputCls} font-mono`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((s) => !s)}
                  className="shrink-0 rounded-lg border border-border-subtle bg-bg-elev px-3 text-xs text-zinc-400 transition hover:text-zinc-200"
                >
                  {showSecret ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <ToolPanelButton
                onClick={() => void runTest()}
                disabled={testing || !appId.trim() || !secretKey.trim()}
              >
                {testing ? '测试中…' : '测试连通性'}
              </ToolPanelButton>
              <a
                href="https://fanyi-api.baidu.com/"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent hover:underline"
              >
                去百度翻译开放平台申请 →
              </a>
            </div>

            {testResult && (
              <ToolPanelAlert tone={testResult.ok ? 'success' : 'error'}>
                {testResult.ok
                  ? `连通成功 · "hello world" → ${testResult.translated}`
                  : `连通失败:${testResult.error}`}
              </ToolPanelAlert>
            )}
          </section>
        )}

        <div className="flex items-center gap-3">
          <ToolPanelButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
            className="h-9 px-5 text-sm"
          >
            {saving ? '保存中…' : '保存'}
          </ToolPanelButton>
          {savedAt && <span className="text-xs text-emerald-400">已保存</span>}
        </div>

        <p className="text-[11px] leading-relaxed text-zinc-600">
          保存后立即生效。技能面板的描述翻译会改用所选引擎;百度密钥已加密保存。
        </p>
      </div>
    </div>
  )
}
