import type { AgentBackendId, ComposerModel } from './ipc'

export const DEFAULT_CLAUDE_MODEL_ID = 'claude-opus-4-8'
export const DEFAULT_CODEX_MODEL_ID = 'codex-default'

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

export function defaultModelsForAgent(agentBackend: AgentBackendId | undefined): ComposerModel[] {
  return agentBackend === 'codex' ? DEFAULT_CODEX_MODELS : DEFAULT_CLAUDE_MODELS
}

export function modelLabelForAgent(agentBackend: AgentBackendId | undefined, id: string): string {
  return defaultModelsForAgent(agentBackend).find((model) => model.id === id)?.label ?? id
}
