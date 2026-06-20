import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { AgentBackendId, SkillInfo, MarketplacePlugin } from '../../shared/ipc'
import DisclosureSelect from './DisclosureSelect'
import { onForgeEvent } from '../events'

type Tab = 'skills' | 'store'

/** Session-level cache: original text → Chinese translation. Survives tab/view
 *  switches so scrolling back doesn't re-call the API. */
const translateCache = new Map<string, string>()

/** Run an async fn over each item with at most `limit` in flight at once. A
 *  throwing fn on one item doesn't stop the others. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      try {
        await fn(items[idx])
      } catch {
        /* one chunk failing doesn't abort the rest */
      }
    }
  })
  await Promise.all(workers)
}

/** Track which `data-vidx` cards are inside the scroll viewport. `version`
 *  changes whenever the list contents change (so newly-rendered cards get
 *  observed). Items within `rootMargin` of the viewport count as visible, so
 *  translations start just before they scroll into view. */
function useVisibleKeys(
  rootRef: React.RefObject<HTMLDivElement>,
  enabled: boolean,
  version: unknown
): Set<number> {
  const [visible, setVisible] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!enabled || !rootRef.current) return
    const root = rootRef.current
    const obs = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const e of entries) {
            const idx = Number((e.target as HTMLElement).dataset.vidx)
            if (Number.isNaN(idx)) continue
            if (e.isIntersecting) {
              if (!next.has(idx)) {
                next.add(idx)
                changed = true
              }
            } else if (next.has(idx)) {
              next.delete(idx)
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root, rootMargin: '250px 0px' }
    )
    root.querySelectorAll('[data-vidx]').forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [enabled, rootRef, version])

  return visible
}

/** Translates the given (visible-only) texts via the model when `on` is true,
 *  caching results. `texts` must be referentially stable. Returns an accessor
 *  `tr(original) → translated|original` + a loading flag. */
