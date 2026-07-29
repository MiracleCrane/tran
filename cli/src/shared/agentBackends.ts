export const DEFAULT_AGENT_BACKEND_ID = 'kimi' as const

// 新增后端时在此注册：把 id 加入 AGENT_BACKEND_IDS，并在 AGENT_BACKENDS 里补一条描述。
export const AGENT_BACKEND_IDS = [DEFAULT_AGENT_BACKEND_ID, 'claude'] as const

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
    name: 'Kimi Code CLI',
    description: 'Kimi Code CLI ACP backend (kimi acp) with streamed messages, tools, approvals, and session history.',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      permissions: true,
      mcp: true,
      // skills/subagents 在 Kimi ACP 面上尚未验证，先关闭。
      skills: false,
      sessionHistory: true,
      subagents: false
    }
  },
  {
    id: 'claude',
    name: 'Claude Code CLI',
    description:
      'Claude Code CLI via the stream-json channel (claude -p --input-format stream-json), with streamed messages and subagent forwarding.',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      // 阶段 2 待接：权限弹窗（当前由 --permission-mode 在 CLI 侧决策）、
      // MCP 面板、技能、会话历史列表。
      permissions: false,
      mcp: false,
      skills: false,
      sessionHistory: false,
      subagents: true
    }
  }
]

export function normalizeAgentBackend(value: unknown): AgentBackendId {
  return AGENT_BACKEND_IDS.includes(value as AgentBackendId)
    ? (value as AgentBackendId)
    : DEFAULT_AGENT_BACKEND_ID
}
