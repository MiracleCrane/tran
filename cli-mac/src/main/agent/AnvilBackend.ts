import { createAnvilSession, type AnvilSession } from '@claude-forge/agent'
import type {
  ComposerModel,
  MarketplacePlugin,
  McpServerEntry,
  Provider,
  PermissionResponsePayload,
  SkillInfo,
  StartSessionOptions
} from '../../shared/ipc'
import { ANVIL_DEFAULT_MODELS } from '../../shared/models'
import { getActiveProvider } from '../providers'
import { log } from '../logger'
import type { AgentBackendHandlers } from './ClaudeCodeBackend'
import { AnvilStream } from './AnvilStream'

/**
 * AnvilBackend —— Anvil runtime 的 AgentBackendAdapter 实现。
 *
 * 和 ClaudeCodeBackend 在 AgentBridge 里地位完全对等，但不再驱动 claude.exe：
 * 它实例化 Anvil 的 provider-direct runtime（直连任意 OpenAI 兼容运营商），
 * 把 AnvilEvent 经 AnvilStream 伪装成 SDKMessage 喂给现有 UI。
 *
 * 权限、MCP、skills 这些能力在 P0 尚未接线（capability 标 false），方法体
 * 返回空值；P1/P2 再逐步补齐。
 */
export class AnvilBackend {
  readonly id = 'anvil' as const
  private readonly sessions = new Map<string, AnvilSession>()
  private readonly streams = new Map<string, AnvilStream>()

  constructor(private h: AgentBackendHandlers) {}

  async start(opts: StartSessionOptions): Promise<string> {
    const sessionId = opts.bridgeSessionId ?? cryptoId()
    const provider = this.resolveProvider()
    const model = opts.model ?? provider?.model ?? 'gpt-4o'
    const cwd = opts.cwd

    log('anvil', `start session=${sessionId} cwd=${cwd} model=${model} protocol=${provider ? 'openai' : 'none'}`)

    if (!provider || !provider.token) {
      this.h.onEnded(sessionId, '当前没有可用的运营商或 token。请在设置里配置一个 OpenAI 兼容运营商。')
      return sessionId
    }

    const stream = new AnvilStream()
    this.streams.set(sessionId, stream)

    const session = createAnvilSession({
      provider: {
        name: provider.name,
        baseUrl: provider.baseUrl,
        token: provider.token,
        authType: provider.authType,
        model: provider.model,
        protocol: 'openai'
      },
      model,
      cwd,
      onEvent: (event) => this.onAnvilEvent(sessionId, event)
    })
    this.sessions.set(sessionId, session)

    return sessionId
  }

  send(sessionId: string, content: string | unknown[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      log('anvil', `send FAILED: session not found ${sessionId}`)
      throw new Error(`session not found: ${sessionId}`)
    }
    const text = typeof content === 'string' ? content : contentToText(content)
    log('anvil', `send session=${sessionId} len=${text.length}`)
    session.send(text)
  }

  async interrupt(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.interrupt()
  }

  async setModel(_sessionId: string, _model: string): Promise<void> {
    // Anvil 的模型由 provider.model 决定；静默切换 P1 再支持。
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // P1 接线 PermissionGate。
  }

  async close(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.close()
    this.sessions.delete(sessionId)
    this.streams.delete(sessionId)
  }

  // ---- P0 未接线的能力（capability=false）----

  async listMcpServers(_sessionId: string): Promise<McpServerEntry[]> {
    return []
  }

  async refreshMcpServers(_sessionId: string): Promise<McpServerEntry[]> {
    return []
  }

  async toggleMcpServer(): Promise<void> {
    /* P2: MCP client 接入 */
  }

  async backgroundTask(): Promise<boolean> {
    return false
  }

  async listSkills(_sessionId: string): Promise<SkillInfo[]> {
    return []
  }

  async listModels(): Promise<ComposerModel[]> {
    return ANVIL_DEFAULT_MODELS
  }

  async listMarketplacePlugins(): Promise<MarketplacePlugin[]> {
    return []
  }

  respondPermission(_resp: PermissionResponsePayload): boolean {
    // P1: 接 PermissionGate 后才需要响应审批。
    return false
  }

  // ---- 内部 ----

  /** 把一个 AnvilEvent 转成 SDKMessage 并推给 UI。 */
  private onAnvilEvent(sessionId: string, event: AnvilEventShim): void {
    // ended 走 onEnded 通道。
    if (event.type === 'ended') {
      log('anvil', `ended session=${sessionId} error=${event.error ?? '(none)'}`)
      this.sessions.delete(sessionId)
      this.streams.delete(sessionId)
      this.h.onEnded(sessionId, event.error)
      return
    }

    const stream = this.streams.get(sessionId)
    if (!stream) return

    // block start/delta/stop 的 index 管理全部在 AnvilStream 内部，这里只转发。
    const msgs = stream.toSDKMessages(event)
    for (const m of msgs) {
      this.h.onMessage(sessionId, m)
    }
  }

  /** 取当前活跃运营商（来自 providers.ts，与 ClaudeCodeBackend 同源）。 */
  private resolveProvider(): Provider | null {
    return getActiveProvider()
  }
}

/** 把 renderer 的 content blocks（图片/文本）压成纯文本（P0 简化）。 */
function contentToText(content: unknown[]): string {
  if (!Array.isArray(content)) return String(content)
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      const b = block as Record<string, unknown>
      if (typeof b['text'] === 'string') return b['text']
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function cryptoId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** 局部类型别名，避免循环导入。 */
type AnvilEventShim = Parameters<AnvilStream['toSDKMessages']>[0]
