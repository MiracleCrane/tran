import type {
  AnvilEvent,
  ChatMessage,
  ProviderClient,
  SessionDeps,
  ToolCall,
  ToolContext
} from '../types.js'
import { createProviderClient } from '../providers/ProviderClient.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildSystemPrompt } from '../prompt/PromptBuilder.js'

/** 防死循环：单次用户消息最多走多少轮工具调用。 */
const MAX_TOOL_ROUNDS = 50

/**
 * Anvil 的心脏：自己驱动 LLM + 工具的 agent loop。
 *
 * 现有 backend（ClaudeCodeBackend 等）把循环委托给 claude.exe；Anvil 自己实现它：
 *   1. 组装 system + history + 用户消息
 *   2. provider.stream() → 流式回显 + 收集工具调用
 *   3. 有 tool_calls → 逐个执行（危险工具先审批）→ 结果回填 → 回到 1
 *   4. 无 tool_calls → 回合结束
 *
 * 产出的全是协议无关的 AnvilEvent；stream.ts 负责伪装成 SDKMessage，
 * 这样 cli-mac 的渲染逻辑零改动。
 */
export class AgentLoop {
  private readonly provider: ProviderClient
  private readonly tools: ToolRegistry
  private readonly messages: ChatMessage[] = []
  private readonly model: string
  private readonly cwd: string
  private readonly systemPrompt: string
  private readonly onEvent: (e: AnvilEvent) => void
  private readonly signal: AbortSignal
  private readonly sessionId: string

  constructor(deps: SessionDeps, sessionId: string) {
    this.provider = createProviderClient(deps.provider)
    this.tools = new ToolRegistry(deps.tools)
    this.model = deps.model
    this.cwd = deps.cwd
    this.systemPrompt = buildSystemPrompt(this.tools.definitions(), deps.systemPrompt)
    this.onEvent = deps.onEvent
    this.signal = deps.signal
    this.sessionId = sessionId
  }

  /**
   * 处理一条用户消息（文本或已组装的 content blocks 字符串化文本）。
   * 这是 AgentLoop 与外部唯一的交互点：一次 handleUserMessage = 一轮完整对话。
   */
  async handleUserMessage(text: string): Promise<void> {
    this.messages.push({ role: 'user', content: text })

    // init 事件：让 UI 设置 meta（model/cwd/tools）。
    this.emit({ type: 'init', sessionId: this.sessionId, model: this.model, cwd: this.cwd, tools: this.tools.names() })

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (this.signal.aborted) {
        this.emit({ type: 'ended', error: 'interrupted' })
        return
      }

      let assistantText = ''
      let toolCalls: ToolCall[] = []
      let usage: { inputTokens: number; outputTokens: number } | undefined
      const messageId = cryptoId()

      try {
        // 每轮都带 system（OpenAI 协议下 system 是 messages[0]）。
        const payload = [this.systemMessage(), ...this.messages]
        const turn = await this.provider.complete(payload, this.tools.definitions(), this.model, this.signal)
        assistantText = turn.content
        toolCalls = turn.toolCalls
        usage = turn.usage

        // 实时回显文本（turn.deltas 已含全部增量；这里重放给 onEvent）。
        this.emit({ type: 'assistant_start', messageId })
        for (const d of turn.deltas) {
          if (d.type === 'text') {
            this.emit({ type: 'text_delta', messageId, text: d.text })
          }
        }
        this.emit({ type: 'text_done', messageId, text: assistantText })
      } catch (e) {
        if (this.isAbort(e)) {
          this.emit({ type: 'ended', error: 'interrupted' })
          return
        }
        this.emit({ type: 'ended', error: e instanceof Error ? e.message : String(e) })
        return
      }

      // 记录 assistant 这轮（含工具调用，供下一轮上下文）。
      this.messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: toolCalls.length ? toolCalls : undefined
      })

      // 无工具调用 → 回合结束。
      if (!toolCalls.length) {
        this.emit({ type: 'turn_end', usage })
        return
      }

      // 有工具调用：逐个执行并回填。
      for (const call of toolCalls) {
        this.emit({
          type: 'tool_use',
          messageId,
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments
        })
        const result = await this.executeTool(call)
        this.emit({
          type: 'tool_result',
          toolCallId: call.id,
          content: result.content,
          isError: result.isError
        })
        // 回填为 tool 消息（OpenAI: role=tool + tool_call_id）。
        this.messages.push({ role: 'tool', content: result.content, toolCallId: call.id })
      }
      // 工具执行完，回到循环顶再调一次模型（让它消化工具结果）。
    }

    // 达到上限仍未结束。
    this.emit({ type: 'ended', error: `工具调用轮次达到上限 (${MAX_TOOL_ROUNDS})` })
  }

  /** 执行单个工具：危险工具先走审批。 */
  private async executeTool(call: ToolCall): Promise<{ content: string; isError?: boolean }> {
    const handler = this.tools.get(call.name)
    const ctx: ToolContext = {
      cwd: this.cwd,
      signal: this.signal,
      requestApproval: async () => true
    }
    if (handler?.risk === 'requires-approval') {
      const ok = await ctx.requestApproval(call.arguments)
      if (!ok) return { content: '用户拒绝了该操作。', isError: true }
    }
    return this.tools.execute(call.name, call.arguments, ctx)
  }

  private systemMessage(): ChatMessage {
    return { role: 'system', content: this.systemPrompt }
  }

  private emit(e: AnvilEvent): void {
    try {
      this.onEvent(e)
    } catch {
      /* 回调异常不应中断 loop */
    }
  }

  private isAbort(e: unknown): boolean {
    return (
      e instanceof DOMException ||
      (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message)))
    )
  }
}

function cryptoId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'msg_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
