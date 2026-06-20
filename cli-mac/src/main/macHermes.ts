/**
 * macOS Hermes resolver stub.
 *
 * Scope decision: the macOS build is Claude-Code-only — the Hermes agent backend
 * is disabled here. HermesBackend / HermesAcpClient still import a resolver and
 * still short-circuit with a `process.platform !== 'win32' → throw` guard, so
 * this resolver is NEVER invoked at runtime on macOS. It exists so the modules
 * keep compiling against a local file (rather than the deleted Windows resolver)
 * and return the right shape ({ command, argsPrefix, displayPath }).
 */

export interface MacHermesCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

export function resolveMacHermesCommand(): MacHermesCommand {
  // Unreachable on macOS — HermesBackend throws before calling this.
  return { command: 'hermes', argsPrefix: [], displayPath: 'hermes' }
}
