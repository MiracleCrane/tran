import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
  SessionUsageInfo,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
  normalizeAgentBackend
} from '../../shared/agentBackends'
import { getPreferences } from '../preferences'
import { log } from '../logger'
import { KimiBackend } from './KimiBackend'
import { ClaudeBackend } from './ClaudeBackend'
import type { GoalControlAction, GoalInfo, GoalStartOptions } from '../goalStore'
import type { PermissionRequestPayload, SDKMessage } from '../../shared/ipc'

/** Events every backend adapter emits toward the IPC layer. */
export interface AgentBackendHandlers {
  onMessage: (sessionId: string, message: SDKMessage) => void
  onEnded: (sessionId: string, error?: string) => void
  onPermissionRequest: (req: PermissionRequestPayload) => void
  /** 历史会话列表有外部变化（如空壳会话被删除）——渲染层应刷新侧栏列表。 */
  onSessionsChanged?(): void
  /** turn 开始/结束：sessionId 是桥接 id，acpSessionId 是 agent 侧会话 id
   *  （侧栏列表条目用的就是它）。startedAt 是本轮开始时间戳（#41 忙碌态计时）。 */
  onSessionRunning?(sessionId: string, running: boolean, acpSessionId?: string, startedAt?: number): void
}

interface AgentBackendAdapter {
  readonly id: AgentBackendId
  start(opts: StartSessionOptions): Promise<string>
  send(sessionId: string, content: string | unknown[]): void
  interrupt(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setPermissionMode(sessionId: string, mode: string): Promise<void>
  close(sessionId: string): Promise<void>
  /** 可选：退出前彻底释放后端自身持有的资源（ACP 子进程等）。
   *  close(sessionId) 只处理单个会话，子进程是后端级的，必须单独收。 */
  dispose?(): void
  /** 可选：切走/后台化——不 cancel turn、不删会话，后台 turn 继续跑。 */
  background?(sessionId: string): void
  /** 可选：正在跑 turn 的 ACP 会话 id 集合（侧栏列表合并 running 标记用）。 */
  runningAcpSessionIds?(): Set<string>
  listMcpServers(sessionId: string): Promise<McpServerEntry[]>
  refreshMcpServers(sessionId: string): Promise<McpServerEntry[]>
  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void>
  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean>
  listSkills(sessionId: string): Promise<SkillInfo[]>
  /** 可选：会话级 token/上下文用量（后端不上报时返回缺省值）。 */
  getSessionUsage?(sessionId: string): Promise<SessionUsageInfo>
  /** 可选：触发一次隐藏 /usage 轮刷新上下文用量（悬停上下文环时）。 */
  requestUsageRefresh?(sessionId: string): Promise<void>
  /** 可选：goal 循环（目标模式，客户端侧目标引擎）。 */
  goalStart?(sessionId: string, opts: GoalStartOptions): Promise<GoalInfo | null>
  goalControl?(sessionId: string, action: GoalControlAction): Promise<GoalInfo | null>
  goalGet?(sessionId: string): Promise<GoalInfo | null>
  listModels(): Promise<ComposerModel[]>
  listMarketplacePlugins(cwd?: string): Promise<MarketplacePlugin[]>
  respondPermission(resp: PermissionResponsePayload): boolean
}

export interface AgentBridgeHandlers extends AgentBackendHandlers {}

/**
 * AgentBridge is the stable IPC-facing coordinator. Concrete agent engines live
 * behind AgentBackendAdapter implementations, so adding a new engine should not
 * require touching the session IPC surface.
 */
export class AgentBridge {
  private readonly backends: Record<AgentBackendId, AgentBackendAdapter>
  private readonly sessionBackends = new Map<string, AgentBackendId>()

  constructor(handlers: AgentBridgeHandlers) {
    const wrappedHandlers: AgentBridgeHandlers = {
      ...handlers,
      onEnded: (sessionId, error) => {
        this.sessionBackends.delete(sessionId)
        handlers.onEnded(sessionId, error)
      }
    }
    this.backends = {
      kimi: new KimiBackend(wrappedHandlers),
      claude: new ClaudeBackend(wrappedHandlers)
    }
  }

  async start(opts: StartSessionOptions): Promise<string> {
    const backendId = normalizeAgentBackend(
      opts.agentBackend ?? getPreferences().agentBackend ?? DEFAULT_AGENT_BACKEND_ID
    )
    const backend = this.backends[backendId] ?? this.backends[DEFAULT_AGENT_BACKEND_ID]
    log('bridge', `agent backend=${backend.id}`)
    const sessionId = await backend.start({ ...opts, agentBackend: backend.id })
    this.sessionBackends.set(sessionId, backend.id)
    return sessionId
  }

  send(sessionId: string, content: string | unknown[]): void {
    this.backendForSession(sessionId).send(sessionId, content)
  }

  interrupt(sessionId: string): Promise<void> {
    return this.maybeBackendForSession(sessionId)?.interrupt(sessionId) ?? Promise.resolve()
  }

