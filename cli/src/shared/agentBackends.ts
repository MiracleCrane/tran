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
      // 权限弹窗仍待接（当前由 --permission-mode 在 CLI 侧决策，Tran 不弹窗）；
      // 会话历史列表待接。MCP 与技能已从 system/init 拿到（实测该帧带
      // mcp_servers 与 slash_commands）。
      // 权限弹窗：实测当前 CLI 版本的 stream-json 通道**不提供**交互式
      // 授权信道（无 --permission-prompt-tool，工具直接按 --permission-mode
      // 与 settings 策略执行）。要做弹窗得改走 Agent SDK 的 canUseTool。
      permissions: false,
      mcp: true,
      skills: true,
      sessionHistory: true,
      subagents: true
    }
  }
]

export function normalizeAgentBackend(value: unknown): AgentBackendId {
  return AGENT_BACKEND_IDS.includes(value as AgentBackendId)
    ? (value as AgentBackendId)
    : DEFAULT_AGENT_BACKEND_ID
}
