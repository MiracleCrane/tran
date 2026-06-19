import { spawnSync } from 'node:child_process'
import { log } from './logger'

function runWslJsonScript(script: string, input?: string, timeoutMs = 10000): string {
  const result = spawnSync('wsl.exe', ['--exec', 'python3', '-c', script], {
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || `exit code ${result.status ?? 'unknown'}`
    throw new Error(`wsl.exe failed: ${detail}`)
  }
  return result.stdout ?? ''
}

export function readWslClaudeSettings(): Record<string, unknown> {
  if (process.platform !== 'win32') return {}
  const script = [
    'import json, pathlib, sys',
    "path = pathlib.Path.home() / '.claude' / 'settings.json'",
    'try:',
    "    sys.stdout.write(path.read_text(encoding='utf-8'))",
    'except FileNotFoundError:',
    "    sys.stdout.write('{}')",
    'except Exception:',
    "    sys.stdout.write('{}')"
  ].join('\n')

  try {
    const stdout = runWslJsonScript(script)
    const parsed: unknown = JSON.parse(stdout || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch (err) {
    log('wsl-config', `read settings failed: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

export function writeWslClaudeSettings(data: Record<string, unknown>): void {
  if (process.platform !== 'win32') return
  const script = [
    'import json, pathlib, sys',
    "path = pathlib.Path.home() / '.claude' / 'settings.json'",
    'path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)',
    'data = json.load(sys.stdin)',
    "path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\\n', encoding='utf-8')",
    'path.chmod(0o600)',
    'try:',
    '    path.parent.chmod(0o700)',
    'except Exception:',
    '    pass'
  ].join('\n')

  try {
    runWslJsonScript(script, JSON.stringify(data))
  } catch (err) {
    log('wsl-config', `write settings failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}
