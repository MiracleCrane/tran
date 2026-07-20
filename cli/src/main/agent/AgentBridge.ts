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
import type { PermissionRequestPayload, SDKMessage } from '../../shared/ipc'

/** Events every backend adapter emits toward the IPC layer. */
export interface AgentBackendHandlers {
  onMessage: (sessionId: string, message: SDKMessage) => void
  onEnded: (sessionId: string, error?: string) => void
  onPermissionRequest: (req: PermissionRequestPayload) => void
}

interface AgentBackendAdapter {
  readonly id: AgentBackendId
  start(opts: StartSessionOptions): Promise<string>
  send(sessionId: string, content: string | unknown[]): void
  interrupt(sessionId: string): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  setPermissionMode(sessionId: string, mode: string): Promise<void>
  close(sessionId: string): Promise<void>
  listMcpServers(sessionId: string): Promise<McpServerEntry[]>
  refreshMcpServers(sessionId: string): Promise<McpServerEntry[]>
  toggleMcpServer(sessionId: string, name: string, enabled: boolean): Promise<void>
  backgroundTask(sessionId: string, toolUseId?: string): Promise<boolean>
  listSkills(sessionId: string): Promise<SkillInfo[]>
  /** 可选：会话级 token/上下文用量（后端不上报时返回缺省值）。 */
  getSessionUsage?(sessionId: string): Promise<SessionUsageInfo>
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
      // 目前只实例化 Kimi 一个后端；新增后端时在此挂接新的 adapter。
      kimi: new KimiBackend(wrappedHandlers)
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

  async close(sessionId: string): Promise<void> {
    const backend = this.maybeBackendForSession(sessionId)
    if (!backend) return
    await backend.close(sessionId)
    this.sessionBackends.delete(sessionId)
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
