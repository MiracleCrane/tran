import { useCallback, useEffect, useState } from 'react'
import type { PromptDiagnosis, SummaryModelProbe, SummaryProfile } from '../../shared/ipc'

/** 新建配置时的预设，省得用户去翻文档抄 URL。 */
const PRESETS: Array<{ name: string; baseUrl: string; model: string; note: string }> = [
  {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    note: '按量计费 · 相同前缀命中缓存后输入费率极低'
  }
]

/**
 * 摘要 / 命名 API 的配置块。
 *
 * 从「设置 → 系统」搬到「AI 辅助」页（2026-08）：它和翻译引擎本来就是**同一件事**
 * —— 翻译的 `llm` 通道走的就是这里配的 baseUrl + Key。分在两个页面配，用户根本
 * 连不起来：在翻译页选了"模型翻译"，却要跑到系统页去填 Key。
 *
 * 做成自足组件（自己拉取/保存偏好）而不是把状态提到父级：它有 baseUrl、Key、型号、
 * 型号探测、提示词自检五组状态，提上去只会把宿主页面撑爆——原先它就是这么把
 * 设置页顶到一千多行的。
 */
export default function SummaryApiSettings(): JSX.Element {
  const [profiles, setProfiles] = useState<SummaryProfile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 正在编辑的那条（新建时 id 为空串）。 */
  const [draft, setDraft] = useState<SummaryProfile | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [probing, setProbing] = useState(false)
  const [probes, setProbes] = useState<SummaryModelProbe[] | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnosis, setDiagnosis] = useState<PromptDiagnosis[] | null>(null)
  const [saved, setSaved] = useState(false)
  /** 摘要请求是否开思考。默认关——见下面 label 里的实测数据。 */
  const [thinking, setThinking] = useState(false)

  const flash = useCallback(() => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1200)
  }, [])

  const apply = useCallback((r: { profiles: SummaryProfile[]; activeId: string | null }) => {
    setProfiles(r.profiles)
    setActiveId(r.activeId)
  }, [])

  useEffect(() => {
    void window.api.listSummaryProfiles().then(apply)
    void window.api.getPreferences().then((p) => setThinking(p.summaryThinkingEnabled === true))
  }, [apply])

  const toggleThinking = async (next: boolean): Promise<void> => {
    setThinking(next)
    try {
      await window.api.savePreferences({ summaryThinkingEnabled: next })
      flash()
    } catch {
      setThinking(!next)
    }
  }

  const newId = (): string =>
    `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  /** 保存草稿。key 留空 = 保留原有（改名字/型号不该把 Key 冲掉）。 */
  const saveDraft = async (): Promise<void> => {
    if (!draft || !draft.baseUrl.trim()) return
    const profile: SummaryProfile = { ...draft, id: draft.id || newId() }
    const key = keyInput.trim()
    apply(await window.api.upsertSummaryProfile(profile, key ? key : undefined))
    setDraft(null)
    setKeyInput('')
    flash()
  }

  const remove = async (id: string): Promise<void> => {
    apply(await window.api.deleteSummaryProfile(id))
    flash()
  }

  const activate = async (id: string): Promise<void> => {
    apply(await window.api.setActiveSummaryProfile(id))
    // 换服务商后旧的探测结果会误导（型号目录是上一家的），清掉。
    setProbes(null)
    setDiagnosis(null)
    flash()
  }

  /** 型号不做前端校验——能不能用只有服务端说了算，所以旁边给了探测按钮。 */
  const useProbedModel = async (m: string): Promise<void> => {
    const active = profiles.find((p) => p.id === activeId)
    if (!active) return
    apply(await window.api.upsertSummaryProfile({ ...active, model: m }))
    flash()
  }

  const runProbe = async (): Promise<void> => {
    setProbing(true)
    setProbes(null)
    try {
      setProbes(await window.api.probeSummaryModels())
    } catch (e) {
      setProbes([
        { model: '(探测失败)', ok: false, known: false, error: e instanceof Error ? e.message : String(e) }
      ])
    } finally {
      setProbing(false)
    }
  }

  const runDiagnose = async (): Promise<void> => {
    setDiagnosing(true)
    setDiagnosis(null)
    try {
      setDiagnosis(await window.api.diagnoseSummaryPrompt())
    } finally {
      setDiagnosing(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-elev px-3 py-2 text-sm text-zinc-200 outline-none focus:border-accent'
  const btnCls =
    'rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.06] disabled:opacity-50'

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs font-medium text-zinc-300">
          摘要 / 命名 API
          {saved && <span className="ml-2 text-[10px] text-emerald-400">已保存</span>}
        </div>
        <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
          会话命名、命令说明、思考摘要走这里；上面选「模型翻译」时，翻译也走这里。
          支持任意 OpenAI 兼容接口。API Key 使用系统安全存储，**不会发送给 Kimi**。
        </div>
        <div className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          可以存多套、随时切换——换服务商不会覆盖旧配置，想换回去点一下就行。
          Tran 内置串行队列与限流退避，撞到 429 会自动退避重试，不会让说明"时有时无"。
        </div>
      </div>

      {/* 已保存的配置：换服务商只是切换激活项，旧的 baseUrl/型号/Key 全部留着。
          原先是单份配置，改一次就把上一家覆盖没了，想换回去得重新找 Key。 */}
      <div className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-border-subtle bg-bg-panel">
        {profiles.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-zinc-600">
            还没有配置。用下面的预设一键添加，或手动新建。
          </div>
        )}
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              onClick={() => void activate(p.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              title={p.id === activeId ? '当前使用中' : '点击启用这套配置'}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${p.id === activeId ? 'bg-accent' : 'bg-zinc-700'}`}
              />
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-xs text-zinc-200">{p.name}</span>
                  {p.id === activeId && (
                    <span className="shrink-0 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      使用中
                    </span>
                  )}
                  {!p.keyMasked && (
                    <span className="shrink-0 text-[10px] text-amber-500/80">未填 Key</span>
                  )}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">
                  {p.baseUrl}
                  {p.model ? ` · ${p.model}` : ''}
                  {p.keyMasked ? ` · ${p.keyMasked}` : ''}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="shrink-0 text-[10px] text-zinc-600 transition hover:text-zinc-300"
              onClick={() => {
                setDraft({ ...p })
                setKeyInput('')
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="shrink-0 text-[10px] text-zinc-600 transition hover:text-red-300"
              onClick={() => void remove(p.id)}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {!draft && (
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className={btnCls}
              title={preset.note}
              onClick={() => {
                setDraft({ id: '', name: preset.name, baseUrl: preset.baseUrl, model: preset.model })
                setKeyInput('')
              }}
            >
              + {preset.name}
            </button>
          ))}
          <button
            type="button"
            className={btnCls}
            onClick={() => {
              setDraft({ id: '', name: '', baseUrl: '', model: '' })
              setKeyInput('')
            }}
          >
            + 自定义
          </button>
        </div>
      )}

      {draft && (
        <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-panel p-3">
          <div className="text-[11px] text-zinc-400">{draft.id ? '编辑配置' : '新建配置'}</div>
          <label className="block">
            <span className="mb-1 block text-[11px] text-zinc-500">名称</span>
            <input
              className={inputCls}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="DeepSeek / 备用通道 …"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-zinc-500">API Base URL</span>
            <input
              className={inputCls}
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-zinc-500">型号（留空 = 该服务默认）</span>
            <input
              className={inputCls}
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="deepseek-v4-flash"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-zinc-500">API Key</span>
            <input
              className={inputCls}
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={draft.keyMasked ? `已配置 ${draft.keyMasked} · 留空则不改` : 'sk-...'}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={btnCls}
              disabled={!draft.baseUrl.trim()}
              onClick={() => void saveDraft()}
            >
              保存
            </button>
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                setDraft(null)
                setKeyInput('')
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border-subtle bg-bg-panel p-2.5">
        <input
          type="checkbox"
          checked={thinking}
          onChange={(e) => void toggleThinking(e.target.checked)}
          className="mt-0.5 shrink-0 accent-[--color-accent]"
        />
        <span className="min-w-0">
          <span className="block text-xs text-zinc-300">开启模型思考</span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500">
            默认关。这些任务是 12~16 字的短摘要，推理帮不上忙却极烧额度——实测同一条命令说明，
            开思考多花 <span className="text-zinc-300">762 个推理 token</span>，关掉是 0，两边答案质量一样。
            免费额度按 token 算（推理 token 也算）。只有当你发现某个模型不推理就答不准时才开。
          </span>
        </span>
      </label>

      <div className="flex gap-2">
        <button type="button" className={btnCls} disabled={probing} onClick={() => void runProbe()}>
          {probing ? '探测中…' : '探测可用型号'}
        </button>
        <button type="button" className={btnCls} disabled={diagnosing} onClick={() => void runDiagnose()}>
          {diagnosing ? '自检中…' : '提示词自检'}
        </button>
      </div>

      {probes && (
        <div className="space-y-1 rounded-lg border border-white/[0.06] bg-bg-elev/60 p-2">
          {probes.map((p) => (
            <div key={p.model} className="flex items-baseline gap-2 text-[11px]">
              <span className={p.ok && p.known ? 'text-emerald-400' : p.ok ? 'text-amber-400' : 'text-zinc-600'}>
                {p.ok && p.known ? '✓' : p.ok ? '⚠' : '✕'}
              </span>
              <button
                type="button"
                disabled={!p.ok || !p.known}
                onClick={() => void useProbedModel(p.model)}
                className="font-mono text-zinc-300 enabled:hover:text-accent enabled:hover:underline disabled:cursor-default disabled:text-zinc-600"
                title={p.ok && p.known ? '点击选用该型号' : undefined}
              >
                {p.model}
              </button>
              {p.displayName && <span className="text-zinc-500">{p.displayName}</span>}
              {p.contextLength && <span className="text-zinc-600">{Math.round(p.contextLength / 1024)}k</span>}
              {p.error && <span className="truncate text-zinc-600">{p.error}</span>}
            </div>
          ))}
          <div className="pt-1 text-[10px] leading-relaxed text-zinc-600">
            先读 <code className="font-mono">/models</code> 判断型号是否存在，再发一条最小请求判断是否可用。
            部分兼容服务不提供模型目录，此时只报告接口通不通。
          </div>
        </div>
      )}

      {diagnosis && (
        <div className="space-y-1.5 rounded-lg border border-white/[0.06] bg-bg-elev/60 p-2">
          {diagnosis.map((d) => (
            <div key={d.label} className="space-y-0.5 text-[11px]">
              <div className="flex items-baseline gap-2">
                <span className={d.ok ? 'text-emerald-400' : 'text-red-400'}>{d.ok ? '✓' : '✕'}</span>
                <span className="text-zinc-300">{d.label}</span>
                <span className="text-zinc-600">{d.latencyMs} ms</span>
                {d.ok && (
                  <span className={d.cleaned ? 'text-emerald-400' : 'text-amber-400'}>
                    {d.cleaned ? `清洗后：${d.cleaned}` : '清洗后判废'}
                  </span>
                )}
              </div>
              {(d.output || d.error) && (
                <div className="break-all pl-5 font-mono text-[10px] leading-relaxed text-zinc-500">
                  {d.output ?? d.error}
                </div>
              )}
            </div>
          ))}
          <div className="pt-1 text-[10px] leading-relaxed text-zinc-600">
            形态 2 失败 = 端点不支持 stop；形态 3 失败 = 不接受 assistant 角色消息。
            失败行显示服务端原文。正式路径用的是形态 4（多轮少样本 + stop）。
          </div>
        </div>
      )}
    </div>
  )
}
