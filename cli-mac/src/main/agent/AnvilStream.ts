import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AnvilEvent } from '@claude-forge/agent'
import { log } from '../logger'

/**
 * Anvil → SDKMessage 伪装层。
 *
 * Anvil runtime 产出的是协议无关的 AnvilEvent。cli-mac 的渲染管线
 * （sessionStore/streamBatcher）只认 Claude SDK 的消息形状，所以这里把
 * AnvilEvent 翻译成 UI 期望的那几种 SDKMessage。UI 代码零改动。
 *
 * 伪装的消息子集（UI 实际消费的）：
 *   - system/init          → 设置 meta（model/cwd/tools）
 *   - stream_event         → 实时流式（block_start/delta/stop）
 *   - assistant            → 权威最终消息
 *   - user(tool_result)    → 工具执行结果
 *   - result               → 回合结束（usage）
 *
 * block index 约定：一个 assistant 消息内，每个 content block（text / tool_use）
 * 占一个递增 index。文本块在第一个 delta 前自动补 content_block_start，在
 * text_done 时补 content_block_stop；工具块在 tool_use 时 start+stop。
 */
export class AnvilStream {
  /** 当前 assistant 消息内已分配的 block 数（用于下一个 index）。 */
  private blockIndex = 0
  /** 文本块的 index（首个 delta 时 lazily 分配）。 */
  private textBlockIndex: number | null = null
  /** 文本块是否已发过 content_block_start。 */
  private textStarted = false
  private currentMessageId: string | null = null

  /** 把单个 AnvilEvent 转成 0..N 条 SDKMessage（按顺序）。 */
  toSDKMessages(event: AnvilEvent): SDKMessage[] {
    switch (event.type) {
      case 'init':
        return [this.systemInit(event)]

      case 'assistant_start': {
        // 新 assistant 消息开始 → 重置 block 状态。
        this.blockIndex = 0
        this.textBlockIndex = null
        this.textStarted = false
        this.currentMessageId = event.messageId
        return []
      }

      case 'text_delta': {
        // 首个 delta 前补 content_block_start（lazy 分配 text block index）。
        const out: SDKMessage[] = []
        if (!this.textStarted) {
          this.textBlockIndex = this.blockIndex++
          this.textStarted = true
          out.push(this.contentBlockStartText(event.messageId, this.textBlockIndex))
        }
        out.push(
          this.contentBlockDeltaText(event.messageId, this.textBlockIndex ?? 0, event.text)
        )
        return out
      }

      case 'text_done': {
        // text 流完：先发 content_block_stop（若有文本块），再发权威 assistant。
        const out: SDKMessage[] = []
        if (this.textStarted && this.textBlockIndex !== null) {
          out.push(this.contentBlockStop(event.messageId, this.textBlockIndex))
          this.textStarted = false
        }
        out.push(this.assistantText(event.messageId, event.text))
        return out
      }

      case 'tool_use': {
        // tool_use：start + stop + 权威 assistant。
        const idx = this.blockIndex++
        return [
          this.contentBlockStartTool(event.messageId, idx, event.toolCallId, event.toolName),
          this.contentBlockStop(event.messageId, idx),
          this.assistantToolUse(event.messageId, event.toolCallId, event.toolName, event.input)
        ]
      }

      case 'tool_result':
        return [this.userToolResult(event.toolCallId, event.content, event.isError)]

      case 'turn_end':
        return [this.resultMessage(event.usage)]

      case 'ended':
        // ended 不产 SDKMessage —— 它走 AgentBridge 的 onEnded 通道。
        return []

      default: {
        const exhaustive: never = event
        log('anvil', `未处理的 AnvilEvent: ${JSON.stringify(exhaustive)}`)
        return []
      }
    }
  }

  private systemInit(e: Extract<AnvilEvent, { type: 'init' }>): SDKMessage {
    return {
      type: 'system',
      subtype: 'init',
      session_id: e.sessionId,
      cwd: e.cwd,
      model: e.model,
      permissionMode: 'default',
      tools: e.tools
    } as unknown as SDKMessage
  }

  // ---- stream_event 家族 ----

  private contentBlockStartText(uuid: string, index: number): SDKMessage {
    return {
      type: 'stream_event',
      uuid,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      }
    } as unknown as SDKMessage
  }

  private contentBlockDeltaText(uuid: string, index: number, text: string): SDKMessage {
    return {
      type: 'stream_event',
      uuid,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text }
      }
    } as unknown as SDKMessage
  }

  private contentBlockStartTool(
    uuid: string,
    index: number,
    toolCallId: string,
    toolName: string
  ): SDKMessage {
    return {
      type: 'stream_event',
      uuid,
      parent_tool_use_id: null,
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: toolCallId, name: toolName, text: '' }
      }
    } as unknown as SDKMessage
  }

  private contentBlockStop(uuid: string, index: number): SDKMessage {
    return {
      type: 'stream_event',
      uuid,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index }
    } as unknown as SDKMessage
  }

  // ---- 权威消息 ----

  private assistantText(uuid: string, text: string): SDKMessage {
    return {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: {
        id: uuid,
        content: [{ type: 'text', text }]
      }
    } as unknown as SDKMessage
  }

  private assistantToolUse(
    uuid: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): SDKMessage {
    return {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: {
        id: uuid,
        content: [{ type: 'tool_use', id: toolCallId, name: toolName, input }]
      }
    } as unknown as SDKMessage
  }

  private userToolResult(toolCallId: string, content: string, isError?: boolean): SDKMessage {
    return {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content,
            is_error: !!isError
          }
        ]
      }
    } as unknown as SDKMessage
  }

  private resultMessage(
    usage?: { inputTokens: number; outputTokens: number }
  ): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      parent_tool_use_id: null,
      is_error: false,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: usage?.inputTokens ?? 0,
        output_tokens: usage?.outputTokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null
      },
      result: '(done)',
      stop_reason: 'end_turn'
    } as unknown as SDKMessage
  }
}
