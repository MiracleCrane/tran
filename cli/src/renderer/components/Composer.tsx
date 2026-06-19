import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useSessionStore } from '../store/sessionStore'
import type { AgentBackendId, ComposerModel, PickedFile, EffortLevel, PermissionMode, Provider, SkillInfo } from '../../shared/ipc'
import DisclosureSelect from './DisclosureSelect'
import { defaultModelsForAgent, modelLabelForAgent } from '../../shared/models'
import { onForgeEvent } from '../events'

const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '很高' },
  { id: 'max', label: '最大' }
]

const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: '默认' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'plan', label: '计划模式' },
  { value: 'bypassPermissions', label: '跳过权限' },
  { value: 'auto', label: '自动' }
]

type PromptTemplate = { command: string; label: string; text: string }
type SlashCommandSource = 'template' | 'skill'

interface SlashContext {
  start: number
  end: number
  query: string
}

interface SlashCommandItem {
  id: string
  name: string
  label: string
  description: string
  source: SlashCommandSource
  insertText: string
  argumentHint?: string
  aliases?: string[]
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  { command: 'fix', label: '修复问题', text: '请定位并修复这个问题，完成后运行相关验证。' },
  { command: 'review', label: '代码审查', text: '请按 code review 方式检查当前改动，优先指出 bug、风险和缺失测试。' },
  { command: 'summary', label: '总结项目', text: '请快速梳理这个项目的结构、运行方式和关键模块。' },
  { command: 'test', label: '补测试', text: '请为当前改动补充最小但有效的测试，并说明覆盖点。' }
]

const SLASH_COMMAND_MAX_HEIGHT = 276
const SLASH_COMMAND_HEADER_HEIGHT = 34
const SLASH_COMMAND_ROW_HEIGHT = 48
const TEMPLATE_PANEL_MAX_HEIGHT = 232
const TEMPLATE_PANEL_HEADER_HEIGHT = 34
const TEMPLATE_PANEL_ROW_HEIGHT = 42
const COMPOSER_HEIGHT_STORAGE_KEY = 'forge.composerTextareaHeight.v1'

interface ComposerHeightBounds {
  min: number
  max: number
}

function composerHeightBoundsForViewport(viewportHeight: number): ComposerHeightBounds {
  const compact = viewportHeight < 680
  const min = compact ? 30 : 34
  const maxByViewport = Math.floor(viewportHeight * (compact ? 0.2 : 0.24))
  const maxCap = compact ? 128 : 184
  return { min, max: Math.max(min, Math.min(maxCap, maxByViewport)) }
}

function clampComposerHeight(value: number, bounds: ComposerHeightBounds): number {
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function roughAttachmentTokens(files: PickedFile[]): number {
  const textChars = files.reduce((sum, file) => sum + (file.kind === 'text' ? file.data.length : 0), 0)
  return Math.ceil(textChars / 4)
}

function normalizeSlashName(name: string): string {
  return name.replace(/^\/+/, '').trim()
}

function getSlashContext(value: string, caret: number): SlashContext | null {
  const beforeCaret = value.slice(0, caret)
  const match = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/)
  if (!match) return null
  const query = match[1] ?? ''
  return {
    start: caret - query.length - 1,
    end: caret,
    query
  }
}

function providerModels(providers: Provider[]): ComposerModel[] {
  return providers
    .map((provider) => provider.model.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: modelLabelForAgent(undefined, id) }))
}

function mergeModels(agentBackend: AgentBackendId | undefined, ...groups: ComposerModel[][]): ComposerModel[] {
  const seen = new Set<string>()
  const merged: ComposerModel[] = []
  for (const group of groups) {
    for (const model of group) {
      const id = model.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      merged.push({ id, label: model.label.trim() || modelLabelForAgent(agentBackend, id) })
    }
  }
  return merged
}

