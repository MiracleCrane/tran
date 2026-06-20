export const FORGE_RENDERER_EVENTS = {
  agentBackendChanged: 'forge:agent-backend-changed',
  closePrefsChanged: 'forge:close-prefs-changed',
  modelOptionsChanged: 'forge:model-options-changed',
  providerChanged: 'forge:provider-changed',
  wslSupportChanged: 'forge:wsl-support-changed'
} as const

export type ForgeRendererEventKey = keyof typeof FORGE_RENDERER_EVENTS

export function emitForgeEvent(key: ForgeRendererEventKey): void {
  window.dispatchEvent(new Event(FORGE_RENDERER_EVENTS[key]))
}

export function onForgeEvent(key: ForgeRendererEventKey, listener: () => void): () => void {
  const eventName = FORGE_RENDERER_EVENTS[key]
  window.addEventListener(eventName, listener)
  return () => window.removeEventListener(eventName, listener)
}
