import type { ToolContext, ToolDefinition, ToolHandler } from '../types.js'

/**
 * 工具注册表。AgentLoop 从这里取 ToolDefinition[] 传给 provider，并按名字
 * 派发执行。新增工具只需 register() —— 框架不感知具体工具。
 *
 * 设计：工具集分两组——code 组（核心，P0 先有 read_file/bash）和 daily 组
 * （兼顾，后续补齐 web/translate/note…）。
 */
export class ToolRegistry {
  private readonly byName = new Map<string, ToolHandler>()

  constructor(handlers: ToolHandler[] = []) {
    for (const h of handlers) this.register(h)
  }

  register(handler: ToolHandler): void {
    if (this.byName.has(handler.name)) {
      throw new Error(`工具已注册: ${handler.name}`)
    }
    this.byName.set(handler.name, handler)
  }

  /** 取全部工具的 schema（传给 provider 的 tools 参数）。 */
  definitions(): ToolDefinition[] {
    return [...this.byName.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema
    }))
  }

  /** 按名字查找可执行 handler。 */
  get(name: string): ToolHandler | undefined {
    return this.byName.get(name)
  }

  /** 派发执行。未知工具 → 结构化错误回填（模型可据此纠正）。 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<{ content: string; isError?: boolean }> {
    const handler = this.byName.get(name)
    if (!handler) {
      return {
        content: `未知工具: ${name}。可用工具: ${[...this.byName.keys()].join(', ')}`,
        isError: true
      }
    }
    return handler.execute(args, ctx)
  }

  /** 全部工具名（用于 init 事件）。 */
  names(): string[] {
    return [...this.byName.keys()]
  }
}
