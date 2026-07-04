/**
 * @claude-forge/agent — Anvil runtime.
 *
 * Provider-direct、SDK-free 的 agent runtime。自己驱动 LLM + 工具循环，
 * 不依赖 claude.exe。对外只产出协议无关的 AnvilEvent；SDKMessage 的「伪装」
 * 由宿主（cli-mac）侧负责，这样本包在纯 Node / 测试里也能跑。
 */
export { createAnvilSession } from './runtime.js'
export type { AnvilSession, CreateSessionOptions } from './runtime.js'
export { AgentLoop } from './loop/AgentLoop.js'
export { ToolRegistry } from './tools/registry.js'
export { createProviderClient } from './providers/ProviderClient.js'
export { OpenAIAdapter } from './providers/OpenAIAdapter.js'
export { defaultTools } from './tools/index.js'
export { buildSystemPrompt } from './prompt/PromptBuilder.js'
export { readFileTool } from './tools/code/readFile.js'
export { bashTool } from './tools/code/bash.js'

export type {
  AnvilEvent,
  AssistantTurn,
  ChatMessage,
  ProviderClient,
  ProviderConfig,
  StreamDelta,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolHandler,
  ToolResult,
  ToolRisk,
  SessionDeps
} from './types.js'

export const ANVIL_VERSION = '0.1.0'
