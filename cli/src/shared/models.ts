import type { AgentBackendId, ComposerModel } from './ipc'

export const DEFAULT_KIMI_MODEL_ID = 'kimi-default'

/** 静态兜底模型列表（id/label 来自 session/new configOptions.model 实测值）。
 *  KimiBackend 会用 ACP 返回的 configOptions 动态补充（见 main/agent/KimiBackend.ts）。 */
export const DEFAULT_KIMI_MODELS: ComposerModel[] = [
  { id: DEFAULT_KIMI_MODEL_ID, label: '默认(由 CLI 决定)' },
  { id: 'kimi-code/kimi-for-coding', label: 'K2.7 Coding' },
  { id: 'kimi-code/kimi-for-coding-highspeed', label: 'K2.7 Coding Highspeed' },
  { id: 'kimi-code/k3', label: 'K3' }
]

export function defaultModelsForAgent(_agentBackend: AgentBackendId | undefined): ComposerModel[] {
  return DEFAULT_KIMI_MODELS
}

export function modelLabelForAgent(agentBackend: AgentBackendId | undefined, id: string): string {
  return defaultModelsForAgent(agentBackend).find((model) => model.id === id)?.label ?? id
}
