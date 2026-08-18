import { readFileSync } from 'node:fs'
import { log } from './logger'

/**
 * 从 kimi 会话的 wire.jsonl 直接重建完整历史（2026-08-18 用户拍板：
 * 「可以直接解析么？如果可以的话那就做吧」）。
 *
 * 背景：kimi 的 session/load 回放会应用上下文压缩点（apply_compaction）——
 * 压缩前的助手内容（思考/工具/回复正文）不进回放，老会话只剩一排气泡。
 * wire.jsonl 是**只追加**的全量日志：压缩只是记了一个事件，内容都还在。
 * 自己解析它，压缩前的轮次也能完整重建。
 *
 * 产出与 kimi 回放同形的 HistoryMessage 数组（assistant 的 content 块形态
 * = Anthropic 的 thinking/text/tool_use，tool_result 放在紧随的 user 消息
 * 里），下游 historyToItems / 轮级折叠 / #45 图片水合全部原样复用。
 *
 * 已知取舍（与 kimi 回放对齐或更好）：
 * - 子代理内部轮次在主 wire 里只有 Task 调用与结论（内部细节在 tasks/<id>/
 *   各自的 wire 里，暂不合入）；思考正文在旧版 kimi 不落盘（空串）的块丢弃。
 * - 压缩点不产分隔卡（history 通道没有压缩消息的位置，内容完整优先）。
 */

interface WirePartEvent {
  uuid?: unknown
  stepUuid?: unknown
  part?: { type?: unknown; text?: unknown; think?: unknown }
}

interface WireToolCallEvent {
  uuid?: unknown
  toolCallId?: unknown
  name?: unknown
  args?: unknown
}

interface WireToolResultEvent {
  toolCallId?: unknown
  result?: { output?: unknown; error?: unknown; is_error?: unknown }
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * 解析 wire.jsonl → HistoryMessage 数组；文件不存在/不可读/一条有效消息都
 * 没有时返回 null（调用方回退 kimi 回放）。
 */
export function parseWireHistory(wirePath: string): Array<Record<string, unknown>> | null {
  let raw: string
  try {
    raw = readFileSync(wirePath, 'utf8')
  } catch (error) {
    log('kimi', `wire history: read failed ${wirePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  const messages: Array<Record<string, unknown>> = []
  /** 当前步（一次模型响应）的内容块：part.uuid → 下标（content.part 是全量
   *  快照，同 uuid 重复到达取最新）。 */
  let stepUuid: string | null = null
  let stepBlocks: Array<Record<string, unknown>> = []
  const partIndex = new Map<string, number>()
  /** 已到达、还没排进消息的 tool_result（紧跟下一步/边界时flush成一条 user 消息）。 */
  let pendingResults: Array<Record<string, unknown>> = []
  let lineNo = 0

  const flushResults = (): void => {
    if (!pendingResults.length) return
    messages.push({
      type: 'user',
      uuid: `w${lineNo}-results`,
      message: { content: pendingResults }
    })
    pendingResults = []
  }

  const flushStep = (): void => {
    // 空块（旧版 kimi 不落盘的空 think / 空 text）在收尾时滤掉。
    const blocks = stepBlocks.filter((b) => {
      if (b.type === 'thinking') return typeof b.thinking === 'string' && b.thinking.length > 0
      if (b.type === 'text') return typeof b.text === 'string' && b.text.length > 0
      return true
    })
    if (stepUuid && blocks.length) {
      messages.push({ type: 'assistant', uuid: stepUuid, message: { content: blocks } })
    }
    stepUuid = null
    stepBlocks = []
    partIndex.clear()
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    lineNo += 1
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue // 尾部半行/坏行
    }
    const type = entry.type

    // 用户/上下文消息（role 实测全是 user；turn.prompt/turn.steer 是它的
    // 触发侧回声，跳过防重复）。
    if (type === 'context.append_message') {
      flushStep()
      flushResults()
      const msg = entry.message as { role?: unknown; content?: unknown } | undefined
      if (msg && msg.role === 'user' && msg.content) {
        messages.push({ type: 'user', uuid: `w${lineNo}`, message: { content: msg.content } })
      }
      continue
    }

    if (type === 'context.append_loop_event') {
      const event = entry.event as Record<string, unknown> | undefined
      if (!event) continue
      const eventType = event.type

      if (eventType === 'step.begin') {
        flushStep()
        flushResults()
        stepUuid = asString(event.uuid) ?? `w${lineNo}-step`
        continue
      }
      if (eventType === 'step.end') {
        flushStep()
        continue
      }
      if (eventType === 'content.part') {
        const e = event as unknown as WirePartEvent
        const part = e.part
        const partType = asString(part?.type)
        if (!stepUuid || !part || (partType !== 'text' && partType !== 'think')) continue
        const block =
          partType === 'think'
            ? { type: 'thinking', thinking: typeof part.think === 'string' ? part.think : '' }
            : { type: 'text', text: typeof part.text === 'string' ? part.text : '' }
        const uuid = asString(e.uuid)
        if (uuid && partIndex.has(uuid)) {
          stepBlocks[partIndex.get(uuid)!] = block
        } else {
          if (uuid) partIndex.set(uuid, stepBlocks.length)
          stepBlocks.push(block)
        }
        continue
      }
      if (eventType === 'tool.call') {
        if (!stepUuid) continue
        const e = event as unknown as WireToolCallEvent
        const id = asString(e.toolCallId) ?? asString(e.uuid)
        if (!id) continue
        stepBlocks.push({ type: 'tool_use', id, name: asString(e.name) ?? 'tool', input: e.args })
        continue
      }
      if (eventType === 'tool.result') {
        const e = event as unknown as WireToolResultEvent
        const id = asString(e.toolCallId)
        if (!id) continue
        const result = e.result
        const output =
          typeof result?.output === 'string' ? result.output : result ? JSON.stringify(result) : ''
        pendingResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: output,
          is_error: Boolean(result?.error ?? result?.is_error)
        })
        continue
      }
      // step 内其余事件（usage 等）不关心。
      continue
    }

    // context.apply_compaction / turn.prompt / turn.steer / config / usage 等：
    // 与展示历史无关（压缩点内容本就在 wire 里，不需要标记）。
  }
  flushStep()
  flushResults()

  if (!messages.length) return null
  return messages
}
