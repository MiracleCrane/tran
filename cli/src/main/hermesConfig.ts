import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerEntry, Provider } from '../shared/ipc'
import { DEFAULT_HERMES_MODEL_ID } from '../shared/models'
import { log } from './logger'
import { resolveWindowsHermesCommand } from './windowsHermes'

interface HermesModelConfig {
  provider?: string
  baseUrl?: string
  defaultModel?: string
  apiMode?: string
}

interface ParsedHermesMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  timeout?: number
  connectTimeout?: number
}

let cachedConfigPath: string | null = null

export function hermesConfigPath(): string {
  if (cachedConfigPath) return cachedConfigPath
  if (process.env.HERMES_CONFIG) {
    cachedConfigPath = process.env.HERMES_CONFIG
    return cachedConfigPath
  }

  try {
    const resolved = resolveWindowsHermesCommand()
    const result = spawnSync(resolved.command, [...resolved.argsPrefix, 'config', 'path'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    })
    const path = result.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (!result.error && result.status === 0 && path) {
      cachedConfigPath = path
      return cachedConfigPath
    }
  } catch (error) {
    log('hermes-config', `resolve path failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const localAppData = process.env.LOCALAPPDATA
  cachedConfigPath = localAppData
    ? join(localAppData, 'hermes', 'config.yaml')
    : join(homedir(), '.hermes', 'config.yaml')
  return cachedConfigPath
}

function readConfigText(): string {
  const path = hermesConfigPath()
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    log('hermes-config', `read failed: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function scalarValue(value: string): string {
  const withoutComment = value.replace(/\s+#.*$/, '')
  return unquote(withoutComment.trim())
}

function indentOf(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0
}

function numberValue(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  return fallback
}

function redactSecret(key: string, value: string): string {
  return /token|key|secret|password|authorization/i.test(key) && value ? '[redacted]' : value
}

function readIndentedMap(lines: string[], startIndex: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (indentOf(line) <= 4) break
    const match = line.match(/^\s{6}([^:#][^:]*):\s*(.*)$/)
    if (!match) continue
    const key = scalarValue(match[1])
    out[key] = redactSecret(key, scalarValue(match[2]))
  }
  return out
}

function readIndentedList(lines: string[], startIndex: number): string[] {
  const out: string[] = []
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (indentOf(line) < 4) break
    const match = line.match(/^\s{4}-\s*(.*)$/)
    if (!match) break
    out.push(scalarValue(match[1]))
  }
  return out
}

function readModelConfig(text = readConfigText()): HermesModelConfig {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^model:\s*(?:#.*)?$/.test(line))
  if (start < 0) {
    const scalar = lines.find((line) => /^model:\s+/.test(line))
    return scalar ? { defaultModel: scalarValue(scalar.replace(/^model:\s+/, '')) } : {}
  }

  const config: HermesModelConfig = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (indentOf(line) === 0) break
    const match = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    const value = scalarValue(match[2])
    if (key === 'provider') config.provider = value
    else if (key === 'base_url') config.baseUrl = value
    else if (key === 'default' || key === 'model') config.defaultModel = value
    else if (key === 'api_mode') config.apiMode = value
  }
  return config
}

export function readHermesDefaultModel(): string | undefined {
  return readModelConfig().defaultModel
}

export function readHermesProvider(): Provider {
  const model = readModelConfig()
  const provider = model.provider || 'hermes'
  const baseUrl = model.baseUrl || ''
  return {
    id: 'hermes-native-config',
    name: `Hermes ${provider}`,
    baseUrl: baseUrl || 'Hermes managed provider',
    token: '',
    authType: 'bearer',
    model: model.defaultModel || DEFAULT_HERMES_MODEL_ID
  }
}

function readMcpServersFromConfig(text = readConfigText()): ParsedHermesMcpServer[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^mcp_servers:\s*(?:#.*)?$/.test(line))
  if (start < 0) return []

  const servers: ParsedHermesMcpServer[] = []
  let current: ParsedHermesMcpServer | null = null

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent === 0) break

    const serverMatch = line.match(/^\s{2}([^:#][^:]*):\s*(?:#.*)?$/)
    if (serverMatch) {
      current = { name: scalarValue(serverMatch[1]), enabled: true }
      servers.push(current)
      continue
    }
    if (!current) continue

    const keyMatch = line.match(/^\s{4}([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!keyMatch) continue
    const key = keyMatch[1]
    const value = scalarValue(keyMatch[2])
    if (key === 'command') current.command = value
    else if (key === 'url') current.url = value
    else if (key === 'enabled') current.enabled = booleanValue(value, true)
    else if (key === 'timeout') current.timeout = numberValue(value)
    else if (key === 'connect_timeout') current.connectTimeout = numberValue(value)
    else if (key === 'args') current.args = readIndentedList(lines, i)
    else if (key === 'env') current.env = readIndentedMap(lines, i)
    else if (key === 'headers') current.headers = readIndentedMap(lines, i)
  }

  return servers
}

export function listHermesMcpServers(): McpServerEntry[] {
  return readMcpServersFromConfig().map((server) => ({
    name: server.name,
    status: server.enabled ? 'connected' : 'disabled',
    scope: 'managed',
    config: {
      type: server.url ? 'http' : 'stdio',
      ...(server.command ? { command: server.command } : {}),
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.headers ? { headers: server.headers } : {}),
      ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
      ...(server.connectTimeout !== undefined ? { connect_timeout: server.connectTimeout } : {}),
      enabled: server.enabled
    }
  }))
}

export function setHermesMcpServerEnabled(name: string, enabled: boolean): void {
  const path = hermesConfigPath()
  const text = readFileSync(path, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const mcpStart = lines.findIndex((line) => /^mcp_servers:\s*(?:#.*)?$/.test(line))
  if (mcpStart < 0) throw new Error('Hermes config has no mcp_servers section.')

  let serverStart = -1
  let serverEnd = lines.length
  for (let i = mcpStart + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() && indentOf(line) === 0) {
      if (serverStart >= 0) serverEnd = i
      break
    }
    const match = line.match(/^\s{2}([^:#][^:]*):\s*(?:#.*)?$/)
    if (!match) continue
    const serverName = scalarValue(match[1])
    if (serverStart >= 0) {
      serverEnd = i
      break
    }
    if (serverName === name) serverStart = i
  }
  if (serverStart < 0) throw new Error(`Hermes MCP server not found: ${name}`)

  let enabledLine = -1
  for (let i = serverStart + 1; i < serverEnd; i++) {
    if (/^\s{4}enabled:\s*/.test(lines[i])) {
      enabledLine = i
      break
    }
  }
  const nextLine = `    enabled: ${enabled ? 'true' : 'false'}`
  if (enabledLine >= 0) lines[enabledLine] = nextLine
  else lines.splice(serverStart + 1, 0, nextLine)
  writeFileSync(path, lines.join(eol), 'utf8')
}
