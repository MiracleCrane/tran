/**
 * macOS Codex resolver stub.
 *
 * Scope decision: the macOS build is Claude-Code-only — the Codex (and Hermes)
 * agent backends are disabled here. CodexBackend / CodexAppServerClient still
 * import a resolver and still short-circuit with a `process.platform !== 'win32'
 * → throw` guard, so this resolver is NEVER actually invoked at runtime on
 * macOS. It exists solely so the modules keep compiling against a local file
 * (rather than the deleted Windows resolver) and return the right shape.
 *
 * The returned shape mirrors the Windows ResolvedCodexCommand
 * ({ command, argsPrefix, displayPath }).
 */

export interface ResolvedCodexCommand {
  command: string
  argsPrefix: string[]
  displayPath: string
}

export function resolveMacCodexCommand(): ResolvedCodexCommand {
  // Unreachable on macOS — CodexBackend throws before calling this.
  return { command: 'codex', argsPrefix: [], displayPath: 'codex' }
}
