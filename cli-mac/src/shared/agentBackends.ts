export const DEFAULT_AGENT_BACKEND_ID = 'claude-code' as const

export const AGENT_BACKEND_IDS = [DEFAULT_AGENT_BACKEND_ID, 'codex', 'hermes', 'anvil'] as const

export type AgentBackendId = (typeof AGENT_BACKEND_IDS)[number]

export interface AgentBackendInfo {
  id: AgentBackendId
  name: string
  description: string
  status: 'available' | 'coming-soon'
  runtimeModes: Array<'windows' | 'wsl'>
  capabilities: {
    streaming: boolean
    permissions: boolean
    mcp: boolean
    skills: boolean
    sessionHistory: boolean
    subagents: boolean
  }
}

export const AGENT_BACKENDS: AgentBackendInfo[] = [
  {
    id: DEFAULT_AGENT_BACKEND_ID,
    name: 'Claude Code',
    description: 'Anthropic Claude Agent SDK backend with Windows and WSL runtime support.',
    status: 'available',
    runtimeModes: ['windows', 'wsl'],
    capabilities: {
      streaming: true,
      permissions: true,
      mcp: true,
      skills: true,
      sessionHistory: true,
      subagents: true
    }
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Windows Codex app-server backend with streamed events, approvals, MCP, and skills.',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      permissions: true,
      mcp: true,
      skills: true,
      sessionHistory: true,
      subagents: false
    }
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Windows Hermes ACP backend with streamed messages, tools, approvals, and session history.',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      permissions: true,
      mcp: true,
      skills: true,
      sessionHistory: true,
      subagents: false
    }
  },
  {
    id: 'anvil',
    name: 'Anvil',
    description:
      'Forge 自研 agent：直连任意 OpenAI 兼容运营商（智谱/DeepSeek/自建中转），不依赖 claude.exe。倾向代码开发，兼顾日常任务。',
    status: 'available',
    runtimeModes: ['windows', 'wsl'],
    capabilities: {
      streaming: true,
      permissions: false,
      mcp: false,
      skills: false,
      sessionHistory: false,
      subagents: false
    }
  }
]

export function normalizeAgentBackend(value: unknown): AgentBackendId {
  return AGENT_BACKEND_IDS.includes(value as AgentBackendId)
    ? (value as AgentBackendId)
    : DEFAULT_AGENT_BACKEND_ID
}
