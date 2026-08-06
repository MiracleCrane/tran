import { useCallback, useEffect, useState } from 'react'
import type { TranslateEngine, ThinkingTranslateEngine, TranslateTestResult } from '../../shared/ipc'
import { refreshThinkingTranslateStatus } from '../hooks/useThinkingTranslateStatus'
import { ToolPanelAlert, ToolPanelButton } from './ToolPanelChrome'
import { useUiStore } from '../store/uiStore'
import { useTransientFlag } from '../hooks/useTransientFlag'

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
  // 思考翻译单独一个引擎，与上面的描述翻译分离（见 shared/ipc 注释）。
  const [thinkingEngine, setThinkingEngine] = useState<ThinkingTranslateEngine>('auto')
  const [appId, setAppId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, flashSaved] = useTransientFlag()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TranslateTestResult | null>(null)

  // 初始加载：失败也要 setLoaded，否则页面永久停在「加载中」。
  const loadConfig = useCallback((): void => {
    setLoadError(null)
    void window.api
      .getTranslateConfig()
      .then((c) => {
        setEngine(c.engine)
        setThinkingEngine(c.thinkingEngine)
        setAppId(c.baidu.appId)
        setSecretKey(c.baidu.secretKey)
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.api.saveTranslateConfig({
        engine,
        thinkingEngine,
        baidu: { appId: appId.trim(), secretKey: secretKey.trim() }
      })
      // 让已挂载的思考块立刻用上新引擎（否则回落提示会停在旧状态）。
      refreshThinkingTranslateStatus()
      flashSaved()
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
        {/* #35 吸顶标题栏：下滚后"返回对话"仍可点。 */}
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={() => useUiStore.getState().setView('chat')}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">翻译</h1>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">
          翻译引擎统一配置：技能 / 插件描述翻译、思考块全文翻译都用这里选的引擎。
          百度翻译专用接口独立计费,不受大模型限流影响。
        </p>

        {/* 初始加载失败：显示错误并允许重试（表单仍可用，只是回显的是默认值）。 */}
        {loadError && (
          <ToolPanelAlert tone="error">
            <span className="mr-2">配置加载失败：{loadError}</span>
            <button
              type="button"
              onClick={loadConfig}
              className="text-accent underline-offset-2 hover:underline"
            >
              重试
            </button>
          </ToolPanelAlert>
        )}

        {/* engine selector —— 只管技能/插件描述 */}
        <div className="pt-1 text-xs font-medium text-zinc-300">技能 / 插件描述翻译</div>
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
              翻译质量高。已配置「摘要 / 命名 API」时优先走那个便宜通道（DeepSeek 等）；
              未配置时用当前激活运营商的 /v1/messages——与大模型共享额度,近期频繁限流。
            </p>
          </button>

          <button type="button" onClick={() => setEngine('baidu')} className={`block w-full text-left ${cardCls(engine === 'baidu')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={engine === 'baidu'} />
              <span className="text-sm font-medium text-zinc-100">百度翻译</span>
              {(engine === 'baidu' || thinkingEngine === 'baidu' || thinkingEngine === 'auto') && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              走百度通用翻译 API,独立额度、响应快。实名认证后每月 100 万字符免费,
              技能描述和思考块全文翻译都够用。
            </p>
          </button>
        </section>

        {/* 思考翻译：独立开关。与上面分离的理由见 shared/ipc 的
            ThinkingTranslateEngine 注释——描述是短句机翻够用，思考满篇代码
            路径，机翻会译坏，两者不能共用一个选择。 */}
        <div className="pt-3 text-xs font-medium text-zinc-300">思考过程翻译</div>
        <section className="space-y-2">
          <button type="button" onClick={() => setThinkingEngine('auto')} className={`block w-full text-left ${cardCls(thinkingEngine === 'auto')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={thinkingEngine === 'auto'} />
              <span className="text-sm font-medium text-zinc-100">自动（推荐）</span>
              {thinkingEngine === 'auto' && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              配了下面的百度密钥就走百度（免费额度内不花钱）,没配则回落到摘要 / 命名 API
              那条通道。既优先省钱,又不会因为没填密钥就静默失去翻译。
            </p>
            {/* 实时显示当前落点：'自动' 到底走了哪条不该靠猜——尤其回落那条是要花钱的。 */}
            {thinkingEngine === 'auto' && (
              <p className="mt-1 pl-6 text-[11px] text-zinc-500">
                当前实际走：
                {appId.trim() ? (
                  <span className="text-emerald-400/80">百度（免费额度内）</span>
                ) : (
                  <span className="text-amber-500/80">模型翻译（按量计费）—— 未填下方百度密钥</span>
                )}
              </p>
            )}
          </button>

          <button type="button" onClick={() => setThinkingEngine('baidu')} className={`block w-full text-left ${cardCls(thinkingEngine === 'baidu')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={thinkingEngine === 'baidu'} />
              <span className="text-sm font-medium text-zinc-100">百度翻译</span>
              {thinkingEngine === 'baidu' && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              免费额度内不花钱。但思考过程里的路径、变量名、命令和报错原文,机翻可能
              一并译掉——要读代码细节时不如下面那条。未配置密钥时不翻译。
            </p>
          </button>

          <button type="button" onClick={() => setThinkingEngine('llm')} className={`block w-full text-left ${cardCls(thinkingEngine === 'llm')}`}>
            <div className="flex items-center gap-2">
              <RadioDot on={thinkingEngine === 'llm'} />
              <span className="text-sm font-medium text-zinc-100">模型翻译</span>
              {thinkingEngine === 'llm' && (
                <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  当前
                </span>
              )}
            </div>
            <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-zinc-500">
              走摘要 / 命名 API（DeepSeek 等）。提示词明确要求保留代码、命令、路径、
              变量名与报错原文不译,读起来最准,代价是按量计费。
            </p>
          </button>
        </section>

        {/* baidu credentials (only when baidu is the chosen engine) */}
        {(engine === 'baidu' || thinkingEngine === 'baidu' || thinkingEngine === 'auto') && (
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
          保存后立即生效。技能面板的描述翻译、思考块全文翻译都会改用所选引擎;百度密钥已加密保存。
        </p>
      </div>
    </div>
  )
}
