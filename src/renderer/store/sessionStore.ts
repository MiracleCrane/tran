import { create } from 'zustand'
import type {
  AgentEvent,
  StartSessionOptions,
  PermissionResponsePayload,
  SessionListItem,
  HistoryMessage
} from '../../shared/ipc'
import type {
  TranscriptItem,
  AssistantBlock,
  ToolBlock,
  SessionMeta,
  SessionStatus,
  PermissionRequestPayload,
  StartArgs
} from '../types'

interface SessionStore {
  starting: boolean
  /** True once the startup check (auto-enter last project) has finished. The App
   *  waits on this before showing Onboarding vs the main UI, to avoid a flash. */
  bootstrapped: boolean
  meta: SessionMeta | null
  items: TranscriptItem[]
  status: SessionStatus
  pendingPermissions: PermissionRequestPayload[]
  /** The Anthropic message id currently streaming (shared by every token event
   *  for that one message). One item per message, not one per token. */
  currentStreamingMsgId: string | null
  /** Past sessions for the sidebar (same cwd). */
  sessions: SessionListItem[]
  sessionsLoading: boolean

  startSession: (args: StartArgs) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  interrupt: () => Promise<void>
  setModel: (model: string) => Promise<void>
  reset: () => void

  /** On app start: auto-enter the last-used project if any, else leave meta null
   *  so Onboarding shows. Sets bootstrapped regardless. */
  bootstrap: () => Promise<void>
  /** Switch the active working directory (project): close the current session and
   *  start a fresh one in the new cwd (history is per-cwd in the sidebar). */
  switchProject: (path: string) => Promise<void>

