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
    description: '使用 Kimi Code CLI 处理会话，支持流式输出、工具调用、权限确认和历史会话恢复。',
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
      '使用 Claude Code CLI 处理会话，支持流式输出、工具调用、权限确认、MCP 和历史会话恢复。',
    status: 'available',
    runtimeModes: ['windows'],
    capabilities: {
      streaming: true,
      // 权限走控制协议 can_use_tool → Tran 的权限弹窗 → control_response，
      // 模式切换（默认/自动/YOLO）也是热切，不必重开会话。
      permissions: true,
      // MCP 只做只读展示（增删改仍用 `claude mcp` 命令），技能列表来自
      // system/init。能力徽章只是标注，不驱动任何开关。
      mcp: true,
      skills: true,
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
