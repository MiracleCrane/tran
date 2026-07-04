import type {
  AssistantTurn,
  ChatMessage,
  ProviderClient,
  ProviderConfig,
  StreamDelta,
  ToolCall,
  ToolDefinition
} from '../types.js'

/**
 * OpenAI Chat Completions 协议适配器。覆盖面最广：智谱 GLM、DeepSeek、
 * 自建 OpenAI 兼容中转都能直连 —— 这是 Anvil 相对 ClaudeCodeBackend 的
 * 核心优势（后者被 claude.exe + Anthropic 协议绑死）。
 *
 * 走 /v1/chat/completions + SSE 流式。tool_calls 以 OpenAI 的 function
 * calling 形式编码，这里解码成 Anvil 内部的 ToolCall。
 */
export class OpenAIAdapter implements ProviderClient {
  readonly protocol = 'openai' as const

  constructor(private provider: ProviderConfig) {}

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    model: string,
    signal: AbortSignal
  ): Promise<AssistantTurn & { deltas: StreamDelta[] }> {
    const url = this.endpoint('/v1/chat/completions')
    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (tools.length) {
      body.tools = tools.map(toOpenAITool)
      body.tool_choice = 'auto'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(`OpenAI 接口返回 ${res.status}: ${text.slice(0, 500)}`)
    }

    return parseStream(res.body, signal)
  }

  private endpoint(path: string): string {
    const base = this.provider.baseUrl.replace(/\/+$/, '')
    // 允许 baseUrl 自带 /v1；否则补上。
    return /\/v\d+$/.test(base) ? base + path.replace('/v1', '') : base + path
  }

  private headers(): Record<string, string> {
    // OpenAI 协议下 bearer / apikey 都用 Authorization: Bearer。
    // 保留 authType 分支是为了将来 anthropic adapter 的 x-api-key 路径。
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.provider.token}`
    }
  }
}

/** 把 Anvil ChatMessage 转成 OpenAI wire 格式。 */
function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' }
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) }
      }))
    }
  }
  return { role: m.role, content: m.content ?? '' }
}

function toOpenAITool(t: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }
}

/**
 * 解析 OpenAI SSE 流：累积 text + tool_calls，边读边产出 StreamDelta。
 *
 * OpenAI 的 tool_calls 在流里是「分片」的——同一个 tool_call 的 arguments
 * 被切成多个 chunk 到达，靠 index 拼接。这里按 index 聚合。
 */
async function parseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<AssistantTurn & { deltas: StreamDelta[] }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  const deltas: StreamDelta[] = []
  /** index → 正在累积的 tool_call。 */
  const toolAccum = new Map<number, { id: string; name: string; args: string }>()
  let usage: { inputTokens: number; outputTokens: number } | undefined
  let stopReason: string | undefined

  try {
    while (true) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE 以 \n\n 分隔事件。
      let sep: number
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const data = extractSSEData(rawEvent)
        if (!data) continue
        if (data === '[DONE]') {
          buf = ''
          continue
        }
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        const choices = chunk.choices as Array<Record<string, unknown>> | undefined
        const choice = choices?.[0]
        const delta = choice?.delta as Record<string, unknown> | undefined
        if (delta) {
          // text 增量
          const dt = delta.content as string | undefined
          if (typeof dt === 'string' && dt) {
            text += dt
            deltas.push({ type: 'text', text: dt })
          }
          // tool_call 分片
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined
          if (tcs) {
            for (const tc of tcs) {
              const idx = (tc.index as number | undefined) ?? 0
              const fn = tc.function as
                | { id?: string; name?: string; arguments?: string }
                | undefined
              const slot = toolAccum.get(idx) ?? { id: '', name: '', args: '' }
              const isFirst = !toolAccum.has(idx)
              if (fn?.id) slot.id = fn.id
              if (fn?.name) slot.name = fn.name
              if (isFirst && slot.id) {
                deltas.push({ type: 'tool_use_begin', toolCallId: slot.id, toolName: slot.name })
              }
              if (fn?.arguments) {
                slot.args += fn.arguments
                deltas.push({
                  type: 'tool_use_argument',
                  toolCallId: slot.id,
                  partialJson: fn.arguments
                })
              }
              toolAccum.set(idx, slot)
            }
          }
        }
        const finish = choice?.finish_reason as string | undefined
        if (finish) stopReason = finish
        const u = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined
        if (u) {
          usage = {
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  // 收尾：所有 tool_call 的 end delta + 解析最终参数。
  const toolCalls: ToolCall[] = []
  for (const [, slot] of [...toolAccum].sort((a, b) => a[0] - b[0])) {
    if (slot.id) deltas.push({ type: 'tool_use_end', toolCallId: slot.id })
    let parsed: Record<string, unknown> = {}
    if (slot.args) {
      try {
        parsed = JSON.parse(slot.args) as Record<string, unknown>
      } catch {
        parsed = { _raw: slot.args }
      }
    }
    toolCalls.push({ id: slot.id || cryptoId(), name: slot.name, arguments: parsed })
  }

  return { content: text, toolCalls, usage, stopReason, deltas }
}

function extractSSEData(rawEvent: string): string | null {
  // 取 data: 行（可能多行），忽略 event:/id:/retry:。
  const lines = rawEvent.split('\n')
  const dataLines: string[] = []
  for (const line of lines) {
    const l = line.trimStart()
    if (l.startsWith('data:')) dataLines.push(l.slice(5).trimStart())
  }
  return dataLines.length ? dataLines.join('\n') : null
}

function cryptoId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return 'call_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
