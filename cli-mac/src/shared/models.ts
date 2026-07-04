import type { AgentBackendId, ComposerModel } from './ipc'

export const DEFAULT_CLAUDE_MODEL_ID = 'claude-opus-4-8'
export const DEFAULT_CODEX_MODEL_ID = 'codex-default'
export const DEFAULT_HERMES_MODEL_ID = 'hermes-default'
export const DEFAULT_ANVIL_MODEL_ID = 'gpt-4o'

export const DEFAULT_CLAUDE_MODELS: ComposerModel[] = [
  { id: DEFAULT_CLAUDE_MODEL_ID, label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

export const DEFAULT_CODEX_MODELS: ComposerModel[] = [
  { id: DEFAULT_CODEX_MODEL_ID, label: 'Codex default' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' }
]

export const DEFAULT_HERMES_MODELS: ComposerModel[] = [
  { id: DEFAULT_HERMES_MODEL_ID, label: 'Hermes default' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' }
]

export const ANVIL_DEFAULT_MODELS: ComposerModel[] = [
  { id: DEFAULT_ANVIL_MODEL_ID, label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat' },
  { id: 'glm-4-plus', label: 'GLM-4 Plus' }
]

export function defaultModelsForAgent(agentBackend: AgentBackendId | undefined): ComposerModel[] {
  if (agentBackend === 'codex') return DEFAULT_CODEX_MODELS
  if (agentBackend === 'hermes') return DEFAULT_HERMES_MODELS
  if (agentBackend === 'anvil') return ANVIL_DEFAULT_MODELS
  return DEFAULT_CLAUDE_MODELS
}

export function modelLabelForAgent(agentBackend: AgentBackendId | undefined, id: string): string {
  return defaultModelsForAgent(agentBackend).find((model) => model.id === id)?.label ?? id
}