function useTranslated(texts: string[], on: boolean): { tr: (t: string) => string; loading: boolean } {
  const [, bump] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!on) return
    const uncached = Array.from(
      new Set(texts.filter((t) => t && t.trim() && !translateCache.has(t)))
    )
    if (uncached.length === 0) return
    let cancelled = false
    // Debounce: wait until scrolling settles before translating. Each new
    // `texts` (visible-set change during fast scroll) resets this timer, so a
    // fast scroll fires ZERO requests — we only translate the resting viewport.
    // That's what keeps the model's rate limit from tripping.
    const timer = setTimeout(() => {
      if (cancelled) return
      setLoading(true)
      // Small chunks, gentle concurrency → translations stream in progressively.
      const CHUNK = 5
      const chunks: string[][] = []
      for (let i = 0; i < uncached.length; i += CHUNK) chunks.push(uncached.slice(i, i + CHUNK))
      void runWithConcurrency(chunks, 2, async (chunk) => {
        const translated = await window.api.translateTexts(chunk)
        if (cancelled) return
        chunk.forEach((t, i) => {
          if (translated[i]) translateCache.set(t, translated[i])
        })
        bump((n) => n + 1)
      }).finally(() => {
        if (!cancelled) setLoading(false)
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [texts, on])

  const tr = (t: string): string => (on && t && translateCache.has(t) ? translateCache.get(t)! : t)
  return { tr, loading }
}

export default function SkillsPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>('skills')
  const [translate, setTranslate] = useState(false)
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>('claude-code')
  const metaAgentBackend = useSessionStore((s) => s.meta?.agentBackend)
  const cwd = useSessionStore((s) => s.meta?.cwd)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const refreshAgentBackend = (): void => {
      void window.api.getPreferences().then((prefs) => {
        if (!cancelled) setAgentBackend(prefs.agentBackend ?? metaAgentBackend ?? 'claude-code')
      }).catch(() => {
        if (!cancelled) setAgentBackend(metaAgentBackend ?? 'claude-code')
      })
    }
    refreshAgentBackend()
    const offAgentBackend = onForgeEvent('agentBackendChanged', refreshAgentBackend)
    return () => {
      cancelled = true
      offAgentBackend()
    }
  }, [metaAgentBackend])

  return (
    <div ref={rootRef} className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-4 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-zinc-100">技能</h1>
          <button
            onClick={() => setTranslate((v) => !v)}
            className={`ml-1 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition ${
              translate
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-border-subtle bg-bg-elev text-zinc-400 hover:text-zinc-200'
            }`}
            title="用模型把看得见的描述翻译成中文(滚动到才翻译)"
          >
            译
            {translate && <span className="text-[10px]">中</span>}
          </button>
          <div className="ml-auto inline-flex rounded-lg border border-border-subtle bg-bg-elev p-0.5 text-xs">
            <button
              onClick={() => setTab('skills')}
              className={`rounded-md px-3 py-1 transition ${
                tab === 'skills' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              可用技能
            </button>
            <button
              onClick={() => setTab('store')}
              className={`rounded-md px-3 py-1 transition ${
                tab === 'store' ? 'bg-bg-hover text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              商店
            </button>
          </div>
        </div>

        {tab === 'skills' ? (
          <SkillsTab translate={translate} rootRef={rootRef} agentBackend={agentBackend} />
        ) : (
          <StoreTab
            translate={translate}
            rootRef={rootRef}
            agentBackend={agentBackend}
            cwd={cwd}
          />
        )}
      </div>
    </div>
  )
}

function SkillsTab({
  translate,
  rootRef,
  agentBackend
}: {
  translate: boolean
  rootRef: React.RefObject<HTMLDivElement>
  agentBackend: AgentBackendId
}): JSX.Element {
  const meta = useSessionStore((s) => s.meta)
  const starting = useSessionStore((s) => s.starting)
  const activeAgentBackend = meta?.agentBackend ?? agentBackend
  const skillRoot =
    activeAgentBackend === 'codex'
      ? '~/.codex/skills/'
      : activeAgentBackend === 'hermes'
        ? '~/.hermes/skills/'
        : '~/.claude/skills/'

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchSkills = useCallback(async (): Promise<void> => {
    if (!meta) return
    setLoading(true)
    setError(null)
    try {
      setSkills(await window.api.listSkills(meta.sessionId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [meta])

  useEffect(() => {
    if (!starting) void fetchSkills()
  }, [fetchSkills, starting])

  // index i here aligns with the skill index, so data-vidx maps to texts[i]
  const texts = useMemo(() => skills.map((s) => s.description), [skills])
  const visible = useVisibleKeys(rootRef, translate, skills)
  const visibleTexts = useMemo(
    () => Array.from(visible, (i) => texts[i]).filter(Boolean),
    [visible, texts]
  )
  const { tr, loading: translating } = useTranslated(visibleTexts, translate)

  return (
    <>
      <p className="mb-4 text-xs text-zinc-500">
        当前会话可用的技能(以 <code className="text-zinc-400">/技能名</code> 调用)。来自本地 skill
        目录与已启用的插件。
        {translating && <span className="ml-2 text-accent">翻译中…</span>}
        {translate && <span className="ml-1 text-zinc-600">(只翻译看得见的)</span>}
      </p>

      {starting && <div className="mb-3 text-sm text-zinc-500">会话启动中…</div>}
      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {loading && skills.length === 0 && (
        <div className="py-10 text-center text-sm text-zinc-500">加载中…</div>
      )}
      {!loading && !error && skills.length === 0 && (
        <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center text-sm text-zinc-400">
          没有可用的技能。
          <p className="mt-1 text-xs text-zinc-600">
            技能来自 <code className="text-zinc-500">{skillRoot}</code>{' '}
            或已安装的插件 —— 去商店看看。
          </p>
        </div>
      )}

      <div className="space-y-2">
        {skills.map((s, i) => (
          <div
            key={s.name}
            data-vidx={i}
            className="rounded-xl border border-border-subtle bg-bg-panel px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium text-accent">/{s.name}</span>
              {s.argumentHint && (
                <span className="font-mono text-[11px] text-zinc-600">{s.argumentHint}</span>
              )}
              {s.aliases && s.aliases.length > 0 && (
                <span className="text-[11px] text-zinc-600">
                  别名:{s.aliases.map((a) => `/${a}`).join('、')}
                </span>
              )}
            </div>
            {s.description && (
              <p className="mt-1 text-xs leading-relaxed text-zinc-400">{tr(s.description)}</p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function StoreTab({
  translate,
  rootRef,
  agentBackend,
  cwd
}: {
  translate: boolean
  rootRef: React.RefObject<HTMLDivElement>
  agentBackend: AgentBackendId
  cwd?: string
}): JSX.Element {
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      setPlugins([])
      setCategory('all')
      try {
        const nextPlugins = await window.api.listMarketplacePlugins(agentBackend, cwd)
        if (!cancelled) setPlugins(nextPlugins)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentBackend, cwd])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const p of plugins) if (p.category) set.add(p.category)
    return ['all', ...Array.from(set).sort()]
  }, [plugins])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return plugins.filter((p) => {
      if (category !== 'all' && p.category !== category) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.author ?? '').toLowerCase().includes(q)
      )
    })
  }, [plugins, query, category])

  const texts = useMemo(() => filtered.map((p) => p.description), [filtered])
  const visible = useVisibleKeys(rootRef, translate, filtered)
  const visibleTexts = useMemo(
    () => Array.from(visible, (i) => texts[i]).filter(Boolean),
    [visible, texts]
  )
  const { tr, loading: translating } = useTranslated(visibleTexts, translate)
  const agentName =
    agentBackend === 'codex' ? 'Codex' : agentBackend === 'hermes' ? 'Hermes' : 'Claude Code'

  return (
    <>
      <p className="mb-4 text-xs text-zinc-500">
        {agentBackend === 'codex' ? (
          <>浏览 Codex 插件市场目录。插件可提供技能与工具，安装与启用请在 Codex 的插件管理里完成。</>
        ) : agentBackend === 'hermes' ? (
          <>Hermes 的技能和插件由 Hermes 自身管理；这里会显示当前会话通过 ACP 暴露的命令。</>
        ) : (
          <>
            浏览 Claude Code 插件市场目录(本地缓存)。插件可打包技能与工具 —— 安装请在 Claude Code 里用{' '}
            <code className="text-zinc-400">/plugin</code> 命令。
          </>
        )}
        <span className="ml-2 rounded border border-border-subtle bg-bg-elev px-1.5 py-0.5 text-[10px] text-zinc-400">
          {agentName}
        </span>
        {translating && <span className="ml-2 text-accent">翻译中…</span>}
        {translate && <span className="ml-1 text-zinc-600">(只翻译看得见的)</span>}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索插件…"
          className="min-w-[12rem] flex-1 rounded-lg border border-border-subtle bg-bg-elev px-3 py-1.5 text-sm text-zinc-200 outline-none focus:border-accent"
        />
        <DisclosureSelect
          value={category}
          options={categories.map((c) => ({ value: c, label: c === 'all' ? '全部分类' : c }))}
          onChange={setCategory}
          className="min-w-[8rem]"
        />
      </div>

      {loading && <div className="py-10 text-center text-sm text-zinc-500">加载中…</div>}
      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-xl border border-border-subtle bg-bg-panel px-5 py-10 text-center text-sm text-zinc-400">
          没有匹配的插件。
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {filtered.map((p, i) => (
          <div
            key={`${p.marketplace}/${p.name}`}
            data-vidx={i}
            className="flex flex-col rounded-xl border border-border-subtle bg-bg-panel px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-zinc-100">{p.name}</span>
              {p.category && (
                <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {p.category}
                </span>
              )}
              {p.installed && (
                <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-zinc-500">
                  已安装
                </span>
              )}
              {p.enabled === false && (
                <span className="shrink-0 rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-zinc-500">
                  未启用
                </span>
              )}
            </div>
            {p.author && <div className="mt-0.5 text-[11px] text-zinc-600">{p.author}</div>}
            <p
              className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-400"
              title={p.description}
            >
              {tr(p.description) || '(无描述)'}
            </p>
            {p.homepage && (
              <a
                href={p.homepage}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-[11px] text-accent hover:underline"
              >
                主页 ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