  /** Sidebar actions */
  refreshSessions: () => Promise<void>
  newChat: () => Promise<void>
  openSession: (sdkSessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  /** Close the current session and re-spawn it (resuming when possible) so that
   *  config-file changes — e.g. MCP servers — get reloaded. History is restored
   *  from the transcript JSONL, so the conversation is preserved. */
  restartSession: () => Promise<void>
  /** Switch the active API provider: writes Claude's settings.json + restarts
   *  the session (resume) so the new provider's env/model take effect. */
  switchProvider: (id: string) => Promise<void>

  ingestAgentEvent: (e: AgentEvent) => void
  addPermissionRequest: (r: PermissionRequestPayload) => void
  respondPermission: (
    toolUseID: string,
    behavior: 'allow' | 'deny',
    message?: string
  ) => Promise<void>
}

const emptyStatus: SessionStatus = { running: false }

function uid(): string {
  return crypto.randomUUID()
}

/** Immutably update the ToolBlock whose toolUseId matches, wherever it lives. */
function mapTool(
  items: TranscriptItem[],
  toolUseId: string,
  fn: (b: ToolBlock) => ToolBlock
): TranscriptItem[] {
  return items.map((item) => {
    if (!item || item.kind !== 'assistant') return item
    let changed = false
    const blocks = item.blocks.map((b) => {
      // `b` may be undefined when streamed indices left holes in the blocks
      // array (interleaved subagent events) — skip those safely.
      if (b && b.kind === 'tool' && b.toolUseId === toolUseId) {
        changed = true
        return fn(b)
      }
      return b
    })
    return changed ? { ...item, blocks } : item
  })
}

/**
 * Fold a streaming delta into the assistant item for the message currently
 * streaming. The key is the Anthropic message id (from `message_start`), which
 * is shared by every token event in that one message and also matches the final
 * `assistant` message — so we build exactly ONE item per message, not one per
 * token.
 */
function applyStreamEvent(
  state: { items: TranscriptItem[]; currentStreamingMsgId: string | null },
  fallbackId: string,
  parent: string | null,
  event: Record<string, unknown>
): { items: TranscriptItem[]; currentStreamingMsgId: string | null } {
  const type = event.type as string
  let items = state.items
  let msgId = state.currentStreamingMsgId

  if (type === 'message_start') {
    const messageField = event.message as { id?: string } | undefined
    msgId = messageField?.id ?? fallbackId
    if (!items.some((i) => i.id === msgId)) {
      items = [
        ...items,
        { id: msgId, kind: 'assistant', blocks: [], parentToolUseId: parent, streaming: true }
      ]
    }
    return { items, currentStreamingMsgId: msgId }
  }

  // content_block_* events have no message id — reuse the one message_start set.
  if (!msgId) msgId = fallbackId
  if (!items.some((i) => i.id === msgId)) {
    items = [
      ...items,
      { id: msgId, kind: 'assistant', blocks: [], parentToolUseId: parent, streaming: true }
    ]
  }
  const index = event.index as number

  if (type === 'content_block_start') {
    const cb = event.content_block as {
      type: string
      id?: string
      name?: string
      text?: string
      thinking?: string
    }
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      if (cb.type === 'text') blocks[index] = { kind: 'text', text: cb.text ?? '' }
      else if (cb.type === 'thinking') blocks[index] = { kind: 'thinking', text: cb.thinking ?? '' }
      else if (cb.type === 'tool_use')
        blocks[index] = {
          kind: 'tool',
          toolUseId: cb.id ?? '',
          name: cb.name ?? 'tool',
          input: {},
          status: 'pending',
          inputRaw: ''
        }
      return { ...item, blocks }
    })
  } else if (type === 'content_block_delta') {
    const delta = event.delta as {
      type: string
      text?: string
      thinking?: string
      partial_json?: string
    }
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      const b = blocks[index]
      if (!b) return item
      if (delta.type === 'text_delta' && b.kind === 'text')
        blocks[index] = { ...b, text: b.text + (delta.text ?? '') }
      else if (delta.type === 'thinking_delta' && b.kind === 'thinking')
        blocks[index] = { ...b, text: b.text + (delta.thinking ?? '') }
      else if (delta.type === 'input_json_delta' && b.kind === 'tool')
        blocks[index] = { ...b, inputRaw: (b.inputRaw ?? '') + (delta.partial_json ?? '') }
      return { ...item, blocks }
    })
  } else if (type === 'content_block_stop') {
    items = items.map((item) => {
      if (item.id !== msgId || item.kind !== 'assistant') return item
      const blocks = [...item.blocks]
      const b = blocks[index]
      if (b && b.kind === 'tool' && b.inputRaw) {
        try {
          blocks[index] = { ...b, input: JSON.parse(b.inputRaw) }
        } catch {
          /* keep accumulated raw JSON */
        }
      }
      return { ...item, blocks }
    })
  }

  return { items, currentStreamingMsgId: msgId }
}

/** Convert a past session's transcript messages into renderable items, pairing
 *  each tool_use with its tool_result by id. */
