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
      'Claude Code CLI（stream-json 双向流）。消息形状与 Tran 内部一致，流式、工具调用、结果统计原生直通；权限询问走控制协议接进 Tran 的确认弹窗，MCP 由 Claude Code 自己管理。',
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
