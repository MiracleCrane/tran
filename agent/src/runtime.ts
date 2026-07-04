import { randomUUID } from 'node:crypto'
import { AgentLoop } from './loop/AgentLoop.js'
import { defaultTools } from './tools/index.js'
import type {
  AnvilEvent,
  ProviderConfig,
  ToolHandler
} from './types.js'

/**
 * 一个 Anvil 会话：持有一个 AgentLoop + 一条消息队列。
 *
 * cli-mac 侧的 AnvilBackend 用 createAnvilRuntime() 造会话，然后把
 * AnvilEvent 流交给 stream.ts 伪装成 SDKMessage 喂给 UI。
 */
export interface AnvilSession {
  readonly id: string
  /** 推入用户消息；异步在后台驱动 loop（不阻塞，结果走 onEvent）。 */
  send(text: string): void
  /** 中断当前轮（对应 AgentBridge.interrupt）。 */
  interrupt(): void
  /** 关闭会话。 */
  close(): void
}

export interface CreateSessionOptions {
  provider: ProviderConfig
  model: string
  cwd: string
  /** 可选自定义工具（默认 read_file + bash）。 */
  tools?: ToolHandler[]
  /** 可选系统提示覆盖。 */
  systemPrompt?: string
  /** AnvilEvent 出口。 */
  onEvent: (event: AnvilEvent) => void
}

/**
 * 创建一个 Anvil 会话。依赖全部由调用方注入 —— runtime 本身不碰 Electron，
 * 所以它也能在纯 Node / 测试里跑（将来独立 CLI 化的基石）。
 */
export function createAnvilSession(opts: CreateSessionOptions): AnvilSession {
  const id = randomUUID()
  const controller = new AbortController()
  const queue: string[] = []
  let loopRunning = false
  let closed = false

  const loop = new AgentLoop(
    {
      provider: opts.provider,
      model: opts.model,
      cwd: opts.cwd,
      tools: opts.tools ?? defaultTools(),
      systemPrompt: opts.systemPrompt ?? '',
      onEvent: opts.onEvent,
      signal: controller.signal
    },
    id
  )

  async function pump(): Promise<void> {
    if (loopRunning || closed) return
    const next = queue.shift()
    if (!next) return
    loopRunning = true
    try {
      await loop.handleUserMessage(next)
    } finally {
      loopRunning = false
    }
    // 队列里还有 → 继续泵。
    if (queue.length && !closed) void pump()
  }

  return {
    id,
    send(text) {
      if (closed) return
      queue.push(text)
      void pump()
    },
    interrupt() {
      controller.abort()
    },
    close() {
      closed = true
      controller.abort()
    }
  }
}
