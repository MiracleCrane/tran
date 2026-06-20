import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  PermissionResponsePayload,
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
import { ClaudeCodeBackend, type AgentBackendHandlers } from './ClaudeCodeBackend'
import { CodexBackend } from './CodexBackend'
import { HermesBackend } from './HermesBackend'

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
      'claude-code': new ClaudeCodeBackend(wrappedHandlers),
      codex: new CodexBackend(wrappedHandlers),
      hermes: new HermesBackend(wrappedHandlers)
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
