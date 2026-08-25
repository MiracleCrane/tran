import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import RichInput from './RichInput'
import { useSessionStore } from '../store/sessionStore'
 import { displayName, hasFriendlyName, readAliases, writeAlias } from '../lib/commandAliases'
import { useUiStore } from '../store/uiStore'
import type { AgentBackendId, ComposerModel, PickedFile, EffortLevel, PermissionMode, SkillInfo } from '../../shared/ipc'
import DisclosureSelect from './DisclosureSelect'
import ModePanel from './ModePanel'
import { AGENT_TOOL_NAMES, backgroundTaskInfo, collectBackgroundTaskBlocks, countRunningBackgroundTasks, countRunningTools, countTotalTools, withServerTaskStatus } from '../utils/toolStats'
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
  /** 运行中后台命令里最早的开始时间（chip 走时；server startedAt 优先）。 */
  runningBashStartedAt: number | null
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
    // 「后台命令」chip 只数真后台任务（run_in_background），见 toolStats 注释。
    bashTotal: collectBackgroundTaskBlocks(s.items).length,
    runningBash: countRunningBackgroundTasks(s.items, s.swarmTasks),
    runningBashStartedAt: (() => {
      let earliest: number | null = null
      for (const b of collectBackgroundTaskBlocks(s.items)) {
        const bg = withServerTaskStatus(backgroundTaskInfo(b), s.swarmTasks)
        if (!bg.running) continue
        const at = bg.startedAt ?? b.startedAt ?? null
        if (at && (earliest === null || at < earliest)) earliest = at
      }
      return earliest
    })(),
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

/** 命令胶囊上的小图标（同 Codex 的立方体感，纯描边不抢戏）。 */
function SkillGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="shrink-0 text-accent" aria-hidden>
      <path
        d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

/** 斜杠命令缓存键：按 agent 后端分开存（Kimi 与 Claude Code 的命令完全不同）。 */
function slashCacheKey(backend: string | undefined): string {
  return `forge.slashCommands.${backend ?? 'kimi'}`
}

function readCachedSlashCommands(backend: string | undefined): SkillInfo[] {
  try {
    const raw = localStorage.getItem(slashCacheKey(backend))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 形状防御：缓存是上一版写的，字段可能对不上。
    return parsed.filter(
      (x): x is SkillInfo =>
        !!x && typeof (x as SkillInfo).name === 'string' && typeof (x as SkillInfo).description === 'string'
    )
  } catch {
    return []
  }
}

