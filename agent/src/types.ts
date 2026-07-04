/**
 * Anvil 内部类型 — provider-direct、SDK-free 的 agent 抽象。
 *
 * 这一层故意不依赖 @anthropic-ai/claude-agent-sdk：agent runtime 自己驱动
 * LLM + 工具循环，不借用 claude.exe。SDKMessage 的「伪装」只发生在 cli-mac
 * 边界（stream.ts），那里才把 Anvil 的事件塑造成 UI 期望的 SDK 形状。
 */

/** 一个可直连的模型供应商（来自 cli-mac 的 Provider）。 */
export interface ProviderConfig {
  /** 显示名，仅供日志。 */
  name: string
  /** chat.completions / responses 端点的根地址。 */
  baseUrl: string
  /** API key 或 bearer token。 */
  token: string
  /** 鉴权方式决定请求头：apikey → x-api-key；bearer → Authorization: Bearer。 */
  authType: 'bearer' | 'apikey'
  /** 默认模型 id。 */
  model: string
  /**
   * P0 显式标注协议。后续 detect.ts 会按 baseUrl 自动探测；这里留扩展位。
   * 'openai' = OpenAI Chat Completions 兼容（智谱/DeepSeek/自建中转…）。
   */
  protocol?: 'openai' | 'anthropic'
}

/** 一段对话里的一条消息。用最小可表达结构，避免绑定任一厂商的 schema。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** system/user/assistant 的文本；tool 消息的工具执行结果文本。 */
  content?: string
  /** 仅 assistant：模型在这一轮请求调用的工具。 */
  toolCalls?: ToolCall[]
  /** 仅 tool：对哪条 tool_use 的回执。 */
  toolCallId?: string
}

/** 模型请求调用一个工具。 */
export interface ToolCall {
  /** 稳定 id，用于把后续的 tool_result 关联回这次调用。 */
  id: string
  /** 工具名（必须与 ToolDefinition.name 一致）。 */
  name: string
  /** 已解析的参数对象。 */
  arguments: Record<string, unknown>
}

/** 流式输出的一个增量。 */
export type StreamDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use_begin'
      toolCallId: string
      toolName: string
    }
  | { type: 'tool_use_argument'; toolCallId: string; partialJson: string }
  | { type: 'tool_use_end'; toolCallId: string }

/** 一轮 LLM 调用完成后产出的「消息骨架」。 */
export interface AssistantTurn {
  /** 模型给出的正文（可能为空，当模型只调用工具时）。 */
  content: string
  /** 这一轮触发的工具调用；为空则表示回合结束。 */
  toolCalls: ToolCall[]
  /** 该轮 token 用量（用于 result 消息回填，可缺省）。 */
  usage?: { inputTokens: number; outputTokens: number }
  /** 厂商 stop 原因，仅供日志。 */
  stopReason?: string
}

/** ProviderClient 统一接口：任一协议适配器实现它。 */
export interface ProviderClient {
  /** 协议标识，用于日志和调试。 */
  readonly protocol: 'openai' | 'anthropic'
  /**
   * 流式跑一轮。逐个 yield StreamDelta（实时回显），返回本轮最终骨架。
   * signal 用于中断（对应 AgentBridge.interrupt）。
   */
  complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    model: string,
    signal: AbortSignal
  ): Promise<AssistantTurn & { deltas: StreamDelta[] }>
}

/** 工具的 JSON Schema 参数描述（OpenAI/Anthropic 兼容的最小子集）。 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema，描述 input 对象。 */
  inputSchema: Record<string, unknown>
}

/** 工具执行结果。 */
export interface ToolResult {
  /** 回填给模型的文本（模型据此继续推理）。 */
  content: string
  /** 是否出错（UI 会标红 + 模型会据此调整）。 */
  isError?: boolean
}

/** 是否需要用户审批的危险性。 */
export type ToolRisk = 'safe' | 'requires-approval'

/** 一个可执行工具的完整定义。 */
export interface ToolHandler extends ToolDefinition {
  /** safe 工具直接跑；requires-approval 触发 onPermissionRequest。 */
  risk: ToolRisk
  /** 真正执行。cwd 来自会话；signal 允许长任务被中断。 */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /**
   * 申请审批。返回 true=允许执行，false=用户拒绝。实现由 cli-mac 侧注入
   * （转发到现有 PermissionRequestPayload 机制 + UI）。
   */
  requestApproval(args: Record<string, unknown>): Promise<boolean>
}

/** 运行一个会话所需的全部依赖（依赖注入，便于测试 + 解耦 Electron）。 */
export interface SessionDeps {
  provider: ProviderConfig
  model: string
  cwd: string
  tools: ToolHandler[]
  /** 系统提示文本（PromptBuilder 可叠加 tools schema）。 */
  systemPrompt: string
  /** Anvil 事件回调 —— AgentLoop 产出，cli-mac 侧伪装成 SDKMessage。 */
  onEvent: (event: AnvilEvent) => void
  /** 会话被外部中断时触发。 */
  signal: AbortSignal
}

/** Anvil 对外产出的、协议无关的事件流。stream.ts 负责转成 SDKMessage。 */
export type AnvilEvent =
  | { type: 'init'; sessionId: string; model: string; cwd: string; tools: string[] }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'text_done'; messageId: string; text: string }
  | {
      type: 'tool_use'
      messageId: string
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }
  | {
      type: 'tool_result'
      toolCallId: string
      content: string
      isError?: boolean
    }
  | { type: 'turn_end'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'ended'; error?: string }
