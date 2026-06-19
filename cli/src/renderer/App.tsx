import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from './store/sessionStore'
import { useUiStore, type View } from './store/uiStore'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import Transcript from './components/Transcript'
import Composer from './components/Composer'
import StatusBar from './components/StatusBar'
import RuntimeStatusStrip from './components/RuntimeStatusStrip'
import ErrorDiagnosticPanel from './components/ErrorDiagnosticPanel'
import GitToolbar, { requestCloseGitDrawer } from './components/GitToolbar'
import AttachmentPreviewPane from './components/AttachmentPreviewPane'
import PermissionModal from './components/PermissionModal'
import McpPanel from './components/McpPanel'
import ProvidersPanel from './components/ProvidersPanel'
import SkillsPanel from './components/SkillsPanel'
import SettingsPanel from './components/SettingsPanel'
import TranslatePanel from './components/TranslatePanel'
import HelpPanel from './components/HelpPanel'
import WslHealthPanel from './components/WslHealthPanel'
import ErrorBoundary from './components/ErrorBoundary'
import ClosePromptDialog from './components/ClosePromptDialog'
import UpdateAvailableDialog from './components/UpdateAvailableDialog'
import { useApplyAppearanceSettings } from './store/appearanceStore'
import { pushAgentEvent, flushAgentEvents } from './store/streamBatcher'
import type { Provider, UpdateCheckResult } from '../shared/ipc'
import { emitForgeEvent, onForgeEvent } from './events'

const VIEW_SWAP_DELAY_MS = 90
const CHAT_SWAP_CLEAR_MS = 220
const SCROLLBAR_IDLE_MS = 1800
const PREVIEW_CLOSE_MS = 720
const CHAT_TOPBAR_COLLAPSED_KEY = 'forge.chatTopbarCollapsed.v1'
const CHAT_TOPBAR_LAYOUT_MOTION_MS = 520

function providerRuntimeKey(provider: Provider | null): string {
  if (!provider) return ''
  return [
    provider.id,
    provider.baseUrl.trim().replace(/\/+$/, ''),
    provider.authType,
    provider.token,
    provider.model.trim()
  ].join('\n')
}

const SCROLL_REVEAL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
])

function isScrollableElement(element: Element): boolean {
  const style = window.getComputedStyle(element)
  const overflowY = style.overflowY
  const overflowX = style.overflowX
  const canScrollY =
    /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1
  const canScrollX =
    /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth + 1
  return canScrollY || canScrollX
}

function eventTargetsScrollableArea(target: EventTarget | null): boolean {
  let element = target instanceof Element ? target : null
  while (element && element !== document.documentElement) {
    if (isScrollableElement(element)) return true
    element = element.parentElement
  }
  return false
}

function readChatTopbarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(CHAT_TOPBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

function WindowTitlebar(): JSX.Element {
  return (
    <div className="window-titlebar flex shrink-0 items-center text-[13px] text-zinc-200/80">
      <div className="window-titlebar-drag flex min-w-0 flex-1 items-center gap-2 px-4">
        <div className="flex h-5 w-5 items-center justify-center rounded-md border border-white/15 bg-accent/70 text-[10px] font-semibold text-white shadow-sm shadow-black/20">
          F
        </div>
        <span className="font-medium">Forge</span>
      </div>
      <div className="window-controls flex h-full shrink-0 items-stretch">
        <button
          type="button"
          className="window-control"
          aria-label="最小化"
          onClick={() => void window.api.minimizeWindow()}
        >
          <span className="mb-1 block h-px w-3 rounded bg-current" />
        </button>
        <button
          type="button"
          className="window-control"
          aria-label="最大化"
          onClick={() => void window.api.toggleMaximizeWindow()}
        >
          <span className="block h-3 w-3 rounded-[2px] border border-current" />
        </button>
        <button
          type="button"
          className="window-control close"
          aria-label="关闭"
          onClick={() => void window.api.closeWindow()}
        >
          <span className="relative block h-4 w-4 before:absolute before:left-1/2 before:top-1/2 before:h-px before:w-4 before:-translate-x-1/2 before:-translate-y-1/2 before:rotate-45 before:bg-current after:absolute after:left-1/2 after:top-1/2 after:h-px after:w-4 after:-translate-x-1/2 after:-translate-y-1/2 after:-rotate-45 after:bg-current" />
        </button>
      </div>
    </div>
  )
}

function ChatTopbarToggle({
  collapsed,
  onClick,
  tabIndex
}: {
  collapsed: boolean
  onClick: () => void
  tabIndex?: number
}): JSX.Element {
  return (
    <button
      type="button"
      className="chat-topbar-toggle"
      aria-label={collapsed ? '展开 Git 和运营商顶栏' : '折叠 Git 和运营商顶栏'}
      title={collapsed ? '展开 Git 和运营商顶栏' : '折叠 Git 和运营商顶栏'}
      onClick={onClick}
      tabIndex={tabIndex}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        className="chat-topbar-toggle-chevron"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function ChatTopbar({
  collapsed,
  onToggle
}: {
  collapsed: boolean
  onToggle: (expandDelta?: number) => void
}): JSX.Element {
  const [allowOverflow, setAllowOverflow] = useState(!collapsed)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (collapsed) {
      setAllowOverflow(false)
      return
    }

    const timeout = window.setTimeout(() => setAllowOverflow(true), 440)
    return () => window.clearTimeout(timeout)
  }, [collapsed])

  const measureExpandDelta = (): number => {
    if (!collapsed) return 0
    const shell = shellRef.current
    const content = contentRef.current
    const body = bodyRef.current
    if (!shell || !content || !body) return 0

    const currentHeight = Math.ceil(shell.getBoundingClientRect().height)
    const expandedHeight = Math.ceil(
      Math.max(content.scrollHeight, body.scrollHeight, body.getBoundingClientRect().height)
    )
    return Math.max(0, expandedHeight - currentHeight)
  }

  const toggle = (): void => {
    if (!collapsed) requestCloseGitDrawer()
    onToggle(measureExpandDelta())
  }

  return (
    <div ref={shellRef} className={`chat-topbar-shell shrink-0 ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="chat-topbar-collapsed-handle" aria-hidden={!collapsed}>
        <ChatTopbarToggle collapsed={collapsed} onClick={toggle} tabIndex={collapsed ? 0 : -1} />
      </div>
      <div
        ref={contentRef}
        className={`chat-topbar-content ${allowOverflow ? 'is-overflow-visible' : ''}`}
        aria-hidden={collapsed}
      >
        <div ref={bodyRef} className="chat-topbar-body">
          <RuntimeStatusStrip />
          <GitToolbar cornerAction={<ChatTopbarToggle collapsed={false} onClick={toggle} />} />
        </div>
      </div>
    </div>
  )
}

function BlockingOverlay({ label }: { label: string }): JSX.Element {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/72 p-6 backdrop-blur-md">
      <div className="flex flex-col items-center gap-4 text-zinc-100">
        <div className="h-11 w-11 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
        <div className="text-sm font-medium text-zinc-200">{label}</div>
      </div>
    </div>
  )
}

function MainViewContent({
  view,
  chatTopbarCollapsed,
  chatTopbarLayoutMotion,
  chatTopbarScrollReserve,
  chatTopbarScrollReserveVersion,
  onTranscriptAtBottomChange,
  onToggleChatTopbar
}: {
  view: View
  chatTopbarCollapsed: boolean
  chatTopbarLayoutMotion: boolean
  chatTopbarScrollReserve: number
  chatTopbarScrollReserveVersion: number
  onTranscriptAtBottomChange: (atBottom: boolean) => void
  onToggleChatTopbar: (expandDelta?: number) => void
}): JSX.Element {
  if (view === 'mcp') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <McpPanel />
      </div>
    )
  }

  if (view === 'providers') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProvidersPanel />
      </div>
    )
  }

  if (view === 'skills') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <SkillsPanel />
      </div>
    )
  }

  if (view === 'settings') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsPanel />
      </div>
    )
  }

  if (view === 'translate') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <TranslatePanel />
      </div>
    )
  }

  if (view === 'help') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <HelpPanel />
      </div>
    )
  }

  if (view === 'wslHealth') {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <WslHealthPanel />
      </div>
    )
  }

  return (
    <>
      <ChatTopbar collapsed={chatTopbarCollapsed} onToggle={onToggleChatTopbar} />
      <div className="min-h-0 flex-1 overflow-hidden" onPointerDownCapture={requestCloseGitDrawer}>
        <Transcript
          layoutTransitioning={chatTopbarLayoutMotion}
          bottomReserve={chatTopbarScrollReserve}
          bottomReserveVersion={chatTopbarScrollReserveVersion}
          onAtBottomChange={onTranscriptAtBottomChange}
        />
      </div>
      <Composer />
      <ErrorDiagnosticPanel />
      <StatusBar />
    </>
  )
}

export default function App(): JSX.Element {
  useApplyAppearanceSettings()

  const meta = useSessionStore((s) => s.meta)
  const bootstrapped = useSessionStore((s) => s.bootstrapped)
  const bootstrap = useSessionStore((s) => s.bootstrap)
  const addPerm = useSessionStore((s) => s.addPermissionRequest)
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const attachmentPreview = useUiStore((s) => s.attachmentPreview)
  const blockingOverlay = useUiStore((s) => s.blockingOverlay)
  const previewOpen = !!attachmentPreview
  const closeAttachmentPreview = useUiStore((s) => s.closeAttachmentPreview)
  const chatSessionKey = meta?.sessionId ?? ''
  const [displayView, setDisplayView] = useState<View>(view)
  const [viewSwitching, setViewSwitching] = useState(false)
  const [displayChatSessionKey, setDisplayChatSessionKey] = useState(chatSessionKey)
  const [chatSwitching, setChatSwitching] = useState(false)
  const [previewMounted, setPreviewMounted] = useState(previewOpen)
  const [previewClosing, setPreviewClosing] = useState(false)
  const [chatTopbarCollapsed, setChatTopbarCollapsed] = useState(readChatTopbarCollapsed)
  const [chatTopbarLayoutMotion, setChatTopbarLayoutMotion] = useState(false)
  const [chatTopbarScrollReserve, setChatTopbarScrollReserve] = useState(0)
  const [chatTopbarScrollReserveVersion, setChatTopbarScrollReserveVersion] = useState(0)
  const [closePromptOpen, setClosePromptOpen] = useState(false)
  const [availableUpdate, setAvailableUpdate] = useState<UpdateCheckResult | null>(null)
  const chatTopbarCollapsedRef = useRef(chatTopbarCollapsed)
  const transcriptAtBottomRef = useRef(true)
  const gitTopbarAutoExpandedCwdRef = useRef<string | null>(null)
  const chatTopbarLayoutMotionTimeoutRef = useRef<number | null>(null)
  const providerRuntimeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    chatTopbarCollapsedRef.current = chatTopbarCollapsed
    window.localStorage.setItem(CHAT_TOPBAR_COLLAPSED_KEY, String(chatTopbarCollapsed))
  }, [chatTopbarCollapsed])

  const beginChatTopbarLayoutMotion = (clearScrollReserve = false): void => {
    setChatTopbarLayoutMotion(true)
    if (chatTopbarLayoutMotionTimeoutRef.current !== null) {
      window.clearTimeout(chatTopbarLayoutMotionTimeoutRef.current)
    }
    chatTopbarLayoutMotionTimeoutRef.current = window.setTimeout(() => {
      chatTopbarLayoutMotionTimeoutRef.current = null
      setChatTopbarLayoutMotion(false)
      if (clearScrollReserve) setChatTopbarScrollReserve(0)
    }, CHAT_TOPBAR_LAYOUT_MOTION_MS)
  }

  const expandChatTopbarAfterPreScroll = (): void => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setChatTopbarCollapsed(false))
    })
  }

  const toggleChatTopbar = (expandDelta = 0): void => {
    const expanding = chatTopbarCollapsedRef.current
    const reserveHeight = expanding && transcriptAtBottomRef.current ? Math.ceil(expandDelta) : 0

    if (reserveHeight > 0) {
      setChatTopbarScrollReserve(reserveHeight)
      setChatTopbarScrollReserveVersion((version) => version + 1)
      beginChatTopbarLayoutMotion(true)
      expandChatTopbarAfterPreScroll()
      return
    }

    beginChatTopbarLayoutMotion()
    setChatTopbarCollapsed((collapsed) => !collapsed)
  }

  useEffect(() => {
    return () => {
      if (chatTopbarLayoutMotionTimeoutRef.current !== null) {
        window.clearTimeout(chatTopbarLayoutMotionTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const cwd = meta?.cwd
    if (!cwd || gitTopbarAutoExpandedCwdRef.current === cwd) return

    let alive = true
    void window.api.isGitRepo(cwd).then((isRepo) => {
      if (!alive || !isRepo) return
      gitTopbarAutoExpandedCwdRef.current = cwd
      if (chatTopbarCollapsedRef.current) beginChatTopbarLayoutMotion()
      setChatTopbarCollapsed(false)
    }).catch(() => {
      if (alive) gitTopbarAutoExpandedCwdRef.current = cwd
    })

    return () => {
      alive = false
    }
  }, [meta?.cwd])

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  useEffect(() => {
    const enforceWslSupport = (): void => {
      void window.api.getPreferences().then((prefs) => {
        if (!prefs.wslSupportEnabled && useUiStore.getState().view === 'wslHealth') {
          setView('settings')
        }
      })
    }
    enforceWslSupport()
    return onForgeEvent('wslSupportChanged', enforceWslSupport)
  }, [setView])

  useEffect(() => {
    const enforceAgentBackendView = (): void => {
      void window.api.getPreferences().then((prefs) => {
        if (prefs.agentBackend === 'codex' && useUiStore.getState().view === 'providers') {
          setView('settings')
        }
      })
    }
    enforceAgentBackendView()
    const offAgentBackend = onForgeEvent('agentBackendChanged', enforceAgentBackendView)
    const offProvider = onForgeEvent('providerChanged', enforceAgentBackendView)
    return () => {
      offAgentBackend()
      offProvider()
    }
  }, [setView])

  useEffect(() => {
    let timeout: number | null = null

    if (previewOpen) {
      setPreviewMounted(true)
      setPreviewClosing(false)
      return
    }

    if (!previewMounted) {
      setPreviewClosing(false)
      return
    }

    setPreviewClosing(true)
    timeout = window.setTimeout(() => {
      timeout = null
      setPreviewMounted(false)
      setPreviewClosing(false)
    }, PREVIEW_CLOSE_MS)

    return () => {
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [previewMounted, previewOpen])

  useEffect(() => {
    const root = document.documentElement
    let hideTimeout: number | null = null
    let lastRevealAt = 0
    const passiveCapture: AddEventListenerOptions = { capture: true, passive: true }

    const hideScrollbars = (): void => {
      hideTimeout = null
      root.classList.remove('scrollbars-active')
    }

    const revealScrollbars = (): void => {
      const now = window.performance.now()
      if (root.classList.contains('scrollbars-active') && now - lastRevealAt < 96) return
      lastRevealAt = now
      root.classList.add('scrollbars-active')
      if (hideTimeout !== null) window.clearTimeout(hideTimeout)
      hideTimeout = window.setTimeout(hideScrollbars, SCROLLBAR_IDLE_MS)
    }

    const revealIfScrollable = (event: Event): void => {
      if (eventTargetsScrollableArea(event.target)) revealScrollbars()
    }

    const revealForScrollKey = (event: KeyboardEvent): void => {
      if (SCROLL_REVEAL_KEYS.has(event.key)) revealScrollbars()
    }

    document.addEventListener('scroll', revealScrollbars, true)
    document.addEventListener('wheel', revealIfScrollable, passiveCapture)
    document.addEventListener('pointermove', revealIfScrollable, passiveCapture)
    document.addEventListener('pointerdown', revealIfScrollable, passiveCapture)
    document.addEventListener('keydown', revealForScrollKey, true)

    return () => {
      if (hideTimeout !== null) window.clearTimeout(hideTimeout)
      root.classList.remove('scrollbars-active')
      document.removeEventListener('scroll', revealScrollbars, true)
      document.removeEventListener('wheel', revealIfScrollable, passiveCapture)
      document.removeEventListener('pointermove', revealIfScrollable, passiveCapture)
      document.removeEventListener('pointerdown', revealIfScrollable, passiveCapture)
      document.removeEventListener('keydown', revealForScrollKey, true)
    }
  }, [])

  useEffect(() => {
    if (displayView === view) {
      setViewSwitching(false)
      return
    }

    setViewSwitching(true)
    setDisplayView(view)
    const timeout = window.setTimeout(() => {
      window.requestAnimationFrame(() => setViewSwitching(false))
    }, VIEW_SWAP_DELAY_MS)

    return () => window.clearTimeout(timeout)
  }, [displayView, view])

  useEffect(() => {
    if (view !== 'chat') closeAttachmentPreview()
  }, [closeAttachmentPreview, view])

  useEffect(() => {
    if (!chatSessionKey || displayChatSessionKey === chatSessionKey) {
      setChatSwitching(false)
      return
    }

    setDisplayChatSessionKey(chatSessionKey)
    closeAttachmentPreview()
    setChatSwitching(true)
    const timeout = window.setTimeout(() => setChatSwitching(false), CHAT_SWAP_CLEAR_MS)
    return () => window.clearTimeout(timeout)
  }, [chatSessionKey, closeAttachmentPreview, displayChatSessionKey])

  useEffect(() => {
    // Streaming deltas are coalesced to ≤1 store update per frame (pushAgentEvent);
    // structural events flush the buffer first, then apply.
    const off1 = window.api.onAgentEvent((e) => pushAgentEvent(e))
    const off2 = window.api.onPermissionRequest((r) => addPerm(r))
    // Flush buffered deltas if the tab is hidden (rAF pauses when occluded) so
    // no text is ever dropped mid-stream.
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushAgentEvents()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      off1()
      off2()
      document.removeEventListener('visibilitychange', onVisibility)
      flushAgentEvents()
    }
  }, [addPerm])

  useEffect(() => {
    const off = window.api.onClosePrompt(() => setClosePromptOpen(true))
    return off
  }, [])

  useEffect(() => {
    const off = window.api.onUpdateAvailable((info) => setAvailableUpdate(info))
    return off
  }, [])

  useEffect(() => {
    let alive = true

    const syncProviderRuntime = async (markDirty: boolean): Promise<void> => {
      const provider = await window.api.getActiveProvider().catch(() => null)
      if (!alive) return
      const previousKey = providerRuntimeKeyRef.current
      const nextKey = providerRuntimeKey(provider)
      providerRuntimeKeyRef.current = nextKey

      if (!markDirty || previousKey === null || previousKey === nextKey || !provider) return
      const state = useSessionStore.getState()
      const currentMeta = state.meta
      if (!currentMeta || currentMeta.agentBackend === 'codex') return
      useSessionStore.setState({
        meta: { ...currentMeta, model: provider.model },
        sessionConfigDirty: true
      })
    }

    const emitProviderChanged = (): void => {
      emitForgeEvent('providerChanged')
      emitForgeEvent('modelOptionsChanged')
    }

    const refreshProviderKey = (): void => {
      void syncProviderRuntime(false)
    }

    void syncProviderRuntime(false)
    const offProvider = onForgeEvent('providerChanged', refreshProviderKey)
    const off = window.api.onProvidersChanged(() => {
      void syncProviderRuntime(true).finally(emitProviderChanged)
    })
    return () => {
      alive = false
      off()
      offProvider()
    }
  }, [])

  if (!bootstrapped) {
    return (
      <div className="app-shell flex h-screen flex-col overflow-hidden">
        <WindowTitlebar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="accent-soft-button flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white">
            F
          </div>
        </div>
        {blockingOverlay && <BlockingOverlay label={blockingOverlay.label} />}
      </div>
    )
  }

  if (!meta) {
    return (
      <ErrorBoundary>
        <div className="app-shell flex h-screen flex-col overflow-hidden text-zinc-200">
          <WindowTitlebar />
          <div className="min-h-0 flex-1">
            <Onboarding />
          </div>
          <UpdateAvailableDialog
            info={availableUpdate}
            onClose={() => setAvailableUpdate(null)}
          />
          {blockingOverlay && <BlockingOverlay label={blockingOverlay.label} />}
        </div>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app-shell flex h-screen flex-col overflow-hidden text-zinc-200">
        <WindowTitlebar />
        <div
          className={`workspace-shell min-h-0 flex-1 p-4 ${
            previewOpen ? 'has-preview' : ''
          } ${previewClosing ? 'is-preview-closing' : ''}`}
        >
          <Sidebar />
          <div className="main-surface flex min-w-0 flex-1 flex-col overflow-hidden">
            <div
              key={displayView}
              className={`main-view-transition flex min-h-0 flex-1 flex-col ${
                viewSwitching ? 'is-switching' : ''
              }`}
            >
              {displayView === 'chat' ? (
                <div
                  key={displayChatSessionKey}
                  className={`chat-session-transition flex min-h-0 flex-1 flex-col ${
                    chatSwitching ? 'is-switching' : ''
                  }`}
                >
                  <MainViewContent
                    view={displayView}
                    chatTopbarCollapsed={chatTopbarCollapsed}
                    chatTopbarLayoutMotion={chatTopbarLayoutMotion}
                    chatTopbarScrollReserve={chatTopbarScrollReserve}
                    chatTopbarScrollReserveVersion={chatTopbarScrollReserveVersion}
                    onTranscriptAtBottomChange={(atBottom) => {
                      transcriptAtBottomRef.current = atBottom
                    }}
                    onToggleChatTopbar={toggleChatTopbar}
                  />
                </div>
              ) : (
                <MainViewContent
                  view={displayView}
                  chatTopbarCollapsed={chatTopbarCollapsed}
                  chatTopbarLayoutMotion={chatTopbarLayoutMotion}
                  chatTopbarScrollReserve={chatTopbarScrollReserve}
                  chatTopbarScrollReserveVersion={chatTopbarScrollReserveVersion}
                  onTranscriptAtBottomChange={(atBottom) => {
                    transcriptAtBottomRef.current = atBottom
                  }}
                  onToggleChatTopbar={toggleChatTopbar}
                />
              )}
            </div>
          </div>
          <div className="workspace-preview-slot min-w-0 overflow-hidden">
            {(previewOpen || previewMounted) && <AttachmentPreviewPane />}
          </div>
          <PermissionModal />
          <ClosePromptDialog open={closePromptOpen} onClose={() => setClosePromptOpen(false)} />
          <UpdateAvailableDialog
            info={availableUpdate}
            onClose={() => setAvailableUpdate(null)}
          />
          {blockingOverlay && <BlockingOverlay label={blockingOverlay.label} />}
        </div>
      </div>
    </ErrorBoundary>
  )
}
