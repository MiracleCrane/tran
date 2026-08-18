/**
 * 斜杠命令的显示别名。
 *
 * 为什么需要这层：kimi 的 `available_commands_update` 只给 `name` /
 * `description` / `input` 三个字段，**没有任何"显示名"**。`skill:handoff` 的
 * description 是一整句英文（"Create a continuation checkpoint or formal
 * handoff…"），直接拿来当标题又长又不像话。Codex 那边显示「分类型任务交接」
 * 是因为它自己的技能元数据里带中文标题——kimi 没有对应数据，只能由 Tran 补。
 *
 * 所以：内置命令给一套默认中文名，其余显示原名，用户可以自己改。
 */

/** kimi 内置/官方命令的默认中文名（实测 available_commands_update 的全量）。 */
const DEFAULT_ALIASES: Record<string, string> = {
  compact: '压缩上下文',
  status: '会话状态',
  usage: 'Token用量',
  mcp: 'MCP状态',
  tasks: '后台任务',
  help: '命令帮助',
  'check-kimi-code-docs': '查官方文档',
  'custom-theme': '自定义主题',
  'import-from-cc-codex': '导入CCCodex',
  'mcp-config': '配置MCP',
  'sub-skill': '技能分组',
  'sub-skill.consolidate': '技能分组·应用',
  'sub-skill.review': '技能分组·评审',
  'update-config': '更新Kimi配置',
  'write-goal': '拟定目标',
  // Claude Code 侧的常用内置命令
  context: '上下文明细',
  model: '切换模型',
  clear: '清空会话',
  init: '初始化项目',
  review: '审查当前改动',
  agents: '子Agent',
  // 本机工程 Skills：展示名同时就是可输入的 /别名，必须无空格且保持唯一。
  'skill:ask-matt': '技能导航',
  'skill:bestpay-etl-test-env': '翼支付综测',
  'skill:bestpay-winglong-release': '翼龙发版',
  'skill:bug-fix': '修复缺陷',
  'skill:code-review': '双轴代码审查',
  'skill:codebase-design': '模块设计',
  'skill:diagnosing-bugs': '故障诊断',
  'skill:domain-modeling': '领域建模',
  'skill:find-skills': '查找技能',
  'skill:github-proxy': 'GitHub代理',
  'skill:grill-me': '方案拷问',
  'skill:grill-with-docs': '方案拷问文档',
  'skill:grilling': '深度拷问',
  'skill:handoff': '任务交接',
  'skill:implement': '实现任务',
  'skill:improve-codebase-architecture': '架构改进',
  'skill:prototype': '快速原型',
  'skill:research': '资料研究',
  'skill:setup-matt-pocock-skills': '初始化工程技能',
  'skill:simulate-frontend-login': '模拟前端登录',
  'skill:tdd': '测试驱动',
  'skill:teach': '教学讲解',
  'skill:to-spec': '生成规格',
  'skill:to-tickets': '拆分工单',
  'skill:wayfinder': '大型任务规划',
  'skill:write-bestpay-monthly-report': '翼支付月报',
  'skill:yuque-mcp-windows': '语雀连接',
  // Codex 自带/本机系统 Skills。
  'skill:imagegen': '图像生成',
  'skill:openai-docs': 'OpenAI文档',
  'skill:plugin-creator': '创建插件',
  'skill:skill-creator': '创建技能',
  'skill:skill-installer': '安装技能',
  'skill:hatch-pet': '孵化宠物'
}

const KEY_PREFIX = 'forge.commandAliases.'

function storeKey(backend: string | undefined): string {
  return `${KEY_PREFIX}${backend ?? 'kimi'}`
}

/** 用户自定义的别名（覆盖默认表）。 */
export function readAliases(backend: string | undefined): Record<string, string> {
  try {
    const raw = localStorage.getItem(storeKey(backend))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // 历史事故清理：window.prompt 在 Electron 不支持（2026-08-18 实测抛
      // "prompt() is not supported."），旧改名流程可能把错误串当成别名写进
      // 来——读到一律当没有。
      if (typeof v === 'string' && v.trim() && !/prompt\(\) is not supported/i.test(v)) out[k] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

export function writeAlias(backend: string | undefined, name: string, alias: string): void {
  const current = readAliases(backend)
  const next = alias.trim()
  if (next) current[name] = next
  else delete current[name] // 清空 = 恢复默认/原名
  try {
    localStorage.setItem(storeKey(backend), JSON.stringify(current))
  } catch {
    /* 配额满就算了 */
  }
}

export function replaceAliases(backend: string | undefined, aliases: Record<string, string>): void {
  const normalized: Record<string, string> = {}
  for (const [name, alias] of Object.entries(aliases)) {
    const key = name.trim()
    const value = typeof alias === 'string' ? alias.trim() : ''
    if (key && value) normalized[key] = value
  }
  localStorage.setItem(storeKey(backend), JSON.stringify(normalized))
}

/**
 * 命令的显示名：用户别名 > 默认中文名 > 原名。
 *
 * `skill:xxx` 这类前缀在没有别名时会被剥掉——列表里一屏全是 `skill:` 前缀，
 * 除了占地方没有任何信息量（真正的原名在旁边灰字里仍然看得到）。
 */
export function displayName(
  name: string,
  backend: string | undefined,
  aliases?: Record<string, string>
): string {
  const custom = (aliases ?? readAliases(backend))[name]
  if (custom) return custom
  const preset = DEFAULT_ALIASES[name]
  if (preset) return preset
  return name.replace(/^skill:/, '')
}

/** 这个命令现在显示的是不是「非原名」（决定要不要在旁边补一行灰色原名）。 */
export function hasFriendlyName(
  name: string,
  backend: string | undefined,
  aliases?: Record<string, string>
): boolean {
  return displayName(name, backend, aliases) !== name
}
