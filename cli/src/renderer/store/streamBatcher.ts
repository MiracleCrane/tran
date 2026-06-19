import type { AgentEvent } from '../../shared/ipc'
import { useSessionStore, type StreamDeltaBatch } from './sessionStore'

/**
 * Coalesces streaming `content_block_delta` events into ≤1 store update per
 * animation frame.
 *
 * Without this, every token crosses IPC and runs a full `items` rebuild +
 * React commit (and, before the render-path optimizations, a markdown +
 * highlight.js re-parse of every message). Tokens arrive far faster than the
 * display refreshes, so batching them to one rAF flush caps re-renders at
 * ~60fps with zero text loss.
 *
 * Ordering is preserved: any NON-delta event (block start/stop, message_start,
 * the final `assistant`/`result`, tool progress, system, agent:ended) flushes
 * the pending deltas FIRST, then applies immediately — structural events are
 * never delayed and always see the post-flush state.
 */
let pending: StreamDeltaBatch[] = []
let rafId: number | null = null

function isContentBlockDelta(e: AgentEvent): boolean {
  if (e.type !== 'agent:message') return false // agent:ended is not a delta
  const msg = e.message as { type?: string; event?: { type?: string } }
  return msg.type === 'stream_event' && msg.event?.type === 'content_block_delta'
}

function flush(): void {
  rafId = null
  if (pending.length === 0) return
  const batch = pending
  pending = []
  useSessionStore.getState().applyStreamBatch(batch)
}

/** Entry point wired to window.api.onAgentEvent in App.tsx. */
export function pushAgentEvent(e: AgentEvent): void {
  if (isContentBlockDelta(e)) {
    // isContentBlockDelta already confirmed this is an agent:message whose
    // event is a content_block_delta; narrow to the message variant to read it.
    const msg = (e as Extract<AgentEvent, { type: 'agent:message' }>).message as unknown as {
      uuid: string
      parent_tool_use_id: string | null
      event: Record<string, unknown>
    }
    pending.push({
      sessionId: e.sessionId,
      fallbackId: msg.uuid,
      parent: msg.parent_tool_use_id ?? null,
      event: msg.event
    })
    if (rafId === null) {
      rafId = requestAnimationFrame(flush)
    }
    return
  }
  // Structural / non-delta event: flush any buffered deltas first (in order),
  // then apply the event immediately so it sees the up-to-date state.
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    flush()
  }
  useSessionStore.getState().ingestAgentEvent(e)
}

/** Flush buffered deltas synchronously — call on tab hide / teardown so no text
 *  is lost if rAF is ever paused (e.g. an occluded window). */
export function flushAgentEvents(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    flush()
  }
}
