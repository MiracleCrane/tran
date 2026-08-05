import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { useSessionStore } from '../store/sessionStore'
import { useUiStore } from '../store/uiStore'
import type { AgentBackendId, ComposerModel, PickedFile, EffortLevel, PermissionMode } from '../../shared/ipc'
import DisclosureSelect from './DisclosureSelect'
import ModePanel from './ModePanel'
import { AGENT_TOOL_NAMES, BASH_TOOL_NAMES, countRunningTools, countTotalTools } from '../utils/toolStats'
import { pickedFileToUserAttachment, splitPickedFiles, userAttachmentToPickedFile } from '../utils/attachments'
import ChipPopover, { type ChipAnchor, type ChipKind } from './ChipPopover'
import UsageRings from './UsageRings'
import { defaultModelsForAgent, modelLabelForAgent } from '../../shared/models'
import { onForgeEvent } from '../events'

const EFFORTS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最大' }
]

const PERMISSION_MODE_OPTIONS: {
  value: PermissionMode
  label: string
  menuLabel?: string
  description: string
  accentClass?: string
}[] = [
  { value: 'default', label: '逐条确认', menuLabel: '逐条确认 (default)', description: '每个工具操作都需要手动确认' },
  // 映射依据 kimi 语义：yolo=自动批准全部工具操作但仍会与用户交互（自动通过）；
  // auto=完全无人值守、审批与提问全自己拍板（完全自主）。此前两值曾映射反。
  // 触发按钮宽度有限，label 只留中文短名；英文模式名放 menuLabel 在下拉项里展示。
  { value: 'yolo', label: '自动通过', menuLabel: '自动通过 (yolo)', description: '自动批准全部工具操作，但关键问题仍会询问', accentClass: 'text-amber-300' },
  { value: 'auto', label: '完全自主', menuLabel: '完全自主 (auto)', description: '完全自主运行、不再询问（慎用）', accentClass: 'text-red-300' }
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
  // #10：上限对齐"8~10 行"（行高 ~22.75px + 上下 padding 16px），常规窗口 224px ≈ 9 行。
  const maxCap = compact ? 128 : 224
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

/** 未能附加的文件汇成一行提示：最多列两条具体原因，其余折成计数，
 *  免得一次拖十个失败文件把输入区顶开。missing = 连占位条目都没回来的份额。 */
function describeSkippedFiles(errors: string[], missing = 0): string | null {
  const shown = errors.slice(0, 2)
  const rest = errors.length - shown.length + Math.max(0, missing)
  if (rest > 0) shown.push(`另有 ${rest} 个文件未能附加`)
  return shown.length ? shown.join('；') : null
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

/** #性能：状态 chips 相关的 5 个选择器此前每次 store 更新都各自全量扫 items
 *  （流式期间每帧一次 × 5）。合并为一次计算并按 items 引用做模块级 WeakMap
 *  缓存：items 引用未变直接复用上次结果；runningBash/runningAgents 还依赖
 *  swarmTasks 与 turn running，两者一并纳入缓存失效条件。组件里的选择器仍
 *  逐字段取原始值（数字/布尔），值没变就不触发重渲染，行为与原先一致。 */
type SessionSnapshot = ReturnType<typeof useSessionStore.getState>

interface ToolChipStats {
  bashTotal: number
  runningBash: number
  agentTotal: number
  runningAgents: number
  /** ACP 侧是否有 running/pending 的 AgentSwarm 工具调用（Swarm 徽章兜底）。 */
  swarmToolActive: boolean
}

const toolChipStatsCache = new WeakMap<
  SessionSnapshot['items'],
  { swarmTasks: SessionSnapshot['swarmTasks']; running: boolean; stats: ToolChipStats }
>()

function getToolChipStats(s: SessionSnapshot): ToolChipStats {
  const running = s.status.running
  const cached = toolChipStatsCache.get(s.items)
  if (cached && cached.swarmTasks === s.swarmTasks && cached.running === running) {
    return cached.stats
  }
  const stats: ToolChipStats = {
    bashTotal: countTotalTools(s.items, BASH_TOOL_NAMES),
    runningBash: countRunningTools(s.items, BASH_TOOL_NAMES, s.swarmTasks, running),
    agentTotal: countTotalTools(s.items, AGENT_TOOL_NAMES),
    runningAgents: countRunningTools(s.items, AGENT_TOOL_NAMES, s.swarmTasks, running),
    swarmToolActive: s.items.some(
      (item) =>
        item.kind === 'assistant' &&
        item.blocks.some(
          (b) =>
            b && b.kind === 'tool' && b.name === 'AgentSwarm' && (b.status === 'running' || b.status === 'pending')
        )
    )
  }
  toolChipStatsCache.set(s.items, { swarmTasks: s.swarmTasks, running, stats })
  return stats
}

/** 1s 心跳：让忙碌态计时/无响应时长随时间递增。 */
function useSecondTick(): void {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
}

/** #41 忙碌态已运行时长（mm:ss 递增；startedAt 由主进程随 turn 开始推送）。 */
function TurnElapsed({ startedAt }: { startedAt: number }): JSX.Element {
  useSecondTick()
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return <span className="font-mono">（{mm}:{ss}）</span>
}

/** #41 疑似无响应提示：静默超阈值后由主进程推送（system/turn_stall），显示
 *  已静默分钟数（随心跳递增）+ 继续等待/打断两个操作（打断走现有 cancel 路径）。 */
function TurnStallNotice({
  stall,
  onDismiss,
  onInterrupt
}: {
  stall: { elapsedMs: number; silentMs: number; at: number }
  onDismiss: () => void
  onInterrupt: () => void
}): JSX.Element {
  useSecondTick()
  const silentMin = Math.max(1, Math.floor((stall.silentMs + Date.now() - stall.at) / 60000))
  return (
    <span className="flex shrink-0 items-center gap-2 text-amber-300/90">
      <span>已 {silentMin} 分钟无响应</span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-300 transition hover:bg-white/[0.08]"
        title="继续等待本轮完成（若持续无响应会再次提醒）"
      >
        继续等待
      </button>
      <button
        type="button"
        onClick={onInterrupt}
        className="rounded border border-red-900/60 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-300 transition hover:bg-red-950/60"
        title="打断本轮（与停止按钮同一条 cancel 路径）"
      >
        打断
      </button>
    </span>
  )
}

export default function Composer(): JSX.Element {
  const running = useSessionStore((s) => s.status.running)
  // #41 忙碌态计时（turn 开始时间戳）与疑似无响应提示。
  const turnStartedAt = useSessionStore((s) => s.status.startedAt)
  const turnStall = useSessionStore((s) => s.status.stall)
  const dismissTurnStall = useSessionStore((s) => s.dismissTurnStall)
  const starting = useSessionStore((s) => s.starting)
  const meta = useSessionStore((s) => s.meta)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const interrupt = useSessionStore((s) => s.interrupt)
  const setModel = useSessionStore((s) => s.setModel)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const modeBeforePlan = useSessionStore((s) => s.modePanel.modeBeforePlan)
  const effort = useSessionStore((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)
  const pending = useSessionStore((s) => s.pendingQueue)
  // 状态 chips（常驻行）：计数=会话累计（含历史重放），运行中数用于高亮和 (r/N) 显示。
  // 计算走 getToolChipStats 的引用缓存，5 个选择器共享同一次 items 扫描。
  const bashTotal = useSessionStore((s) => getToolChipStats(s).bashTotal)
  const runningBash = useSessionStore((s) => getToolChipStats(s).runningBash)
  const agentTotal = useSessionStore((s) => getToolChipStats(s).agentTotal)
  const runningAgents = useSessionStore((s) => getToolChipStats(s).runningAgents)
  // #5c 忙碌原因（输入区提示文案用）：权限确认 / 提问等待 / 后台子任务。
  const pendingPermissionCount = useSessionStore((s) => s.pendingPermissions.length)
  const elicitationCount = useSessionStore((s) => s.elicitationQueue.length)
  const hasBackgroundSubagent = useSessionStore((s) =>
    s.tasks.some((t) => t.isBackgrounded && t.status === 'running')
  )
  // chips 独立浮层：openChip=哪个 chip 的浮层开着 + 锚点（portal fixed 定位）。
  const [openChip, setOpenChip] = useState<ChipKind | null>(null)
  const [chipAnchor, setChipAnchor] = useState<ChipAnchor | null>(null)
  const chipRowRef = useRef<HTMLDivElement | null>(null)

  const toggleChip = (kind: ChipKind): void => {
    if (openChip === kind) {
      setOpenChip(null)
      return
    }
    const row = chipRowRef.current
    const btn = row?.querySelector<HTMLElement>(`[data-chip="${kind}"]`)
    const rect = btn?.getBoundingClientRect()
    if (rect) {
      setChipAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)),
        bottom: window.innerHeight - rect.top + 8
      })
    }
    setOpenChip(kind)
  }

  // 排队卡片：× 从队列删除；点击卡片取回编辑（文本回 textarea、附件回附件区）。
  const removePendingMessage = useSessionStore((s) => s.removePendingMessage)
  const takePendingMessage = useSessionStore((s) => s.takePendingMessage)
  // #20 出错悬置时的出路：重发全部 / 清空队列。#13：错误可手动关闭。
  const clearPendingQueue = useSessionStore((s) => s.clearPendingQueue)
  const resendPendingQueue = useSessionStore((s) => s.resendPendingQueue)
  const clearError = useSessionStore((s) => s.clearError)
  const restorePending = (id: string): void => {
    const msg = takePendingMessage(id)
    if (!msg) return
    setText(msg.text)
    if (msg.attachments?.length) {
      setAttachments((prev) => [...prev, ...msg.attachments!.map(userAttachmentToPickedFile)])
    }
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const statusError = useSessionStore((s) => s.status.error)
  const stopReason = useSessionStore((s) => s.status.stopReason)
  // #31 草稿提升到 store 并按会话持久化（localStorage）：切视图/切会话/重启不丢，
  // 发送成功后清空。键优先 sdkSessionId（resume 后稳定）；新会话 init 前暂无
  // sdk id，暂挂 bridge sessionId，init 到达后迁移（见下方 effect）。
  const draftKey = meta?.sdkSessionId ?? meta?.sessionId ?? null
  const text = useSessionStore((s) => (draftKey ? (s.composerDrafts[draftKey] ?? '') : ''))
  const setComposerDraft = useSessionStore((s) => s.setComposerDraft)
  const setText = (value: string | ((current: string) => string)): void => {
    if (!draftKey) return
    const next =
      typeof value === 'function'
        ? value(useSessionStore.getState().composerDrafts[draftKey] ?? '')
        : value
    setComposerDraft(draftKey, next)
  }
  // 新会话 init 到达后，把暂挂 bridge id 键下的草稿迁到稳定的 sdk id 键。
  useEffect(() => {
    if (!meta?.sdkSessionId || !draftKey) return
    const staleKey = meta.sessionId
    if (staleKey === meta.sdkSessionId) return
    const drafts = useSessionStore.getState().composerDrafts
    const stale = drafts[staleKey]
    if (stale && !drafts[meta.sdkSessionId]) {
      setComposerDraft(meta.sdkSessionId, stale)
      setComposerDraft(staleKey, '')
    }
  }, [meta?.sdkSessionId, meta?.sessionId, draftKey, setComposerDraft])
  const [models, setModels] = useState(defaultModelsForAgent(undefined))
  const [attachments, setAttachments] = useState<PickedFile[]>([])
  const [showTemplates, setShowTemplates] = useState(false)
  // Kimi ACP 推送的斜杠命令（available_commands_update → sessionStore）。
  const slashSkills = useSessionStore((s) => s.slashCommands)
  // Swarm 状态：server tasks 有 running 子代理，或 ACP 侧有 running/pending 的
  // AgentSwarm 工具调用（server 不可用时的兜底检测）。
  const swarmRunning = useSessionStore((s) =>
    (s.swarmTasks?.some((t) => t.kind === 'subagent' && t.status === 'running') ?? false) ||
    getToolChipStats(s).swarmToolActive
  )

  // 兜底：订阅仍为空时通过 listSkills IPC 主动拉一次（后端 listSkills 返回
  // session.skills，缓冲队列修复后它在 start 期间已被正确赋值）。订阅优先，
  // 拉取只在订阅为空时补。
  useEffect(() => {
    if (!meta?.sessionId || starting) return
    if (useSessionStore.getState().slashCommands.length > 0) return
    void window.api.listSkills(meta.sessionId).then((skills) => {
      if (skills.length && useSessionStore.getState().slashCommands.length === 0) {
        useSessionStore.setState({ slashCommands: skills })
      }
    }).catch(() => {})
  }, [meta?.sessionId, starting])
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
  // Composer 常驻挂载，切会话不重建组件。草稿文本按 draftKey 隔离，附件此前
  // 没有——在 A 会话加了附件不发、切到 B，附件会跟着 B 一起发出去。切换时
  // 清空，并递增 seq 作废在途的异步读取（readFiles / FileReader），
  // 否则切换后才 resolve 的那批会把上一个会话的文件追加进来。
  useEffect(() => {
    setAttachments([])
    ++attachmentActionSeqRef.current
  }, [draftKey])
  const dragDepth = useRef(0)
  const [dragActive, setDragActive] = useState(false)
  // 附件添加失败提示（选择器/拖拽/粘贴共用）：超限图片等被主进程跳过的文件
  // 以前只进日志，用户侧什么都看不见。
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  // 附件文件选择器等待指示（局部 spinner，不整屏转圈）。
  const [pickingFile, setPickingFile] = useState(false)
  const textareaHeight = manualTextareaHeight ?? autoTextareaHeight

  useEffect(() => {
    heightBoundsRef.current = heightBounds
    setAutoTextareaHeight((height) => clampComposerHeight(height, heightBounds))
    setManualTextareaHeight((height) =>
      height === null ? null : clampComposerHeight(height, heightBounds)
    )
  }, [heightBounds])

  // 手动拖拽高度只在本次运行内生效，不写 localStorage（#38 后续：
  // 顶边手柄带很隐蔽，误拖即永久锁死自动增高，用户无从恢复）。
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

  // Model options follow the current backend: 用户自定义列表优先，其次后端
  // (ACP configOptions) 上报的模型，最后兜底内置列表。
  useEffect(() => {
    let alive = true

    const refreshModels = async (): Promise<void> => {
      const prefs = await window.api.getPreferences()
      const agentModels = await window.api
        .listAgentModels()
        .catch(() => defaultModelsForAgent(prefs.agentBackend))
      if (!alive) return
      const defaultModels = defaultModelsForAgent(prefs.agentBackend)
      const configured = prefs.composerModels?.length
        ? prefs.composerModels
        : agentModels.length
          ? agentModels
          : defaultModels
      const selected = meta?.model
        ? [{ id: meta.model, label: modelLabelForAgent(prefs.agentBackend, meta.model) }]
        : []
      setModels(mergeModels(prefs.agentBackend, configured, selected))
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

    return [...skillCommands, ...templateCommands]
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
    setAttachmentError(null)
    // 局部小指示（不整屏转圈）：按钮上 spinner，页面其余部分保持可操作。
    setPickingFile(true)
    let files: Awaited<ReturnType<typeof window.api.pickFiles>> = []
    try {
      files = await window.api.pickFiles(meta.cwd)
    } finally {
      setPickingFile(false)
    }
    if (attachmentActionSeqRef.current !== actionSeq) return
    const { files: added, errors } = splitPickedFiles(files)
    if (added.length) setAttachments((prev) => [...prev, ...added])
    setAttachmentError(describeSkippedFiles(errors))
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
    let finished = false
    /** 位移阈值：只是点了一下手柄（0 位移）不该锁死高度。原先在 pointerdown
     *  里就 setManualTextareaHeight，于是误点一次自动增高就此关闭，只能靠
     *  「恢复自动高度」按钮救回来——手柄本身很窄，误点是常态。 */
    const DRAG_THRESHOLD_PX = 3
    let dragging = false

    const finish = (): void => {
      if (finished) return
      finished = true
      setComposerResizing(false)
      resizeCancelRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }

    const move = (moveEvent: PointerEvent): void => {
      const delta = startY - moveEvent.clientY
      if (!dragging) {
        if (Math.abs(delta) < DRAG_THRESHOLD_PX) return
        dragging = true
        setComposerResizing(true)
      }
      setManualTextareaHeight(clampComposerHeight(startHeight + delta, heightBoundsRef.current))
    }

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
      setAttachmentError(null)
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
    setAttachmentError(null)
    if (!meta) return

    const paths = Array.from(
      new Set(
        Array.from(e.dataTransfer.files)
          .map((file) => window.api.getPathForFile(file))
          .filter((path) => path.length > 0)
      )
    )

    if (!paths.length) {
      setAttachmentError('无法读取拖入文件路径')
      return
    }

    const actionSeq = ++attachmentActionSeqRef.current
    const files = await window.api.readFiles(meta.cwd, paths)
    if (attachmentActionSeqRef.current !== actionSeq) return
    const { files: added, errors } = splitPickedFiles(files)
    if (added.length) setAttachments((prev) => [...prev, ...added])
    setAttachmentError(describeSkippedFiles(errors, paths.length - files.length))
  }

  /** 剪贴板粘贴图片（截图工具/复制的图片）：与拖拽走同一附件管线，
   *  无图片时保持默认文本粘贴行为。 */
  const onPaste = async (e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (!meta) return
    const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    e.preventDefault()
    setAttachmentError(null)
    const actionSeq = ++attachmentActionSeqRef.current
    const picked: PickedFile[] = []
    const errors: string[] = []
    for (const file of images) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        })
        const comma = dataUrl.indexOf(',')
        const ext = file.type.split('/')[1]?.split(';')[0] || 'png'
        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
        picked.push({
          path: '',
          name: `粘贴图片-${stamp}${picked.length ? `-${picked.length + 1}` : ''}.${ext}`,
          kind: 'image',
          mimeType: file.type,
          data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
          size: file.size
        })
      } catch {
        // 单个文件读取失败不影响其余，但要让用户看见（否则粘贴后毫无反应）。
        errors.push(`无法附加剪贴板图片（${file.type || '未知格式'}）`)
      }
    }
    if (attachmentActionSeqRef.current !== actionSeq) return
    if (picked.length) setAttachments((prev) => [...prev, ...picked])
    setAttachmentError(describeSkippedFiles(errors))
  }

  const submit = async (cutIn = false): Promise<void> => {
    const value = text.trim()
    const atts = attachments
    if (!value && atts.length === 0) return
    // /usage 是 Tran 原生命令：打开用量面板，不发给 agent。
    if (value === '/usage' && atts.length === 0) {
      setText('')
      setSlashContext(null)
      useUiStore.getState().setUsageOpen(true)
      return
    }
    ++attachmentActionSeqRef.current
    const finalText = value
    setText('')
    setSlashContext(null)
    setAttachments([])
    void sendMessage(finalText, atts.length ? atts : undefined, cutIn ? { cutIn: true } : undefined)
  }

  /** Ctrl+S 打断并发送（插队）：运行中先中断（interrupt 乐观清 running），
   *  再立即发送（不走 pendingQueue）；无文本则只中断。
   *  #29：输入框为空但队列里有已提交待发的消息（含 turn 出错后回收回来的）
   *  时，打断后直接重发队列——否则这些消息会一直晾在队列里，等同被吞。 */
  const cutInSubmit = async (): Promise<void> => {
    if (running) await interrupt()
    if (!text.trim() && attachments.length === 0 && pending.length > 0) {
      await resendPendingQueue()
      return
    }
    await submit(true)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组词期间不响应回车/上下键。
    //
    // 实测（Chromium 141）：真实 Windows 输入法确认候选词时，keydown 的
    // key 是 "Process"、keyCode 229，不会命中下面的 'Enter' 分支——所以这
    // 不是当前会稳定复现的 bug，属于补齐防御。但合成事件（CDP）与部分第三方
    // 输入法确实会派发 isComposing=true 的 Enter，此时若不拦，会把没上屏的
    // 拼音当消息发出去，且 preventDefault 还会吞掉选字确认。
    // 上下键同理：组词时那是在选候选词，不该被历史/斜杠菜单抢走。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault() // 别触发浏览器保存
      void cutInSubmit()
      return
    }
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
          <div className="mb-1.5">
            <div className="mb-1 flex items-center gap-2 px-1 text-[10px] text-zinc-600">
              {statusError && !running ? (
                <>
                  {/* #20：turn 出错后队列不再自动落地，给出明确出路。 */}
                  <span className="text-red-400/90">
                    队列 · {pending.length}　会话出错，排队消息已暂停发送
                  </span>
                  <button
                    type="button"
                    onClick={() => void resendPendingQueue()}
                    className="rounded px-1 text-accent transition hover:bg-white/[0.05]"
                    title="依次重发全部排队消息"
                  >
                    重发
                  </button>
                  <button
                    type="button"
                    onClick={clearPendingQueue}
                    className="rounded px-1 text-zinc-500 transition hover:bg-white/[0.05] hover:text-red-300"
                    title="丢弃全部排队消息"
                  >
                    清空
                  </button>
                </>
              ) : (
                <span>队列 · {pending.length}　当前回合结束后自动逐条发送</span>
              )}
            </div>
            <div className="flex max-h-32 flex-col gap-1.5 overflow-y-auto">
              {pending.map((p, i) => (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => restorePending(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') restorePending(p.id)
                  }}
                  className="glass-panel flex cursor-pointer items-start gap-2 rounded-xl border border-dashed border-white/15 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-accent/40"
                  title="点击取回编辑"
                >
                  <span className="shrink-0 pt-0.5 text-[10px] text-zinc-600">{i + 1}.</span>
                  <span className="line-clamp-2 min-w-0 flex-1 break-words">
                    {p.text || (p.attachments?.length ? `${p.attachments.length} 个附件` : '…')}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      removePendingMessage(p.id)
                    }}
                    className="shrink-0 text-zinc-500 transition hover:text-red-300"
                    title="从队列删除"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* 状态行（输入框上方）：左侧瞬态错误/常驻 chips（计数=会话累计，0 置灰，
            点击展开任务面板），右侧常驻 Usage 圆环（自退役的 StatusBar 上移）。 */}
        <div ref={chipRowRef} data-chip-row className="mb-1.5 flex items-center gap-3 px-1 text-[11px] text-zinc-500">
          {statusError && (
            <span className="flex min-w-0 items-center gap-1 text-red-400">
              <span className="truncate">{statusError}</span>
              <button
                type="button"
                onClick={clearError}
                className="shrink-0 rounded px-0.5 text-red-400/70 transition hover:bg-white/[0.06] hover:text-red-300"
                title="关闭错误提示"
              >
                ×
              </button>
            </span>
          )}
          {stopReason && !statusError && <span className="text-zinc-600">结束: {stopReason}</span>}
          <button
            type="button"
            data-chip="bash"
            onClick={() => toggleChip('bash')}
            className={`flex items-center gap-1 transition hover:brightness-125 ${
              runningBash > 0 ? 'text-blue-300' : bashTotal > 0 ? 'text-zinc-400' : 'text-zinc-600'
            }`}
            title="后台命令（点击查看面板）"
          >
            <span>🕐</span>
            <span className={runningBash > 0 ? 'chip-flow-text' : undefined}>
              后台命令 ({bashTotal})
            </span>
          </button>
          <button
            type="button"
            data-chip="agent"
            onClick={() => toggleChip('agent')}
            className={`flex shrink-0 items-center gap-1 transition hover:brightness-125 ${
              runningAgents > 0 ? 'text-accent' : agentTotal > 0 ? 'text-zinc-400' : 'text-zinc-600'
            }`}
            title="子 Agent（点击查看面板）"
          >
            <span>✦</span>
            <span className={runningAgents > 0 ? 'chip-flow-text' : undefined}>
              子 Agent ({runningAgents > 0 ? `${runningAgents}/` : ''}{agentTotal})
            </span>
          </button>
          {/* 这里原本还有一个「待办 (n/m)」chip。删掉了：正文顶部已经常驻一张
              待办卡片，同一份数据在一屏里出现两次，底下这个只是噪声。 */}
          <UsageRings />
        </div>
        {/* #39 思考/忙碌指示独立成层（chip 行下方、紧贴输入框）：之前挤在 chip
            行里，出现或变宽（计时、排队数）时会把两个 chip 和 UsageRings 挤得
            来回跳。#5 忙碌态明确提示 + 排队语义；#5c 有更具体的等待原因
            （权限确认/回答问题）时替换泛泛的"正在输出中"。 */}
        {(running || hasBackgroundSubagent) && (
          <div className="mb-1.5 flex items-center gap-3 px-1 text-[11px] text-zinc-500">
            {running ? (
              <span className="flex min-w-0 items-center gap-1.5 text-accent/90">
                {/* 流光整行统一（2026-08 用户要求）：标签、计时、排队提示同一个
                    flow-text 罩住，之前只有标签闪、后半截灰着，看着像断了。 */}
                <span className="flow-text flow-text-violet flex min-w-0 items-center gap-1.5">
                  <span>
                    {pendingPermissionCount > 0
                      ? '正在等待权限确认'
                      : elicitationCount > 0
                        ? '正在等待你回答上方问题'
                        : 'AI 正在输出中'}
                  </span>
                  {turnStartedAt ? <TurnElapsed startedAt={turnStartedAt} /> : null}
                  {pending.length > 0 ? `，已排队 ${pending.length} 条` : '，新消息将排队发送'}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 text-zinc-500">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent/70" aria-hidden />
                子任务后台运行中，可正常发送新消息
              </span>
            )}
            {running && turnStall && (
              <TurnStallNotice
                stall={turnStall}
                onDismiss={dismissTurnStall}
                onInterrupt={() => void interrupt()}
              />
            )}
          </div>
        )}
        {openChip && chipAnchor && (
          <ChipPopover kind={openChip} anchor={chipAnchor} onClose={() => setOpenChip(null)} />
        )}
        <div
          className={`glass-panel composer-panel rounded-[18px] p-3 transition ${
            dragActive ? 'border-accent/60 bg-white/[0.035] shadow-[0_0_0_1px_rgba(139,92,246,0.28)]' : ''
          } ${composerResizing ? 'is-resizing' : ''}`}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={(e) => void onDrop(e)}
        >
          <div className="composer-focus-ring" aria-hidden />
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
          {/* #38：手动拖拽的高度会持久化覆盖自动增高，双击手柄的旧恢复途径太隐蔽，
              手动模式激活期间给出一个可见的恢复入口。 */}
          {manualTextareaHeight !== null && (
            <button
              type="button"
              className="composer-height-reset"
              title="输入框高度已手动锁定，点击恢复自动增高"
              onClick={resetTextareaHeight}
            >
              恢复自动高度
            </button>
          )}
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
                {slashFilteredCommands.length === 0 ? (
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
                            {command.source === 'skill' ? 'Kimi' : '模板'}
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
            onPaste={(e) => void onPaste(e)}
            rows={1}
            spellCheck={false}
            placeholder={
              running
                ? 'Tran 正在处理…(可继续发送,消息会排队)'
                : '给 Tran 发消息…'
            }
            style={{
              height: textareaHeight,
              minHeight: heightBounds.min,
              maxHeight: heightBounds.max
            }}
            className="composer-textarea w-full resize-none rounded-xl border border-transparent bg-transparent px-3 py-2 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-white/10 focus:bg-white/[0.025]"
          />
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-end gap-1.5 px-1 pt-2">
              {attachments.map((a, i) =>
                // 图片走缩略图：此前一律是「🖼 文件名」的文字 chip，发之前
                // 看不出贴的是哪张。点击开预览面板，右上角 × 移除。
                a.kind === 'image' && a.data ? (
                  <div key={`${a.path}-${i}`} className="tran-enter group/att relative">
                    <button
                      type="button"
                      onClick={() => useUiStore.getState().openAttachmentPreview(pickedFileToUserAttachment(a))}
                      className="block overflow-hidden rounded-lg border border-white/10 outline-none ring-accent/50 transition hover:brightness-110 focus-visible:ring-2"
                      title={`预览 ${a.name}`}
                    >
                      <img
                        src={`data:${a.mimeType};base64,${a.data}`}
                        alt={a.name}
                        className="h-14 w-14 object-cover"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-white/15 bg-bg-panel text-[10px] leading-none text-zinc-400 opacity-0 transition group-hover/att:opacity-100 hover:text-red-300"
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <span
                    key={`${a.path}-${i}`}
                    className="tran-enter glass-control flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-zinc-300"
                    title={a.path}
                  >
                    <span className="text-zinc-500">{a.kind === 'text' ? '📄' : a.kind === 'directory' ? '📁' : '📎'}</span>
                    <span className="max-w-[12rem] truncate">{a.name}</span>
                    <button
                      onClick={() => removeAttachment(i)}
                      className="text-zinc-500 transition hover:text-red-300"
                      title="移除"
                    >
                      ×
                    </button>
                  </span>
                )
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="px-1 pt-1 text-[11px] text-zinc-600">
              附件 {attachments.length} 个 / {formatBytes(attachments.reduce((sum, file) => sum + file.size, 0))}
              {roughAttachmentTokens(attachments) > 0 && ` / 约 ${roughAttachmentTokens(attachments).toLocaleString()} tokens`}
            </div>
          )}
          {attachmentError && (
            <div className="flex min-w-0 items-center gap-1 px-1 pt-2 text-[11px] text-orange-300">
              <span className="truncate">{attachmentError}</span>
              <button
                type="button"
                onClick={() => setAttachmentError(null)}
                className="shrink-0 rounded px-0.5 text-orange-300/70 transition hover:bg-white/[0.06] hover:text-orange-200"
                title="关闭提示"
              >
                ×
              </button>
            </div>
          )}
          <div className="composer-toolbar flex flex-wrap items-center gap-2 px-1 pt-2">
            <button
              type="button"
              onClick={() => void pickAttachment()}
              disabled={!meta || pickingFile}
              className="glass-control flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 transition hover:bg-white/[0.09] disabled:opacity-40"
              title={pickingFile ? '正在打开文件选择器…' : '添加附件(从工作目录选择文件)'}
            >
              {pickingFile ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border border-white/20 border-t-accent" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.8-8.8a3.5 3.5 0 0 1 5 5L10.4 18a2 2 0 0 1-2.8-2.8l7.7-7.7"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
            <span className="composer-shortcut-hint px-2 text-[11px] text-zinc-500">
              <kbd className="font-sans text-zinc-400">Enter</kbd> 发送 ·{' '}
              <kbd className="font-sans text-zinc-400">Shift+Enter</kbd> 换行 ·{' '}
              <kbd className="font-sans text-zinc-400">Ctrl+S</kbd> 打断并发送
            </span>
            <div className="composer-actions ml-auto flex items-center gap-1.5">
              {meta && <ModePanel />}
              {/* Swarm 状态徽章：检测到本会话有进行中的 AgentSwarm（server tasks
                  有 running 子代理，或 ACP 侧有 running 的 AgentSwarm 工具调用）
                  时亮起，结束后自动消失。 */}
              {meta && swarmRunning && (
                <span
                  className="flex h-7 items-center gap-1.5 rounded-md border border-accent/50 px-2 text-[11px] text-accent"
                  title="Swarm 并行子代理运行中"
                >
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                  Swarm
                </span>
              )}
              {meta && (
                <DisclosureSelect
                  value={meta.permissionMode === 'plan' ? (modeBeforePlan ?? 'default') : meta.permissionMode}
                  options={PERMISSION_MODE_OPTIONS}
                  onChange={(v) => {
                    if (v !== meta.permissionMode) void setPermissionMode(v as PermissionMode)
                  }}
                  placement="top"
                  compact
                  disabled={meta.permissionMode === 'plan'}
                  title={meta.permissionMode === 'plan' ? '计划模式下权限由计划接管' : undefined}
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6l7.5-3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
                  className="min-w-28"
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
                  compact
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M5 20V14M12 20V8M19 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  }
                  className="min-w-[4.5rem]"
                />
              )}
              {meta && (
                <DisclosureSelect
                  value={meta.model}
                  options={models.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(v) => void setModel(v)}
                  placement="top"
                  compact
                  className="min-w-28"
                />
              )}
              {running && (
                <button
                  onClick={() => void interrupt()}
                  className="h-7 shrink-0 rounded-md border border-red-900/60 bg-red-950/40 px-2.5 text-[11px] font-medium text-red-300 hover:bg-red-950/60"
                  title="中断当前处理"
                >
                  停止
                </button>
              )}
              <button
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                className="composer-send accent-soft-button h-7 shrink-0 rounded-md px-3 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="send-sheen" aria-hidden />
                <span className="relative">发送</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSlashContext(null)
                  setShowTemplates((open) => !open)
                }}
                className={`glass-control composer-template-button flex h-7 items-center justify-center rounded-md px-2 text-[11px] text-zinc-300 transition ${
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
