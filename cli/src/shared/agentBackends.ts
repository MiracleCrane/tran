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
    name: 'Claude Code',
    description:
      'Claude Code CLI（stream-json 双向流）。消息形状与 Tran 内部一致，流式、工具调用、结果统计原生直通；权限由启动时的模式决定，MCP 由 Claude Code 自己管理。',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      // 权限走 --permission-mode（逐条确认 = Claude Code 自己的弹窗），
      // Tran 内的权限卡片暂不接管。
      permissions: false,
      // MCP 由 Claude Code 侧配置，Tran 面板不做增删改。
      mcp: false,
      skills: false,
      sessionHistory: true,
      subagents: false
    }
  }
]

export function normalizeAgentBackend(value: unknown): AgentBackendId {
  return AGENT_BACKEND_IDS.includes(value as AgentBackendId)
    ? (value as AgentBackendId)
    : DEFAULT_AGENT_BACKEND_ID
}
