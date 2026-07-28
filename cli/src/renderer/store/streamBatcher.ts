import type { AgentEvent } from '../../shared/ipc'
import { useSessionStore, type StreamDeltaBatch } from './sessionStore'

/**
 * Coalesces streaming `content_block_delta` events into ≤1 store update per
 * animation frame, and paces the release so text emerges at an even cadence.
 *
 * Without batching, every token crosses IPC and runs a full `items` rebuild +
 * React commit (and, before the render-path optimizations, a markdown +
 * highlight.js re-parse of every message). Tokens arrive far faster than the
 * display refreshes, so batching them to one rAF flush caps re-renders at
 * ~60fps with zero text loss.
 *
 * Pacing (#8): deltas arrive in irregular bursts (IPC chunking, tool
 * round-trips), so draining the whole buffer every frame makes the text jump
 * in uneven slabs — 吐字僵硬. Instead the release is paced by TIME at a fixed
 * base rate (chars/second, independent of the display refresh rate), giving a
 * constant-speed typewriter feel: within the normal backlog range
 * (< HIGH_WATER_CHARS) the release rate never varies — the backlog only acts
 * as a buffer, it does not change the cadence. Only when the backlog crosses
 * the high watermark does the rate speed up, and the speed-up is GRADUAL
 * (linear in the excess, capped), so bursts are absorbed smoothly instead of
 * dumped in slabs. A delta larger than the remaining budget is split across
 * frames; folding deltas is pure string append per block (see
 * applyStreamEvent), so splitting is order-safe.
 *
 * Ordering is preserved: any NON-delta event (block start/stop, message_start,
 * the final `assistant`/`result`, tool progress, system, agent:ended) flushes
 * the pending deltas FIRST (in full), then applies immediately — structural
 * events are never delayed and always see the post-flush state.
 */
let pending: StreamDeltaBatch[] = []
let rafId: number | null = null

/** Constant base rate (~4.7 chars/frame at 60fps). Time-based, so the cadence
 *  is identical on 120Hz+ displays — a per-frame budget would double there. */
const BASE_CHARS_PER_SEC = 280
/** Below this backlog the rate stays at the base rate — the backlog only
 *  buffers, it never changes the cadence. */
const HIGH_WATER_CHARS = 800
/** Smooth ramp: every char of backlog above the high watermark adds this many
 *  chars/sec, so catch-up accelerates gradually (linear), not in slabs. */
const RAMP_CHARS_PER_SEC = 2
/** Hard ceiling on the catch-up rate: even a huge backlog (e.g. a long paste)
 *  drains fast but never dumps in one slab. */
const MAX_CHARS_PER_SEC = 1800

/** Text-bearing fields of a content_block_delta, in priority order. */
const DELTA_TEXT_KEYS = ['text', 'thinking', 'partial_json'] as const

function isContentBlockDelta(e: AgentEvent): boolean {
  if (e.type !== 'agent:message') return false // agent:ended is not a delta
  const msg = e.message as { type?: string; event?: { type?: string } }
  return msg.type === 'stream_event' && msg.event?.type === 'content_block_delta'
}

/** Locate the text payload of a delta event (text_delta / thinking_delta /
 *  input_json_delta). Returns null for unknown shapes — those pass through
 *  unsplit and don't count toward the budget. */
function deltaTextOf(event: Record<string, unknown>): { key: string; value: string } | null {
  const delta = event.delta as Record<string, unknown> | undefined
  if (!delta) return null
  for (const key of DELTA_TEXT_KEYS) {
    const value = delta[key]
    if (typeof value === 'string' && value.length > 0) return { key, value }
  }
  return null
}

/** Copy of `event` with its delta text replaced by `text`. */
function withDeltaText(event: Record<string, unknown>, key: string, text: string): Record<string, unknown> {
  return { ...event, delta: { ...(event.delta as Record<string, unknown>), [key]: text } }
}

function drainAll(): StreamDeltaBatch[] {
  const batch = pending
  pending = []
  return batch
}

/** Release up to `budget` characters from the front of the queue, splitting
 *  the head delta when it straddles the budget. */
function drainBudget(budget: number): StreamDeltaBatch[] {
  const batch: StreamDeltaBatch[] = []
  while (pending.length > 0 && budget > 0) {
    const head = pending[0]
    const text = deltaTextOf(head.event)
    if (!text || text.value.length <= budget) {
      batch.push(head)
      pending.shift()
      budget -= text?.value.length ?? 0
      continue
    }
    // Split: emit the head portion now, leave the remainder queued for the
    // next frame (same block index/message, so order is preserved).
    batch.push({ ...head, event: withDeltaText(head.event, text.key, text.value.slice(0, budget)) })
    pending[0] = { ...head, event: withDeltaText(head.event, text.key, text.value.slice(budget)) }
    break
  }
  return batch
}

function pendingChars(): number {
  let total = 0
  for (const b of pending) total += deltaTextOf(b.event)?.value.length ?? 0
  return total
}

/** rAF flush: paced release (see header comment). Re-arms itself while a
 *  backlog remains. The budget accrues by elapsed time (`carry` holds the
 *  sub-char remainder), so the cadence is a constant chars/second on any
 *  display refresh rate. */
let lastFlushAt = 0
let carry = 0

function flushFrame(): void {
  rafId = null
  if (pending.length === 0) {
    lastFlushAt = 0
    carry = 0
    return
  }
  const now = performance.now()
  // Clamp dt so a stalled rAF (occluded/throttled tab) doesn't dump a huge
  // accumulated budget on resume.
  const dt = lastFlushAt > 0 ? Math.min((now - lastFlushAt) / 1000, 0.1) : 1 / 60
  lastFlushAt = now
  const backlog = pendingChars()
  const excess = Math.max(0, backlog - HIGH_WATER_CHARS)
  const rate = Math.min(MAX_CHARS_PER_SEC, BASE_CHARS_PER_SEC + excess * RAMP_CHARS_PER_SEC)
  carry += rate * dt
  const budget = Math.floor(carry)
  carry -= budget
  useSessionStore.getState().applyStreamBatch(drainBudget(budget))
  if (pending.length > 0) rafId = requestAnimationFrame(flushFrame)
}

/** Full drain used before structural events and on teardown: ordering and
 *  completeness beat pacing there. */
function flushAll(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (pending.length === 0) return
  lastFlushAt = 0
  carry = 0
  useSessionStore.getState().applyStreamBatch(drainAll())
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
      rafId = requestAnimationFrame(flushFrame)
    }
    return
  }
  // Structural / non-delta event: flush any buffered deltas first (in order),
  // then apply the event immediately so it sees the up-to-date state.
  flushAll()
  useSessionStore.getState().ingestAgentEvent(e)
}

/** Flush buffered deltas synchronously — call on tab hide / teardown so no text
 *  is lost if rAF is ever paused (e.g. an occluded window). */
export function flushAgentEvents(): void {
  flushAll()
}