function historyToItems(messages: HistoryMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = []
  for (const m of messages) {
    if (m.type === 'assistant') {
      const beta = m.message as { content?: Array<Record<string, unknown>> }
      const blocks: AssistantBlock[] = []
      for (const c of beta.content ?? []) {
        if (c.type === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
        else if (c.type === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
        else if (c.type === 'tool_use')
          blocks.push({
            kind: 'tool',
            toolUseId: String(c.id ?? ''),
            name: String(c.name ?? 'tool'),
            input: c.input,
            status: 'pending'
          })
      }
      items.push({ id: m.uuid, kind: 'assistant', blocks, parentToolUseId: m.parent_tool_use_id })
    } else {
      const mp = m.message as { content?: unknown }
      const content = mp.content
      if (typeof content === 'string') {
        items.push({ id: m.uuid, kind: 'user', text: content, parentToolUseId: m.parent_tool_use_id })
      } else if (Array.isArray(content)) {
        const toolResults = content.filter(
          (c) => !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
        )
        if (toolResults.length) {
          for (const tr of toolResults) {
            const tid = (tr as { tool_use_id?: string }).tool_use_id
            for (const it of items) {
              if (it.kind !== 'assistant') continue
              for (const b of it.blocks) {
                if (b.kind === 'tool' && b.toolUseId === tid && b.status === 'pending') {
                  b.status = (tr as { is_error?: boolean }).is_error ? 'error' : 'done'
                  b.result = (tr as { content?: unknown }).content
                  b.resultIsError = !!(tr as { is_error?: boolean }).is_error
                }
              }
            }
          }
        } else {
          const text = content
            .map((c) =>
              c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''
            )
            .join('')
          if (text)
            items.push({ id: m.uuid, kind: 'user', text, parentToolUseId: m.parent_tool_use_id })
        }
      }
    }
  }
  return items
}

/** If the SDK never sends system/init (e.g. the API backend hangs), unblock the
 *  UI after a timeout so the user can retry via New chat. */
function scheduleInitWatchdog(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void
): void {
  setTimeout(() => {
    if (get().starting) {
      set((s) => ({
        starting: false,
        status: {
          ...s.status,
          error: '会话初始化超时 — 后端可能响应较慢或不可用。请尝试新建对话。'
        }
      }))
    }
  }, 60000)
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  starting: false,
  bootstrapped: false,
  meta: null,
  items: [],
  status: emptyStatus,
  pendingPermissions: [],
  currentStreamingMsgId: null,
  sessions: [],
  sessionsLoading: false,

  async startSession(args) {
    // Pre-register synchronously: bridgeSessionId is added to the bridge's map
    // before claude.exe finishes spawning, so the UI never locks on init.
    const newId = uid()
    const permissionMode =
      (await window.api.getPreferences().catch(() => null))?.defaultPermissionMode ?? 'default'
    const opts: StartSessionOptions = {
      cwd: args.cwd,
      ...(args.apiKey ? { apiKey: args.apiKey } : {}),
      ...(args.model ? { model: args.model } : {}),
      permissionMode,
      bridgeSessionId: newId
    }
    await window.api.startSession(opts)
    set({
      meta: {
        sessionId: newId,
        cwd: args.cwd,
        model: args.model ?? 'claude-opus-4-8',
        permissionMode,
        tools: []
      },
      items: [],
      status: { running: false },
      currentStreamingMsgId: null
    })
    void get().refreshSessions()
    scheduleInitWatchdog(get, set)
  },

  async sendMessage(text) {
    const meta = get().meta
    if (!meta) return
    set({
      items: [
        ...get().items,
        { id: uid(), kind: 'user', text, parentToolUseId: null }
      ],
      status: { ...get().status, running: true }
    })
    await window.api.sendMessage(meta.sessionId, text)
  },

  async interrupt() {
    const meta = get().meta
    if (!meta) return
    await window.api.interrupt(meta.sessionId)
  },

  async setModel(model) {
    const meta = get().meta
    if (!meta) return
    await window.api.setModel(meta.sessionId, model)
    set({ meta: { ...meta, model } })
  },

  reset() {
    set({ starting: false, meta: null, items: [], status: emptyStatus, pendingPermissions: [], currentStreamingMsgId: null })
  },

  async bootstrap() {
    try {
      const proj = await window.api.getStartupProject()
      if (proj) {
        const provider = await window.api.getActiveProvider()
        await get().startSession({ cwd: proj.path, model: provider?.model })
      }
    } finally {
      set({ bootstrapped: true })
    }
  },

  async switchProject(path: string) {
    if (get().starting) return
    const oldMeta = get().meta
    await window.api.setLastProject(path)
    const provider = await window.api.getActiveProvider()
    const model = provider?.model ?? 'claude-opus-4-8'
    const newId = uid()
    // Switch the UI to the new project instantly; close the old session and
    // spawn a fresh one in the new cwd.
    set({
      starting: true,
      items: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: { sessionId: newId, cwd: path, model, permissionMode: 'default', tools: [] }
    })
    if (oldMeta?.sessionId) await window.api.closeSession(oldMeta.sessionId).catch(() => {})
    await window.api.startSession({ cwd: path, model, bridgeSessionId: newId })
    set({ starting: false })
    void get().refreshSessions()
    scheduleInitWatchdog(get, set)
  },

  async refreshSessions() {
    const meta = get().meta
    if (!meta) return
    set({ sessionsLoading: true })
    try {
      const sessions = await window.api.listSessions(meta.cwd)
      set({ sessions })
    } finally {
      set({ sessionsLoading: false })
    }
  },

  async newChat() {
    const meta = get().meta
    if (!meta || get().starting) return
    const { cwd, model, permissionMode } = meta
    const oldSessionId = meta.sessionId
    const newId = uid()
    // Switch the UI to a fresh session instantly (unlocked). claude.exe spawns
    // in the background; any messages sent now queue and flush once ready.
    set({
      starting: true,
      items: [],
      status: { running: false },
      currentStreamingMsgId: null,
      meta: { sessionId: newId, cwd, model, permissionMode, tools: [] }
    })
    await window.api.closeSession(oldSessionId).catch(() => {})
    await window.api.startSession({ cwd, model, bridgeSessionId: newId })
    set({ starting: false })
    void get().refreshSessions()
    scheduleInitWatchdog(get, set)
  },

  async openSession(sdkSessionId: string) {
    const meta = get().meta
    if (!meta || get().starting) return
    if (meta.sdkSessionId === sdkSessionId) return
    const { cwd, model, permissionMode } = meta
    const oldSessionId = meta.sessionId
    const newId = uid()
    set({ starting: true, status: { running: false }, currentStreamingMsgId: null })
    let history: HistoryMessage[] = []
    try {
      history = await window.api.getSessionMessages(sdkSessionId, cwd)
    } catch {
      history = []
    }
    // Switch UI instantly to the resumed session (history rendered, unlocked).
    set({
      items: historyToItems(history),
      meta: {
        sessionId: newId,
        sdkSessionId,
        cwd,
        model,
        permissionMode,
        tools: []
      }
    })
    await window.api.closeSession(oldSessionId).catch(() => {})
    await window.api.startSession({ cwd, model, resume: sdkSessionId, bridgeSessionId: newId })
    set({ starting: false })
    scheduleInitWatchdog(get, set)
  },

  /** Close the current session and re-spawn it (resuming when possible) so that
   *  config-file changes — e.g. MCP servers — get reloaded. History is restored
   *  from the transcript JSONL, so the conversation is preserved. */
  async renameSession(sessionId: string, title: string) {
    const meta = get().meta
    if (!meta) return
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      await window.api.renameSession(sessionId, trimmed, meta.cwd)
    } catch {
      /* ignore — the list will still show the old summary */
    }
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.sessionId === sessionId ? { ...x, summary: trimmed } : x
      )
    }))
  },

  async deleteSession(sessionId: string) {
    const meta = get().meta
    if (!meta) return
    try {
      await window.api.deleteSession(sessionId, meta.cwd)
    } catch {
      /* ignore */
    }
    set((s) => ({ sessions: s.sessions.filter((x) => x.sessionId !== sessionId) }))
    // Deleted the active conversation → start fresh.
    if (meta.sdkSessionId === sessionId) {
      await get().newChat()
    }
  },

  async restartSession() {
    const meta = get().meta
    if (!meta || get().starting) return
    const { cwd, model, permissionMode, sdkSessionId } = meta
    const oldSessionId = meta.sessionId
    const newId = uid()
    set({ starting: true, status: { running: false }, currentStreamingMsgId: null })
    // Rebuild the transcript from history so the resumed session shows the same
    // conversation. If we never got an sdkSessionId (init hadn't landed), fall
    // back to a fresh session.
    let items: TranscriptItem[] = []
    if (sdkSessionId) {
      try {
        const history = await window.api.getSessionMessages(sdkSessionId, cwd)
        items = historyToItems(history)
      } catch {
        items = get().items
      }
    }
    set({
      items,
      currentStreamingMsgId: null,
      meta: { sessionId: newId, sdkSessionId, cwd, model, permissionMode, tools: [] }
    })
    await window.api.closeSession(oldSessionId).catch(() => {})
    await window.api.startSession(
      sdkSessionId
        ? { cwd, model, resume: sdkSessionId, bridgeSessionId: newId }
        : { cwd, model, bridgeSessionId: newId }
    )
    set({ starting: false })
    scheduleInitWatchdog(get, set)
  },

  async switchProvider(id) {
    if (get().starting) return
    await window.api.setActiveProvider(id)
    // Keep meta.model in sync with the newly-active provider so the resumed
    // session spawns with that model (the bridge trusts opts.model).
    const provider = await window.api.getActiveProvider()
    const meta = get().meta
    if (meta && provider) set({ meta: { ...meta, model: provider.model } })
    await get().restartSession()
  },

  ingestAgentEvent(e) {
    if (e.type === 'agent:ended') {
      set((s) => ({
        status: { ...s.status, running: false, error: e.error ?? s.status.error }
      }))
      return
    }
    const msg = e.message as Record<string, unknown> & { type: string }
    switch (msg.type) {
      case 'system': {
        const subtype = msg.subtype as string
        if (subtype === 'init') {
          const m = msg as unknown as {
            session_id: string
            cwd: string
            model: string
            permissionMode: string
            tools: string[]
          }
          set((s) => ({
            starting: false,
            meta: {
              // CRITICAL: keep the bridge handle id for IPC — never adopt the SDK's
              // internal session_id here, or subsequent sendMessage calls target a
              // session the bridge doesn't know about.
              sessionId: s.meta?.sessionId ?? m.session_id,
              sdkSessionId: m.session_id,
              cwd: m.cwd,
              model: m.model,
              permissionMode: m.permissionMode,
              tools: m.tools
            },
            status: { ...s.status }
          }))
        } else if (subtype === 'status') {
          const status = (msg as unknown as { status: string | null }).status
          set((s) => ({ status: { ...s.status, compacting: status === 'compacting' } }))
        } else if (subtype === 'permission_denied') {
          const d = msg as unknown as { tool_use_id: string; message: string }
          set((s) => ({
            items: mapTool(s.items, d.tool_use_id, (b) => ({
              ...b,
              status: 'denied',
              errorMessage: d.message
            }))
          }))
        }
        break
      }
      case 'user': {
        const parent = (msg.parent_tool_use_id as string | null) ?? null
        const content = (msg as unknown as { message: { content: unknown } }).message.content
        if (typeof content === 'string') {
          // De-dupe: sendMessage already renders the user's text optimistically, so
          // if the SDK echoes our own message back, don't add it a second time.
          set((s) => {
            const last = s.items[s.items.length - 1]
            if (last && last.kind === 'user' && last.text === content) {
              return { status: { ...s.status, running: true } }
            }
            return {
              items: [
                ...s.items,
                { id: uid(), kind: 'user', text: content, parentToolUseId: parent }
              ],
              status: { ...s.status, running: true }
            }
          })
        } else if (Array.isArray(content)) {
          const toolResults = content.filter(
            (c): c is { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean } =>
              !!c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result'
          )
          if (toolResults.length) {
            set((s) => {
              let items = s.items
              for (const tr of toolResults) {
                items = mapTool(items, tr.tool_use_id, (b) => ({
                  ...b,
                  status: tr.is_error ? 'error' : 'done',
                  result: tr.content,
                  resultIsError: !!tr.is_error
                }))
              }
              return { items }
            })
          } else {
            const text = content
              .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
              .join('')
            if (text) {
              set((s) => ({
                items: [
                  ...s.items,
                  { id: uid(), kind: 'user', text, parentToolUseId: parent }
                ]
              }))
            }
          }
        }
        break
      }
      case 'stream_event': {
        const su = msg as unknown as { uuid: string; parent_tool_use_id: string | null; event: Record<string, unknown> }
        const parent = su.parent_tool_use_id ?? null
        set((s) =>
          applyStreamEvent(
            { items: s.items, currentStreamingMsgId: s.currentStreamingMsgId },
            su.uuid,
            parent,
            su.event
          )
        )
        break
      }
      case 'assistant': {
        const parent = (msg.parent_tool_use_id as string | null) ?? null
        const m = msg as unknown as {
          uuid: string
          error?: string
          message: { id?: string; content: Array<Record<string, unknown>> }
        }
        const blocks: AssistantBlock[] = []
        for (const c of m.message?.content ?? []) {
          const t = c.type
          if (t === 'text') blocks.push({ kind: 'text', text: String(c.text ?? '') })
          else if (t === 'thinking') blocks.push({ kind: 'thinking', text: String(c.thinking ?? '') })
          else if (t === 'tool_use') {
            blocks.push({
              kind: 'tool',
              toolUseId: String(c.id ?? ''),
              name: String(c.name ?? 'tool'),
              input: c.input,
              status: 'pending'
            })
          }
        }
        // Replace the in-flight streaming item with the authoritative final
        // message. Prefer currentStreamingMsgId (robust even when the streaming
        // item was keyed by a fallback id), then fall back to message.id, else add.
        set((s) => {
          let targetId: string | null = null
          if (s.currentStreamingMsgId && s.items.some((i) => i.id === s.currentStreamingMsgId)) {
            targetId = s.currentStreamingMsgId
          } else if (m.message?.id && s.items.some((i) => i.id === m.message.id)) {
            targetId = m.message.id
          }
          const finalId = targetId ?? (m.uuid ?? uid())
          const items =
            targetId !== null
              ? s.items.map((i) =>
                  i.id === finalId
                    ? {
                        id: finalId,
                        kind: 'assistant' as const,
                        blocks,
                        parentToolUseId: parent,
                        error: m.error
                      }
                    : i
                )
              : [
                  ...s.items,
                  {
                    id: finalId,
                    kind: 'assistant' as const,
                    blocks,
                    parentToolUseId: parent,
                    error: m.error
                  }
                ]
          return { items, status: { ...s.status, running: true }, currentStreamingMsgId: null }
        })
        break
      }
      case 'tool_progress': {
        const p = msg as unknown as { tool_use_id: string; elapsed_time_seconds: number }
        set((s) => ({
          items: mapTool(s.items, p.tool_use_id, (b) => ({
            ...b,
            status: 'running',
            elapsed: p.elapsed_time_seconds
          }))
        }))
        break
      }
      case 'result': {
        const r = msg as unknown as {
          total_cost_usd: number
          num_turns: number
          usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null }
          stop_reason: string | null
          subtype: string
          errors?: string[]
        }
        set((s) => ({
          status: {
            ...s.status,
            running: false,
            costUsd: r.total_cost_usd,
            turns: r.num_turns,
            inputTokens: r.usage?.input_tokens,
            outputTokens: r.usage?.output_tokens,
            cacheReadTokens: r.usage?.cache_read_input_tokens ?? undefined,
            stopReason: r.stop_reason ?? undefined,
            error:
              r.subtype === 'success'
                ? s.status.error
                : r.errors?.length
                  ? r.errors.join('; ')
                  : r.subtype
          },
          // Turn done: clear the streaming flag on any provisional items that
          // never got replaced by a final assistant message, and reset the id.
          items: s.items.map((i) =>
            i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i
          ),
          currentStreamingMsgId: null
        }))
        break
      }
      default:
        // hook_*, task_* etc. are intentionally ignored in the MVP.
        break
    }
  },

  addPermissionRequest(r) {
    set((s) => ({ pendingPermissions: [...s.pendingPermissions, r] }))
  },

  async respondPermission(toolUseID, behavior, message) {
    const resp: PermissionResponsePayload = { toolUseID, behavior, ...(message ? { message } : {}) }
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter((p) => p.toolUseID !== toolUseID)
    }))
    await window.api.respondPermission(resp)
  }
}))
