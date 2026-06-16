import { useEffect, useState } from 'react'
import { useSessionStore } from './store/sessionStore'
import { useUiStore, type View } from './store/uiStore'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import Transcript from './components/Transcript'
import Composer from './components/Composer'
import StatusBar from './components/StatusBar'
import GitToolbar, { requestCloseGitDrawer } from './components/GitToolbar'
import AttachmentPreviewPane from './components/AttachmentPreviewPane'
import PermissionModal from './components/PermissionModal'
import McpPanel from './components/McpPanel'
import ProvidersPanel from './components/ProvidersPanel'
import SkillsPanel from './components/SkillsPanel'
import SettingsPanel from './components/SettingsPanel'
import TranslatePanel from './components/TranslatePanel'
import ErrorBoundary from './components/ErrorBoundary'
import { useApplyAppearanceSettings } from './store/appearanceStore'
import { pushAgentEvent, flushAgentEvents } from './store/streamBatcher'

const VIEW_SWAP_DELAY_MS = 90
const CHAT_SWAP_CLEAR_MS = 220
const SCROLLBAR_IDLE_MS = 1800
const PREVIEW_CLOSE_MS = 720

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

function MainViewContent({ view }: { view: View }): JSX.Element {
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

  return (
    <>
      <GitToolbar />
      <div className="min-h-0 flex-1 overflow-hidden" onPointerDownCapture={requestCloseGitDrawer}>
        <Transcript />
      </div>
      <Composer />
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
  const attachmentPreview = useUiStore((s) => s.attachmentPreview)
  const previewOpen = !!attachmentPreview
  const closeAttachmentPreview = useUiStore((s) => s.closeAttachmentPreview)
  const chatSessionKey = meta?.sessionId ?? ''
  const [displayView, setDisplayView] = useState<View>(view)
  const [viewSwitching, setViewSwitching] = useState(false)
  const [displayChatSessionKey, setDisplayChatSessionKey] = useState(chatSessionKey)
  const [chatSwitching, setChatSwitching] = useState(false)
  const [previewMounted, setPreviewMounted] = useState(previewOpen)
  const [previewClosing, setPreviewClosing] = useState(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

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
    const timeout = window.setTimeout(() => {
      setDisplayView(view)
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

  if (!bootstrapped) {
    return (
      <div className="app-shell flex h-screen flex-col overflow-hidden">
        <WindowTitlebar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="accent-soft-button flex h-10 w-10 items-center justify-center rounded-xl text-lg font-bold text-white">
            F
          </div>
        </div>
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
        </div>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app-shell flex h-screen flex-col overflow-hidden text-zinc-200">
        <WindowTitlebar />
        <div
          className={`workspace-shell min-h-0 flex-1 p-4 pt-4 ${
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
                  <MainViewContent view={displayView} />
                </div>
              ) : (
                <MainViewContent view={displayView} />
              )}
            </div>
          </div>
          <div className="workspace-preview-slot min-w-0 overflow-hidden">
            {(previewOpen || previewMounted) && <AttachmentPreviewPane />}
          </div>
          <PermissionModal />
        </div>
      </div>
    </ErrorBoundary>
  )
}