export default function Composer(): JSX.Element {
  const running = useSessionStore((s) => s.status.running)
  const starting = useSessionStore((s) => s.starting)
  const meta = useSessionStore((s) => s.meta)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const interrupt = useSessionStore((s) => s.interrupt)
  const setModel = useSessionStore((s) => s.setModel)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const effort = useSessionStore((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)
  const pending = useSessionStore((s) => s.pendingQueue)
  const [text, setText] = useState('')
  const [models, setModels] = useState(defaultModelsForAgent(undefined))
  const [attachments, setAttachments] = useState<PickedFile[]>([])
  const [showTemplates, setShowTemplates] = useState(false)
  const [slashSkills, setSlashSkills] = useState<SkillInfo[]>([])
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashError, setSlashError] = useState<string | null>(null)
  const [slashContext, setSlashContext] = useState<SlashContext | null>(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const heightBounds = useMemo(
    () => composerHeightBoundsForViewport(viewportHeight),
    [viewportHeight]
  )
  const [autoTextareaHeight, setAutoTextareaHeight] = useState(heightBounds.min)
  const [manualTextareaHeight, setManualTextareaHeight] = useState<number | null>(null)
  const [composerResizing, setComposerResizing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const slashListRef = useRef<HTMLDivElement | null>(null)
  const heightBoundsRef = useRef(heightBounds)
  const resizeCancelRef = useRef<(() => void) | null>(null)
  const attachmentActionSeqRef = useRef(0)
  const dragDepth = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const textareaHeight = manualTextareaHeight ?? autoTextareaHeight
  const isHermesAgent = meta?.agentBackend === 'hermes'

  useEffect(() => {
    heightBoundsRef.current = heightBounds
    setAutoTextareaHeight((height) => clampComposerHeight(height, heightBounds))
    setManualTextareaHeight((height) =>
      height === null ? null : clampComposerHeight(height, heightBounds)
    )
  }, [heightBounds])

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)
      const parsed = saved ? Number(saved) : NaN
      if (Number.isFinite(parsed)) {
        setManualTextareaHeight(clampComposerHeight(parsed, heightBoundsRef.current))
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const onResize = (): void => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('composer-resizing', composerResizing)
    return () => document.documentElement.classList.remove('composer-resizing')
  }, [composerResizing])

  useEffect(() => {
    return () => {
      resizeCancelRef.current?.()
      resizeCancelRef.current = null
    }
  }, [])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || manualTextareaHeight !== null) return

    const previousHeight = textarea.style.height
    textarea.style.height = 'auto'
    const measured = clampComposerHeight(textarea.scrollHeight, heightBounds)
    textarea.style.height = previousHeight
    setAutoTextareaHeight((height) => (height === measured ? height : measured))
  }, [heightBounds, manualTextareaHeight, text])

  // Model options follow the current backend: preferences are stored per
  // Windows/WSL backend, and providers are already backend-aware.
  useEffect(() => {
    let alive = true

    const refreshModels = async (): Promise<void> => {
      const prefs = await window.api.getPreferences()
      const usesClaudeProviders = (prefs.agentBackend ?? 'claude-code') === 'claude-code'
      const [providers, agentModels] = await Promise.all([
        usesClaudeProviders ? window.api.listProviders() : Promise.resolve([] as Provider[]),
        window.api.listAgentModels().catch(() => defaultModelsForAgent(prefs.agentBackend))
      ])
      if (!alive) return
      const defaultModels = defaultModelsForAgent(prefs.agentBackend)
      const configured =
        !usesClaudeProviders
          ? agentModels.length
            ? agentModels
            : prefs.composerModels?.length
              ? prefs.composerModels
              : defaultModels
          : prefs.composerModels?.length
            ? prefs.composerModels
            : agentModels.length
              ? agentModels
              : defaultModels
      const selected = meta?.model
        ? [{ id: meta.model, label: modelLabelForAgent(prefs.agentBackend, meta.model) }]
        : []
      setModels(mergeModels(prefs.agentBackend, configured, providerModels(providers), selected))
    }

    void refreshModels()
    const onModelsChanged = (): void => {
      void refreshModels()
    }
    const offProvider = onForgeEvent('providerChanged', onModelsChanged)
    const offModels = onForgeEvent('modelOptionsChanged', onModelsChanged)
    const offAgentBackend = onForgeEvent('agentBackendChanged', onModelsChanged)
    return () => {
      alive = false
      offProvider()
      offModels()
      offAgentBackend()
    }
  }, [meta?.model])

  useEffect(() => {
    let alive = true
    setSlashSkills([])
    setSlashError(null)
    if (!meta?.sessionId || starting) {
      setSlashLoading(false)
      return
    }

    setSlashLoading(true)
    void window.api.listSkills(meta.sessionId).then((skills) => {
      if (!alive) return
      setSlashSkills(skills)
    }).catch((e: unknown) => {
      if (!alive) return
      setSlashError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      if (alive) setSlashLoading(false)
    })

    return () => {
      alive = false
    }
  }, [meta?.sessionId, starting])

  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const templateCommands = PROMPT_TEMPLATES.map((template) => ({
      id: `template:${template.command}`,
      name: template.command,
      label: template.label,
      description: template.text,
      source: 'template' as const,
      insertText: template.text
    }))

    const skillCommands = slashSkills.reduce<SlashCommandItem[]>((commands, skill) => {
      const name = normalizeSlashName(skill.name)
      if (!name) return commands
      const aliases = skill.aliases?.map(normalizeSlashName).filter(Boolean)
      commands.push({
        id: `skill:${name}`,
        name,
        label: skill.argumentHint ? `/${name} ${skill.argumentHint}` : `/${name}`,
        description: skill.description,
        source: 'skill',
        insertText: `/${name} `,
        argumentHint: skill.argumentHint,
        aliases
      })
      return commands
    }, [])

    return [...templateCommands, ...skillCommands]
  }, [slashSkills])

  const slashFilteredCommands = useMemo(() => {
    const query = (slashContext?.query ?? '').trim().toLowerCase()
    if (!query) return slashCommands
    return slashCommands.filter((command) => {
      const targets = [
        command.name,
        command.label,
        command.description,
        ...(command.aliases ?? [])
      ].map((value) => value.toLowerCase())
      return targets.some((target) => target.includes(query))
    })
  }, [slashCommands, slashContext?.query])

  const slashMenuOpen = slashContext !== null
  const slashPanelHeight = slashMenuOpen
    ? Math.min(
        SLASH_COMMAND_MAX_HEIGHT,
        SLASH_COMMAND_HEADER_HEIGHT + Math.max(slashFilteredCommands.length, 1) * SLASH_COMMAND_ROW_HEIGHT + 8
      )
    : 0
  const templatePanelHeight = showTemplates
    ? Math.min(
        TEMPLATE_PANEL_MAX_HEIGHT,
        TEMPLATE_PANEL_HEADER_HEIGHT + PROMPT_TEMPLATES.length * TEMPLATE_PANEL_ROW_HEIGHT + 8
      )
    : 0
  const activeSlashCommand = slashFilteredCommands[slashSelectedIndex]

  useEffect(() => {
    setSlashSelectedIndex(0)
  }, [slashContext?.query])

  useEffect(() => {
    setSlashSelectedIndex((index) => {
      if (slashFilteredCommands.length === 0) return 0
      return Math.min(index, slashFilteredCommands.length - 1)
    })
  }, [slashFilteredCommands.length])

  useEffect(() => {
    const root = slashListRef.current
    if (!root || !slashMenuOpen) return
    const item = root.querySelector<HTMLElement>(`[data-slash-index="${slashSelectedIndex}"]`)
    item?.scrollIntoView({ block: 'nearest' })
  }, [slashMenuOpen, slashSelectedIndex])

  const updateSlashContext = (value: string, caret: number): void => {
    const nextContext = getSlashContext(value, caret)
    setSlashContext(nextContext)
    if (nextContext) setShowTemplates(false)
  }

  const refreshSlashContextFromTextarea = (): void => {
    const textarea = textareaRef.current
    if (!textarea) return
    updateSlashContext(textarea.value, textarea.selectionStart)
  }

  const applySlashCommand = (command: SlashCommandItem): void => {
    if (!slashContext) return
    const before = text.slice(0, slashContext.start)
    const after = text.slice(slashContext.end)
    const trailingSpace = after && !/^\s/.test(after) ? ' ' : ''
    const nextText = `${before}${command.insertText}${trailingSpace}${after}`
    const nextCaret = before.length + command.insertText.length + trailingSpace.length

    setText(nextText)
    setSlashContext(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const applyPromptTemplate = (template: PromptTemplate): void => {
    setText((current) => (current.trim() ? `${current.trim()}\n\n${template.text}` : template.text))
    setShowTemplates(false)
    setSlashContext(null)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  const pickAttachment = async (): Promise<void> => {
    if (!meta) return
    const actionSeq = ++attachmentActionSeqRef.current
    setDropError(null)
    const files = await window.api.pickFiles(meta.cwd)
    if (attachmentActionSeqRef.current !== actionSeq) return
    if (files.length) setAttachments((prev) => [...prev, ...files])
  }

  const removeAttachment = (i: number): void => {
    ++attachmentActionSeqRef.current
    setAttachments((prev) => prev.filter((_, idx) => idx !== i))
  }

  const resetTextareaHeight = (): void => {
    setManualTextareaHeight(null)
    try {
      window.localStorage.removeItem(COMPOSER_HEIGHT_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }

  const beginTextareaResize = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()

    resizeCancelRef.current?.()
    const startY = event.clientY
    const startHeight = textareaHeight
    let nextHeight = clampComposerHeight(startHeight, heightBoundsRef.current)
    let finished = false

    const finish = (): void => {
      if (finished) return
      finished = true
      setComposerResizing(false)
      resizeCancelRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      try {
        window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(nextHeight))
      } catch {
        /* ignore */
      }
    }

    const move = (moveEvent: PointerEvent): void => {
      nextHeight = clampComposerHeight(startHeight + startY - moveEvent.clientY, heightBoundsRef.current)
      setManualTextareaHeight(nextHeight)
    }

    setComposerResizing(true)
    setManualTextareaHeight(nextHeight)
    resizeCancelRef.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  const hasFileDrag = (e: DragEvent<HTMLElement>): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = meta ? 'copy' : 'none'
    dragDepth.current += 1
    if (meta) {
      setDropError(null)
      setDragActive(true)
    }
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = meta ? 'copy' : 'none'
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }

  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setDragActive(false)
    setDropError(null)
    if (!meta) return

    const paths = Array.from(
      new Set(
        Array.from(e.dataTransfer.files)
          .map((file) => window.api.getPathForFile(file))
          .filter((path) => path.length > 0)
      )
    )

    if (!paths.length) {
      setDropError('无法读取拖入文件路径')
      return
    }

    const actionSeq = ++attachmentActionSeqRef.current
    const files = await window.api.readFiles(meta.cwd, paths)
    if (attachmentActionSeqRef.current !== actionSeq) return
    if (files.length) setAttachments((prev) => [...prev, ...files])
    if (files.length < paths.length) {
      setDropError(`有 ${paths.length - files.length} 个文件无法引用`)
    }
  }

  const submit = async (): Promise<void> => {
    const value = text.trim()
    const atts = attachments
    if (!value && atts.length === 0) return
    ++attachmentActionSeqRef.current
    const finalText = value
    setText('')
    setSlashContext(null)
    setAttachments([])
    void sendMessage(finalText, atts.length ? atts : undefined)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((index) => (
          slashFilteredCommands.length ? (index + 1) % slashFilteredCommands.length : 0
        ))
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((index) => (
          slashFilteredCommands.length
            ? (index - 1 + slashFilteredCommands.length) % slashFilteredCommands.length
            : 0
        ))
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashContext(null)
        return
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (activeSlashCommand) applySlashCommand(activeSlashCommand)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer-shell bg-transparent px-6 pb-3 pt-2">
      <div className="mx-auto max-w-5xl">
        {pending.length > 0 && (
          <div className="mb-2 flex flex-col items-end gap-1.5">
            {pending.map((p) => (
              <div
                key={p.id}
                className="glass-panel flex max-w-[80%] items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-1.5 text-xs text-zinc-400"
              >
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-zinc-500" />
                <span className="truncate">
                  排队中 · {p.text || (p.attachments?.length ? `${p.attachments.length} 个附件` : '…')}
                </span>
              </div>
            ))}
          </div>
        )}
        <div
          className={`glass-panel composer-panel rounded-[18px] p-3 transition ${
            dragActive ? 'border-accent/60 bg-white/[0.035] shadow-[0_0_0_1px_rgba(223,118,95,0.28)]' : ''
          } ${composerResizing ? 'is-resizing' : ''}`}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
        >
          <div
            className="composer-resize-zone"
            role="separator"
            aria-orientation="horizontal"
            tabIndex={0}
            aria-label="调整输入框高度"
            title="拖动调整输入框高度，双击恢复自动"
            onPointerDown={beginTextareaResize}
            onDoubleClick={resetTextareaHeight}
          />
          <div
            className={`slash-command-reveal ${slashMenuOpen ? 'is-open' : ''}`}
            style={{ height: slashPanelHeight }}
          >
            <div className="slash-command-panel">
              <div className="flex items-center justify-between px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">
                <span>快捷命令</span>
                {slashContext && <span className="font-mono text-zinc-600">/{slashContext.query}</span>}
              </div>
              <div ref={slashListRef} className="slash-command-list git-stable-scroll">
                {slashLoading && slashFilteredCommands.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-zinc-500">命令加载中…</div>
                ) : slashError && slashFilteredCommands.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-red-300">{slashError}</div>
                ) : slashFilteredCommands.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-zinc-500">没有匹配命令</div>
                ) : (
                  slashFilteredCommands.map((command, index) => (
                    <button
                      key={command.id}
                      type="button"
                      data-slash-index={index}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        applySlashCommand(command)
                      }}
                      className={`slash-command-item ${index === slashSelectedIndex ? 'is-active' : ''}`}
                      aria-selected={index === slashSelectedIndex}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-[12px] text-zinc-200">/{command.name}</span>
                          {command.argumentHint && (
                            <span className="truncate font-mono text-[10px] text-zinc-600">{command.argumentHint}</span>
                          )}
                          <span className="shrink-0 rounded bg-white/[0.055] px-1.5 py-0.5 text-[9px] text-zinc-500">
                            {command.source === 'skill' ? 'Skill' : '模板'}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                          {command.source === 'template' ? command.label : command.description}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
          <div
            className={`template-panel-reveal ${showTemplates ? 'is-open' : ''}`}
            style={{ height: templatePanelHeight }}
          >
            <div className="template-panel">
              <div className="flex items-center justify-between px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500/80">
                <span>Prompt 模板</span>
                <span className="text-zinc-600">{PROMPT_TEMPLATES.length} 个</span>
              </div>
              <div className="template-panel-list git-stable-scroll">
                {PROMPT_TEMPLATES.map((template) => (
                  <button
                    key={template.label}
                    type="button"
                    onClick={() => applyPromptTemplate(template)}
                    className="template-panel-item"
                  >
                    <span className="font-medium text-zinc-200">{template.label}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{template.text}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              updateSlashContext(e.target.value, e.target.selectionStart)
            }}
            onKeyDown={onKey}
            onKeyUp={(e) => {
              if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return
              refreshSlashContextFromTextarea()
            }}
            onClick={refreshSlashContextFromTextarea}
            onSelect={refreshSlashContextFromTextarea}
            rows={1}
            placeholder={
              running
                ? 'Forge 正在处理…(可继续发送,消息会排队)'
                : '给 Forge 发消息…'
            }
            style={{
              height: textareaHeight,
              minHeight: heightBounds.min,
              maxHeight: heightBounds.max
            }}
            className="composer-textarea w-full resize-none rounded-xl border border-transparent bg-transparent px-3 py-2 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-white/10 focus:bg-white/[0.025]"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pt-2">
              {attachments.map((a, i) => (
                <span
                  key={`${a.path}-${i}`}
                  className="glass-control flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-zinc-300"
                  title={a.path}
                >
                  <span className="text-zinc-500">{a.kind === 'image' ? '🖼' : a.kind === 'text' ? '📄' : '📎'}</span>
                  <span className="max-w-[12rem] truncate">{a.name}</span>
                  <button
                    onClick={() => removeAttachment(i)}
                    className="text-zinc-500 transition hover:text-red-300"
                    title="移除"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="px-1 pt-1 text-[11px] text-zinc-600">
              附件 {attachments.length} 个 / {formatBytes(attachments.reduce((sum, file) => sum + file.size, 0))}
              {roughAttachmentTokens(attachments) > 0 && ` / 约 ${roughAttachmentTokens(attachments).toLocaleString()} tokens`}
            </div>
          )}
          {dropError && (
            <div className="px-1 pt-2 text-[11px] text-orange-300">{dropError}</div>
          )}
          <div className="composer-toolbar flex flex-wrap items-center gap-2 px-1 pt-2">
            <button
              type="button"
              onClick={() => void pickAttachment()}
              disabled={!meta}
              className="glass-control flex h-9 w-9 items-center justify-center rounded-xl text-zinc-300 transition hover:bg-white/[0.09] disabled:opacity-40"
              title="添加附件(从工作目录选择文件)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.8-8.8a3.5 3.5 0 0 1 5 5L10.4 18a2 2 0 0 1-2.8-2.8l7.7-7.7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <span className="composer-shortcut-hint px-2 text-[11px] text-zinc-500">
              <kbd className="font-sans text-zinc-400">Enter</kbd> 发送 ·{' '}
              <kbd className="font-sans text-zinc-400">Shift+Enter</kbd> 换行
            </span>
            <div className="composer-actions ml-auto flex items-end gap-2">
              {meta && (
                <DisclosureSelect
                  value={meta.permissionMode}
                  options={PERMISSION_MODE_OPTIONS}
                  onChange={(v) => {
                    if (v !== meta.permissionMode) void setPermissionMode(v as PermissionMode)
                  }}
                  placement="top"
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6l7.5-3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
                  className="min-w-36"
                />
              )}
              {meta && (
                <DisclosureSelect
                  value={effort}
                  options={EFFORTS.map((o) => ({ value: o.id, label: o.label }))}
                  onChange={(v) => {
                    if (v !== effort) void setEffort(v as EffortLevel)
                  }}
                  placement="top"
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M5 20V14M12 20V8M19 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  }
                  className="w-fit"
                />
              )}
              {meta && (
                <DisclosureSelect
                  value={meta.model}
                  options={models.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(v) => void setModel(v)}
                  placement="top"
                  disabled={isHermesAgent}
                  title={isHermesAgent ? 'Hermes 模型由 hermes model 或 config.yaml 管理' : undefined}
                  className="min-w-36"
                />
              )}
              {running && (
                <button
                  onClick={() => void interrupt()}
                  className="h-10 shrink-0 rounded-xl border border-red-900/60 bg-red-950/40 px-4 text-sm font-medium text-red-300 hover:bg-red-950/60"
                  title="中断当前处理"
                >
                  停止
                </button>
              )}
              <button
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                className="accent-soft-button h-10 shrink-0 rounded-xl px-5 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                发送
              </button>
              <button
                type="button"
                onClick={() => {
                  setSlashContext(null)
                  setShowTemplates((open) => !open)
                }}
                className={`glass-control composer-template-button flex h-10 items-center justify-center rounded-xl px-3 text-xs text-zinc-300 transition ${
                  showTemplates ? 'is-open' : ''
                }`}
                title="Prompt 模板"
              >
                模板
              </button>
            </div>
          </div>
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[18px] border border-dashed border-accent/70 bg-black/55 backdrop-blur-sm">
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-sm font-medium text-zinc-100 shadow-lg">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-accent">
                  <path
                    d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.8-8.8a3.5 3.5 0 0 1 5 5L10.4 18a2 2 0 0 1-2.8-2.8l7.7-7.7"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>松开以引用文件</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