function writeCachedSlashCommands(backend: string | undefined, commands: SkillInfo[]): void {
  try {
    localStorage.setItem(slashCacheKey(backend), JSON.stringify(commands))
  } catch {
    /* 配额满了就算了，缓存不是关键路径 */
  }
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

/** 后台命令 chip 的运行中走时（mm:ss 秒跳；最早一个在跑任务的开始时间）。 */
function BashRunningElapsed({ startedAt }: { startedAt: number }): JSX.Element {
  useSecondTick()
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return <span className="font-mono">· {mm}:{ss}</span>
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
  void turnStartedAt // 计时已挪到对话区顶部的 TurnTimerStrip（2026-08-14）
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
  const runningBashStartedAt = useSessionStore((s) => getToolChipStats(s).runningBashStartedAt)
  const agentTotal = useSessionStore((s) => getToolChipStats(s).agentTotal)
  const runningAgents = useSessionStore((s) => getToolChipStats(s).runningAgents)
  // #5c 忙碌原因（输入区提示文案用）：权限确认 / 提问等待 / 后台子任务。
  const pendingPermissionCount = useSessionStore((s) => s.pendingPermissions.length)
  const elicitationCount = useSessionStore((s) => s.elicitationQueue.length)
  /** 只有这两种情况需要用户动手，值得在输入框上方常驻一行提示。 */
  const waitingOnUser = pendingPermissionCount > 0 || elicitationCount > 0
  /** `/` 面板里给「后端下发的命令」打的徽标：跟着当前后端走。 */
  const backendLabel = useSessionStore((s) => (s.meta?.agentBackend === 'claude' ? 'Claude' : 'Kimi'))
  /** 当前挂在输入框上的命令（胶囊形态），null = 没挂。 */
  const [activeCommand, setActiveCommand] = useState<string | null>(null)
  /** 用户自定义别名。改名后要立刻重渲染，所以进 state 而不是每次读 localStorage。 */
  const [aliases, setAliases] = useState<Record<string, string>>({})
  const [aliasEditor, setAliasEditor] = useState<{ name: string; value: string } | null>(null)

  const hasBackgroundSubagent = useSessionStore((s) =>
    s.tasks.some((t) => t.isBackgrounded && t.status === 'running')
  )
  // chips 独立浮层：openChip=哪个 chip 的浮层开着 + 锚点（portal fixed 定位）。
  const [openChip, setOpenChip] = useState<ChipKind | null>(null)
  const [chipAnchor, setChipAnchor] = useState<ChipAnchor | null>(null)
  const chipRowRef = useRef<HTMLDivElement | null>(null)
  /**
   * `/` 面板要浮在输入框**之上**，而它的定位祖先是输入框那一层，`bottom:100%`
   * 只让开输入框本身——正好压住上面那条 chip 行（后台命令 / 子 Agent / 上下文
   * 环）。量一下 chip 行的高度，让面板再往上抬这么多。
   */
  const [chipRowHeight, setChipRowHeight] = useState(0)
  useEffect(() => {
    const row = chipRowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setChipRowHeight(row.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(row)
    return () => ro.disconnect()
  }, [])

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

  /**
   * 命令列表先用缓存顶上（新对话第一句话之前也能按 `/`）。
   *
   * Kimi 的会话是**懒启动**的——桥接 id 只是渲染层生成的本地 uid，ACP 后端要
   * 等你发出第一条消息才真正起来。所以「新建对话 → 直接按 /」必然一条后端命令
   * 都没有，只剩自带模板。而这 40 条命令其实是**装机级别**的属性，不会因会话
   * 而变，没道理每次都等会话起来才能看见。
   *
   * 于是：拿到过一次就按后端存起来，下次开局立刻显示；真会话起来后照常覆盖。
   */
  const agentBackend = useSessionStore((s) => s.meta?.agentBackend)
  /** 实验开关：富文本输入框（内联胶囊）。默认关。 */
  const [richComposer, setRichComposer] = useState(false)
  useEffect(() => {
    void window.api.getPreferences().then((p) => setRichComposer(p.richComposer === true)).catch(() => {})
  }, [])
  /** 给 RichInput 的分词回调：只有真实存在的命令才画成胶囊。 */
  const resolveCommandName = useCallback(
    (inputName: string): string | null => {
      const query = normalizeSlashName(inputName).toLowerCase()
      if (!query) return null
      for (const skill of slashSkills) {
        const canonical = normalizeSlashName(skill.name)
        if (!canonical) continue
        if (canonical.toLowerCase() === query) return canonical
        if ((skill.aliases ?? []).some((alias) => normalizeSlashName(alias).toLowerCase() === query)) {
          return canonical
        }
        if (aliases[canonical]?.trim().toLowerCase() === query) return canonical
        if (displayName(canonical, agentBackend, aliases).trim().toLowerCase() === query) return canonical
      }
      return null
    },
    [slashSkills, agentBackend, aliases]
  )

  const resolveCommandForChip = useCallback(
    (name: string) => {
      const canonical = resolveCommandName(name)
      if (!canonical) return null
      return { label: displayName(canonical, agentBackend, aliases) }
    },
    [resolveCommandName, agentBackend, aliases]
  )

  useEffect(() => {
    if (useSessionStore.getState().slashCommands.length > 0) return
    const cached = readCachedSlashCommands(agentBackend)
    if (cached.length) useSessionStore.setState({ slashCommands: cached })
  }, [agentBackend])

  // 别名随后端切换重读；换会话时挂着的胶囊也要清掉（命令属于那个会话）。
  useEffect(() => {
    setAliases(readAliases(agentBackend))
  }, [agentBackend])
  useEffect(() => onForgeEvent('commandAliasesChanged', () => {
    setAliases(readAliases(agentBackend))
  }), [agentBackend])
  useEffect(() => {
    setActiveCommand(null)
  }, [meta?.sessionId])

  // 真值一到就刷新缓存（命令增删、换后端都靠这里跟上）。
  useEffect(() => {
    if (slashSkills.length > 0) writeCachedSlashCommands(agentBackend, slashSkills)
  }, [slashSkills, agentBackend])

  // 兜底：订阅仍为空时通过 listSkills IPC 主动拉一次（后端 listSkills 返回
  // session.skills，缓冲队列修复后它在 start 期间已被正确赋值）。订阅优先，
  // 拉取只在订阅为空时补。
  // 依赖里必须带上 sdkSessionId：后端崩了自动重连之后，桥接 id（sessionId）
  // 不变、只有 ACP 侧的会话 id 换了。只盯 sessionId 的话这个兜底永远不会重跑，
  // 命令列表就一直空着——实测把 kimi 杀掉重连后，`/` 面板里 40 个命令全没了，
  // 只剩 Tran 自带的几个模板。
  useEffect(() => {
    if (!meta?.sessionId || starting) return
    if (useSessionStore.getState().slashCommands.length > 0) return
    void window.api.listSkills(meta.sessionId).then(async (skills) => {
      // 懒创建期间会话侧 listSkills 必为空（后端要第一条消息才起）：退回主进程
      // 磁盘扫描（listSkillsForCwd），让「新对话第一句之前」按 / 也有技能。
      // 写进同一个 sessionStore.slashCommands：真会话起来后 ACP 推送照常覆盖，
      // SkillsPanel 的 store 读数也能顺带受益。
      let list = skills
      if (list.length === 0 && meta.cwd) {
        list = await window.api.listSkillsForCwd(meta.cwd).catch(() => [] as SkillInfo[])
      }
      if (list.length && useSessionStore.getState().slashCommands.length === 0) {
        useSessionStore.setState({ slashCommands: list })
      }
    }).catch(() => {})
  }, [meta?.sessionId, meta?.sdkSessionId, meta?.cwd, starting])
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
  //
  // 但只认「bridge sessionId 变化」为真正切会话：新会话首条消息的 init 到达会
  // 让 draftKey 从 bridge id 迁到 sdk id（同一会话），不能借此清掉用户在这
  // 1~3s 窗口里刚加的附件。草稿文本有专门的迁移 effect，附件走这里的守卫。
  const prevBridgeSessionRef = useRef(meta?.sessionId)
  useEffect(() => {
    if (prevBridgeSessionRef.current === meta?.sessionId) return
    prevBridgeSessionRef.current = meta?.sessionId
    setAttachments([])
    ++attachmentActionSeqRef.current
  }, [draftKey, meta?.sessionId])
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
        displayName(command.name, agentBackend, aliases),
        ...(command.aliases ?? [])
      ].map((value) => value.toLowerCase())
      return targets.some((target) => target.includes(query))
    })
  }, [slashCommands, slashContext?.query, agentBackend, aliases])

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

  // 补全后待设置的光标位。不能用 requestAnimationFrame：rAF 可能跑在 React
  // 提交新 value 之前，setSelectionRange 在旧值上触发 'select' 事件，
  // refreshSlashContextFromTextarea 读到旧 DOM 值把菜单重新打开（带着陈旧的
  // start/end），下一个回车就变成二次补全而不是发送。布局副作用保证在新
  // value 落进 DOM 之后再动光标。
  const pendingCaretRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return
    const caret = pendingCaretRef.current
    pendingCaretRef.current = null
    // 富文本模式：光标由 RichInput 自理（外部改值落末尾，见 RichInput 重排
    // 注释），这里去聚焦隐藏的 textarea 只会把焦点从富文本框抢走。
    if (richComposer) return
    const textarea = textareaRef.current
    if (textarea) {
      textarea.focus()
      textarea.setSelectionRange(caret, caret)
    }
  }, [text])

  const applySlashCommand = (command: SlashCommandItem): void => {
    if (!slashContext) return
    const before = text.slice(0, slashContext.start)
    const after = text.slice(slashContext.end)

    // 富文本模式下**不要**把命令提到上面去：那儿已经能把 `/xxx` 就地画成
    // 内联胶囊了，再提一枚独立胶囊出来就是同一件事出现两次（用户实测反馈）。
    // 让它照常留在文本里，交给 RichInput 渲染。
    //
    // 后端命令 → 胶囊：把 `/xxx` 从文本里摘掉，命令本身挂到 activeCommand 上。
    // 模板不走这条（它插入的是一整段 prompt 正文，本来就该留在文本里）。
    if (command.source === 'skill' && !richComposer) {
      const nextText = `${before}${after.replace(/^\s+/, '')}`
      setText(nextText)
      setActiveCommand(command.name)
      setSlashContext(null)
      pendingCaretRef.current = before.length
      return
    }

    const trailingSpace = after && !/^\s/.test(after) ? ' ' : ''
    const nextText = `${before}${command.insertText}${trailingSpace}${after}`
    const nextCaret = before.length + command.insertText.length + trailingSpace.length

    setText(nextText)
    setSlashContext(null)
    pendingCaretRef.current = nextCaret
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
    } catch (error) {
      // IPC 失败（主进程忙/对话框异常）不能变成 unhandled rejection——
      // pickAttachment 是被 void 调用的。
      setAttachmentError(error instanceof Error ? error.message : String(error))
      return
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
    // 挂着命令胶囊时，光有胶囊也能发（`/status` 这种不需要参数）。
    if (!value && atts.length === 0 && !activeCommand) return
    // /usage 是 Tran 原生命令：打开用量面板，不发给 agent。
    if ((value === '/usage' || (activeCommand === 'usage' && !value)) && atts.length === 0) {
      setText('')
      setActiveCommand(null)
      setSlashContext(null)
      useUiStore.getState().setUsageOpen(true)
      return
    }
    ++attachmentActionSeqRef.current
    // 胶囊在这里拼回真正要发出去的文本。
    const typedCommand = /^\/([^\s/]+)([\s\S]*)$/.exec(value)
    const canonicalTypedCommand = typedCommand ? resolveCommandName(typedCommand[1] ?? '') : null
    const normalizedValue = canonicalTypedCommand && typedCommand
      ? `/${canonicalTypedCommand}${typedCommand[2] ?? ''}`
      : value
    const finalText = activeCommand ? `/${activeCommand}${value ? ` ${value}` : ''}` : normalizedValue
    setText('')
    setActiveCommand(null)
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
        if (activeSlashCommand) {
          e.preventDefault()
          applySlashCommand(activeSlashCommand)
          return
        }
        // 零匹配时菜单只是个空壳：回车应当关掉它并照常发送，而不是被吞。
        setSlashContext(null)
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer-shell bg-transparent px-6 pb-2 pt-1">
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
        <div ref={chipRowRef} data-chip-row className="mb-1 flex items-center gap-3 px-1 text-[11px] text-zinc-500">
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
            title="后台任务（点击查看面板）"
          >
            <span>🕐</span>
            <span className={runningBash > 0 ? 'chip-flow-text' : undefined}>
              {/* 空闲时不显示累计总数——「后台任务 (101)」这种总账是噪声
                  （2026-08-19 用户），看不出任何活；数字只在有任务运行时出现。
                  点它仍开面板看历史。2026-08-24：改名「后台任务」，运行数与耗时
                  一起收进后面的括号。 */}
              {runningBash > 0 ? `后台任务 (${runningBash} 运行中` : '后台任务'}
            </span>
            {runningBash > 0 && runningBashStartedAt !== null && (
              <BashRunningElapsed startedAt={runningBashStartedAt} />
            )}
            {runningBash > 0 && <span>)</span>}
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
              {/* 括号只留运行数（2026-08-24 用户拍板）：(3/12) 里的总数是噪音，
                  没有运行中就只显示名字，与「后台任务」chip 同口径。 */}
              子 Agent{runningAgents > 0 ? ` (${runningAgents})` : ''}
            </span>
          </button>
          {/* 这里原本还有一个「待办 (n/m)」chip。删掉了：正文顶部已经常驻一张
              待办卡片，同一份数据在一屏里出现两次，底下这个只是噪声。 */}
          <UsageRings />
        </div>
        {/* 「AI 正在输出中（00:18），已排队 N 条」这条常驻提示删掉了
            （2026-08 用户要求）：正在跑这件事，正文里的流光标题 + 发送键变成
            「停止」已经说得很清楚；计时挪进正文的流式标题里；排队条数在上面
            的队列卡片里本来就有，重复一遍是噪声。
            保留的只有两种**真正需要动作**的提示：等你授权/回答，以及疑似卡住。 */}
        {(waitingOnUser || (running && turnStall) || hasBackgroundSubagent) && (
          <div className="mb-1.5 flex items-center gap-3 px-1 text-[11px] text-zinc-500">
            {waitingOnUser && (
              <span className="flow-text flow-text-violet flex min-w-0 items-center gap-1.5 text-accent/90">
                {pendingPermissionCount > 0 ? '正在等待权限确认' : '正在等待你回答上方问题'}
              </span>
            )}
            {!waitingOnUser && hasBackgroundSubagent && !running && (
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
          className={`glass-panel composer-panel rounded-[20px] px-3 py-2 transition ${
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
            style={{ height: slashPanelHeight, '--composer-chip-clearance': `${chipRowHeight}px` } as CSSProperties}
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
                      }}
                      onClick={() => applySlashCommand(command)}
                      className={`slash-command-item ${index === slashSelectedIndex ? 'is-active' : ''}`}
                      aria-selected={index === slashSelectedIndex}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          {/* 主标题用别名（`skill:` 前缀在这里剥掉——一屏全是它，
                              除了占地方没有信息量）；原名降级成旁边的灰色小字，
                              仍然看得到、也仍然能搜到。 */}
                          <span className="truncate text-[12px] text-zinc-200">
                            {displayName(command.name, agentBackend, aliases)}
                          </span>
                          {hasFriendlyName(command.name, agentBackend, aliases) && (
                            <span className="shrink-0 truncate font-mono text-[10px] text-zinc-600">
                              /{command.name}
                            </span>
                          )}
                          {command.argumentHint && (
                            <span className="truncate font-mono text-[10px] text-zinc-600">{command.argumentHint}</span>
                          )}
                          <span className="shrink-0 rounded bg-white/[0.055] px-1.5 py-0.5 text-[9px] text-zinc-500">
                            {/* 徽标跟着当前后端走。原来写死 'Kimi'，在 Claude Code
                                会话里 19 个 Claude 的命令全被标成 Kimi。 */}
                            {command.source === 'skill' ? backendLabel : '模板'}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                          {command.source === 'template' ? command.label : command.description}
                        </span>
                      </span>
                      {command.source === 'skill' && (
                        // 改名入口。用 span+role 而不是嵌套 <button>（button 里套
                        // button 是非法 HTML，浏览器会把内层踢出去）。
                        <span
                          role="button"
                          tabIndex={-1}
                          title="给这个命令起个别名"
                          aria-label="重命名"
                          onMouseDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setAliasEditor({
                              name: command.name,
                              value: aliases[command.name] ?? displayName(command.name, agentBackend, aliases)
                            })
                            setSlashContext(null)
                          }}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-zinc-600 transition hover:bg-white/10 hover:text-zinc-300"
                        >
                          改名
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
          {aliasEditor && (
            <form
              className="absolute bottom-full left-2 right-2 z-[60] mb-2 flex items-center gap-2 rounded-xl border border-white/10 bg-[#262626] p-2 shadow-xl shadow-black/35"
              onSubmit={(event) => {
                event.preventDefault()
                writeAlias(agentBackend, aliasEditor.name, aliasEditor.value)
                setAliases(readAliases(agentBackend))
                setAliasEditor(null)
              }}
            >
              <span className="shrink-0 font-mono text-[11px] text-zinc-500">/{aliasEditor.name}</span>
              <input
                autoFocus
                value={aliasEditor.value}
                onChange={(event) => setAliasEditor({ ...aliasEditor, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setAliasEditor(null)
                  }
                }}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-accent/60"
                aria-label="命令别名"
                placeholder="输入别名；留空恢复默认"
              />
              <button
                type="button"
                onClick={() => setAliasEditor(null)}
                className="rounded-lg px-2 py-1.5 text-xs text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-lg bg-white/[0.08] px-2 py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.12]"
              >
                保存
              </button>
            </form>
          )}
          <div
            className={`template-panel-reveal ${showTemplates ? 'is-open' : ''}`}
            style={{ height: templatePanelHeight, '--composer-chip-clearance': `${chipRowHeight}px` } as CSSProperties}
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
          {/* 命令胶囊：选中后端命令后，它从输入框文本里"提"出来变成一枚胶囊，
              textarea 只留参数（Codex 同款观感）。发送时再拼回 `/name 参数`。
              为什么不做成 textarea 内联的富文本：那要把整个输入框换成
              contenteditable，输入法组词、草稿、撤销栈、粘贴全得重做，代价远
              大于收益。 */}
          {activeCommand && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
              {/* 原名不再平铺在胶囊里：它跟别名说的是同一件事，挤在一起只是噪声
                  （2026-08 用户反馈「这个灰字是什么」）。挪进 title，悬停即可看到。 */}
              <span
                title={`/${activeCommand}`}
                className="tran-enter inline-flex max-w-full items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/[0.12] py-1 pl-2 pr-1 text-[12px] text-zinc-100"
              >
                <SkillGlyph />
                <span className="truncate">{displayName(activeCommand, agentBackend, aliases)}</span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCommand(null)
                    textareaRef.current?.focus()
                  }}
                  title="移除命令"
                  aria-label="移除命令"
                  className="ml-0.5 shrink-0 rounded px-1 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                >
                  ×
                </button>
              </span>
            </div>
          )}
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
            className="composer-textarea w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500"
            hidden={richComposer}
          />
          {/* 实验：富文本输入框。两条路都在，靠设置切——地基换了但旧路一行没动，
              不合适随时切回去。 */}
          {richComposer && (
            <RichInput
              value={text}
              onChange={(next) => {
                setText(next)
                // caret 由 RichInput 的 selectionchange 单独上报，这里给末尾兜底。
                updateSlashContext(next, next.length)
              }}
              onSelectionChange={(caret) => updateSlashContext(text, caret)}
              onKeyDown={(e) => onKey(e as unknown as KeyboardEvent<HTMLTextAreaElement>)}
              onPaste={(e) => void onPaste(e as unknown as ClipboardEvent<HTMLTextAreaElement>)}
              placeholder={running ? 'Tran 正在处理…(可继续发送,消息会排队)' : '给 Tran 发消息…'}
              ariaLabel="消息输入框"
              resolveCommand={resolveCommandForChip}
              className="rich-input border-0 bg-transparent px-1 py-1 text-sm leading-relaxed text-zinc-200 outline-none"
            />
          )}
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
          <div className="composer-toolbar flex flex-wrap items-center gap-2 px-1 pt-1.5">
            <button
              type="button"
              onClick={() => void pickAttachment()}
              disabled={!meta || pickingFile}
              className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40"
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
                  naked
                  disabled={meta.permissionMode === 'plan'}
                  title={meta.permissionMode === 'plan' ? '计划模式下权限由计划接管' : undefined}
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6l7.5-3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
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
                  naked
                  triggerLeading={
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 text-zinc-400">
                      <path d="M5 20V14M12 20V8M19 20V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  }
                />
              )}
              {meta && (
                <DisclosureSelect
                  value={meta.model}
                  options={models.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(v) => void setModel(v)}
                  placement="top"
                  compact
                  naked
                />
              )}
              {running && (
                <button
                  onClick={() => void interrupt()}
                  className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-red-400/90 transition hover:bg-red-950/40 hover:text-red-300"
                  title="中断当前处理"
                >
                  停止
                </button>
              )}
              {/* 发送：Codex 风圆形按钮。可发时浅色实底（黑箭头），不可发时
                  幽灵灰。不再用紫色长条——工具栏要浑然一体（2026-08）。 */}
              <button
                onClick={() => void submit()}
                disabled={!text.trim() && attachments.length === 0}
                title="发送"
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed ${
                  !text.trim() && attachments.length === 0
                    ? 'bg-white/[0.05] text-zinc-600'
                    : 'bg-zinc-200 text-zinc-900 hover:bg-white'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSlashContext(null)
                  setShowTemplates((open) => !open)
                }}
                className={`composer-template-button flex h-7 items-center justify-center rounded-md px-1.5 text-[11px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-200 ${
                  showTemplates ? 'is-open' : ''
                }`}
                title="Prompt 模板"
              >
                模板
              </button>
            </div>
          </div>
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[20px] border border-dashed border-accent/70 bg-black/55 backdrop-blur-sm">
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