  setModel(sessionId: string, model: string): Promise<void> {
    return this.backendForSession(sessionId).setModel(sessionId, model)
  }

  setPermissionMode(sessionId: string, mode: string): Promise<void> {
    return this.maybeBackendForSession(sessionId)?.setPermissionMode(sessionId, mode) ?? Promise.resolve()
  }

  goalStart(sessionId: string, opts: GoalStartOptions): Promise<GoalInfo | null> {
    return this.maybeBackendForSession(sessionId)?.goalStart?.(sessionId, opts) ?? Promise.resolve(null)
  }

  goalControl(sessionId: string, action: GoalControlAction): Promise<GoalInfo | null> {
    return this.maybeBackendForSession(sessionId)?.goalControl?.(sessionId, action) ?? Promise.resolve(null)
  }

  goalGet(sessionId: string): Promise<GoalInfo | null> {
    return this.maybeBackendForSession(sessionId)?.goalGet?.(sessionId) ?? Promise.resolve(null)
  }

  requestUsageRefresh(sessionId: string): Promise<void> {
    return this.maybeBackendForSession(sessionId)?.requestUsageRefresh?.(sessionId) ?? Promise.resolve()
  }

  async close(sessionId: string): Promise<void> {
    const backend = this.maybeBackendForSession(sessionId)
    if (!backend) return
    await backend.close(sessionId)
    this.sessionBackends.delete(sessionId)
  }

  /** 切走/后台化：会话留在后端继续跑（turn、事件推送不受影响），路由映射保留。 */
  background(sessionId: string): void {
    this.maybeBackendForSession(sessionId)?.background?.(sessionId)
  }

  /** 正在跑 turn 的 ACP 会话 id 集合（跨后端合并；listSessions 打 running 标记用）。 */
  runningAcpSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const backend of Object.values(this.backends)) {
      for (const id of backend.runningAcpSessionIds?.() ?? []) ids.add(id)
    }
    return ids
  }

  /** 退出前清理：逐个 close 活跃会话（触发后端的空壳删除等离场逻辑）。
   *  同步部分（文件删除）立即生效，ACP 通知尽力而为。 */
  async shutdown(): Promise<void> {
    for (const sessionId of [...this.sessionBackends.keys()]) {
      await this.close(sessionId).catch(() => {})
    }
    // 会话收完后释放后端级资源：ACP 子进程不属于任何单个会话，
    // 不显式 kill 的话在 Windows 上不会随父进程退出而回收。
    for (const backend of Object.values(this.backends)) {
      try {
        backend.dispose?.()
      } catch {
        /* 退出路径尽力而为 */
      }
    }
  }

  listMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.backendForSession(sessionId).listMcpServers(sessionId)
  }

  refreshMcpServers(sessionId: string): Promise<McpServerEntry[]> {
    return this.backendForSession(sessionId).refreshMcpServers(sessionId)
  }

  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void> {
    return this.backendForSession(sessionId).toggleMcpServer(sessionId, name, enabled)
  }

  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean> {
    return this.backendForSession(sessionId).backgroundTask(sessionId, toolUseId)
  }

  listSkills(sessionId: string): Promise<SkillInfo[]> {
    return this.backendForSession(sessionId).listSkills(sessionId)
  }

  async getSessionUsage(sessionId: string): Promise<SessionUsageInfo> {
    const backend = this.maybeBackendForSession(sessionId)
    if (backend?.getSessionUsage) return backend.getSessionUsage(sessionId)
    // 后端不支持（或会话已结束）：返回缺省上下文上限，渲染层显示"暂无数据"。
    return { contextSize: 1_048_576 }
  }

  listModels(agentBackend?: AgentBackendId): Promise<ComposerModel[]> {
    const backendId = normalizeAgentBackend(
      agentBackend ?? getPreferences().agentBackend ?? DEFAULT_AGENT_BACKEND_ID
    )
    return (this.backends[backendId] ?? this.backends[DEFAULT_AGENT_BACKEND_ID]).listModels()
  }

  listMarketplacePlugins(agentBackend?: AgentBackendId, cwd?: string): Promise<MarketplacePlugin[]> {
    const backendId = normalizeAgentBackend(
      agentBackend ?? getPreferences().agentBackend ?? DEFAULT_AGENT_BACKEND_ID
    )
    return (this.backends[backendId] ?? this.backends[DEFAULT_AGENT_BACKEND_ID]).listMarketplacePlugins(cwd)
  }

  respondPermission(resp: PermissionResponsePayload): void {
    for (const backend of Object.values(this.backends)) {
      if (backend.respondPermission(resp)) return
    }
  }

  private backendForSession(sessionId: string): AgentBackendAdapter {
    const backend = this.maybeBackendForSession(sessionId)
    if (!backend) throw new Error(`session not found: ${sessionId}`)
    return backend
  }

  private maybeBackendForSession(sessionId: string): AgentBackendAdapter | null {
    const backendId = this.sessionBackends.get(sessionId)
    if (!backendId) return null
    return this.backends[backendId] ?? this.backends[DEFAULT_AGENT_BACKEND_ID]
  }
}
