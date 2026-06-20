import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

/**
 * WSL path/spawn helpers — macOS stubs.
 *
 * WSL is a Windows-only concept and does not exist on macOS. The macOS build is
 * Claude-Code-only, so every WSL code path is unreachable here (the runtime
 * backend never resolves to 'wsl' off-Windows — see preferences.ts). These
 * stubs preserve the exported signatures that ipc.ts / providers.ts /
 * runtimeDiagnostics.ts import against, so those modules keep compiling without
 * carrying the Windows-only `wsl.exe` / UNC-path machinery. They return safe
 * no-op/empty values; none are ever called at runtime on macOS.
 */

export function getDefaultWslDistro(): string | undefined {
  return undefined
}

export function getWslHome(): string | undefined {
  return undefined
}

export function toWslPath(path: string | undefined): string | undefined {
  return path
}

export function isWslUncPath(_path: string | undefined): boolean {
  return false
}

export function toWslUncPath(
  path: string | undefined,
  _distro: string | undefined = getDefaultWslDistro()
): string | undefined {
  return path
}

export function fromWslPath(path: string | undefined): string | undefined {
  return path
}

export function spawnClaudeViaWsl(_options: SpawnOptions): SpawnedProcess {
  // Unreachable on macOS — ClaudeCodeBackend only spawns via WSL when
  // process.platform === 'win32'.
  throw new Error('WSL Claude backend is not available on macOS.')
}
