import { useSessionStore } from './store/sessionStore'
import { useUiStore } from './store/uiStore'
import { usePetStore } from './store/petStore'
import { emitForgeEvent } from './events'

/**
 * 全局快捷键注册表。
 *
 * 键位对齐 Codex 桌面版——不是拍脑袋定的，是从 OpenAI.Codex 26.730 的
 * `app.asar → webview/assets/app-initial-*.js` 里那张命令表读出来的
 * （每条命令带 `electron.defaultKeybindings`）。已核对的原始键位：
 *
 *   CmdOrCtrl+B         toggleSidebar
 *   CmdOrCtrl+N         newCodexPanel（新建）
 *   CmdOrCtrl+O         openFolder
 *   CmdOrCtrl+P         searchFiles
 *   Ctrl+Tab / +Shift   next/previousRecentThread
 *   CmdOrCtrl+2..9      thread2..9
 *   CmdOrCtrl+Alt+R     renameThread
 *   CmdOrCtrl+Alt+C     copySessionId
 *   CmdOrCtrl+Shift+C   copyWorkingDirectory
 *   CmdOrCtrl+Shift+E   toggleFileTreePanel
 *
 * 刻意**不**照搬的：
 * - `CmdOrCtrl+W`（closeTab）：Tran 里最接近的动作是删除会话，而那是不可逆的
 *   真删数据。同一个键在 Codex 只是关标签页，照搬会让人凭肌肉记忆丢数据。
 * - `CmdOrCtrl+J`（toggleBottomPanel）、`CmdOrCtrl+Shift+N`（temporaryChat）：
 *   Tran 没有对应概念。
 *
 * 为什么要有这么个注册表，而不是各组件自己挂 keydown：现在全 app 的键盘处理是
 * 散在组件里的（Composer 的 Ctrl+S、Sidebar 的 Esc……），没有单一出处。将来要做
 * 「快捷键自定义」时，散挂的监听根本收不拢，也无法检测冲突。所有新增键位一律
 * 走这里。
 */

export interface ShortcutAction {
  id: string
  /** 设置页展示用的中文名。 */
  label: string
  /** 归一化后的键位串，见 normalizeKeyEvent。多个 = 任一命中。 */
  keys: string[]
  run: () => void
  /**
   * 是否允许在输入框/可编辑区内触发。默认 false —— 否则在输入框里打字会误触
   * （比如按 Ctrl+2 想输入什么，结果会话被切走）。
   * 只有明确“任何时候都该生效”的才开，例如切换侧栏。
   */
  allowInInput?: boolean
}

/**
 * 把键盘事件归一成 `Ctrl+Shift+B` 这种串。
 *
 * 约定：修饰键顺序固定 Ctrl→Alt→Shift；macOS 的 Meta 归一成 Ctrl（对应 Codex
 * 的 CmdOrCtrl 语义）；字母一律大写，其余用 event.key 原样（Tab/Escape/数字）。
 * 顺序固定这件事很重要——否则 'Shift+Ctrl+B' 和 'Ctrl+Shift+B' 会被当成两个键位。
 */
export function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const key = e.key
  if (key.length === 1) parts.push(key.toUpperCase())
  else parts.push(key)
  return parts.join('+')
}

/** 事件源是不是输入区（输入框/文本域/contenteditable）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* 复制失败不值得打断用户，静默 */
  }
}

/** 按当前会话列表里的顺序切到相对位置（-1 上一个 / +1 下一个）。 */
function stepSession(delta: number): void {
  const s = useSessionStore.getState()
  const list = s.sessions
  if (list.length < 2) return
  const current = s.meta?.sdkSessionId
  const idx = list.findIndex((item) => item.sessionId === current)
  // 当前会话不在列表里（新会话还没落库）时，从头/尾进入。
  const nextIdx = idx < 0 ? (delta > 0 ? 0 : list.length - 1) : (idx + delta + list.length) % list.length
  const target = list[nextIdx]
  if (!target || target.sessionId === current) return
  void s.openSessionCrossProject(target.sessionId, target.cwd ?? '', target.runtimeBackend)
}

/** 切到列表里的第 n 个会话（1 起）。对应 Codex 的 thread2..9。 */
function gotoSession(n: number): void {
  const s = useSessionStore.getState()
  const target = s.sessions[n - 1]
  if (!target || target.sessionId === s.meta?.sdkSessionId) return
  void s.openSessionCrossProject(target.sessionId, target.cwd ?? '', target.runtimeBackend)
}

/**
 * 自定义绑定：actionId → 键位串数组，覆盖默认值。
 *
 * 存在 localStorage 而不是主进程的 tran-settings.json：快捷键是纯渲染层的事，
 * 走 IPC 得铺 preload + settings 字段 + 类型 + 归一化一整套，换不来任何好处。
 */
const BINDINGS_KEY = 'tran.shortcutBindings'

function readOverrides(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(BINDINGS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [id, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) out[id] = keys as string[]
    }
    return out
  } catch {
    return {}
  }
}

function writeOverrides(map: Record<string, string[]>): void {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式/存储满：本次会话内仍生效（listeners 会拿到新表） */
  }
}

const bindingListeners = new Set<() => void>()

/** 绑定变更后通知已挂载的监听器重建映射表。 */
export function onShortcutBindingsChanged(fn: () => void): () => void {
  bindingListeners.add(fn)
  return () => bindingListeners.delete(fn)
}

export function setShortcutBinding(id: string, keys: string[]): void {
  const map = readOverrides()
  map[id] = keys
  writeOverrides(map)
  for (const fn of bindingListeners) fn()
}

/** 恢复某个动作的默认键位。 */
export function resetShortcutBinding(id: string): void {
  const map = readOverrides()
  delete map[id]
  writeOverrides(map)
  for (const fn of bindingListeners) fn()
}

/** 应用自定义绑定后的完整动作表（设置页与全局监听共用同一出处）。 */
export function resolvedShortcuts(): ShortcutAction[] {
  const overrides = readOverrides()
  return buildShortcuts().map((a) =>
    overrides[a.id] ? { ...a, keys: overrides[a.id] } : a
  )
}

/** 该动作当前是否被改过（用于设置页显示"恢复默认"）。 */
export function isShortcutOverridden(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(readOverrides(), id)
}

/**
 * 键位冲突检测：返回与给定键位撞车的其它动作 id。
 *
 * 必须做——两个动作绑同一个键时，全局监听按注册顺序命中第一个，后者永远不触发，
 * 而用户在设置页看到的是"两个都绑好了"，只会以为坏了。
 */
export function conflictingActions(id: string, keys: string[]): string[] {
  const wanted = new Set(keys)
  return resolvedShortcuts()
    .filter((a) => a.id !== id && a.keys.some((k) => wanted.has(k)))
    .map((a) => a.id)
}

export function buildShortcuts(): ShortcutAction[] {
  const ui = (): ReturnType<typeof useUiStore.getState> => useUiStore.getState()
  const sess = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

  const list: ShortcutAction[] = [
    {
      id: 'toggleSidebar',
      label: '隐藏 / 显示侧栏',
      // Alt+W（用户指定 2026-08）与 Ctrl+B（VS Code / Codex 的肌肉记忆）都绑到
      // 隐藏切换；Alt+Q 同义。图标条模式 2026-08-18 已砍，这里不再分两档。
      keys: ['Alt+W', 'Ctrl+B'],
      // 侧栏开合在输入时也该能用：不影响文本，纯视图动作。
      allowInInput: true,
      run: () => ui().toggleSidebarHidden()
    },
    {
      id: 'hideSidebar',
      label: '隐藏 / 显示侧栏',
      // Alt+Q 是用户指定的完全隐藏键位（2026-08）：连图标条都不留，Codex 风。
      // Windows 上没冲突：Chromium 未占用，Tran 是自绘标题栏、没有菜单栏。
      keys: ['Alt+Q'],
      allowInInput: true,
      run: () => ui().toggleSidebarHidden()
    },
    {
      id: 'togglePet',
      label: '宠物开关',
      // Alt+P（2026-08-27）：注册表里 Alt 系只占了 Q/W，Chromium 也不占 P。
      // 拨的是 desktopPetEnabled 这一个偏好——与侧栏头部爪印开关、「宠物」页的
      // 开关同源；先改渲染层镜像让宠物立刻显隐，主进程保存后会推
      // preferences-changed 重新对齐（窗口外悬浮宠物也靠这一推）。
      keys: ['Alt+P'],
      allowInInput: true,
      run: () => {
        const pet = usePetStore.getState()
        const next = !pet.masterEnabled
        pet.setMasterEnabled(next)
        void window.api.savePreferences({ desktopPetEnabled: next }).catch(() => {
          usePetStore.getState().setMasterEnabled(!next)
        })
      }
    },
    {
      id: 'newChat',
      label: '新建对话',
      keys: ['Ctrl+N'],
      run: () => {
        void sess().newChat()
        ui().setView('chat')
      }
    },
    {
      id: 'nextSession',
      label: '下一个会话',
      keys: ['Ctrl+Tab'],
      allowInInput: true,
      run: () => stepSession(1)
    },
    {
      id: 'prevSession',
      label: '上一个会话',
      keys: ['Ctrl+Shift+Tab'],
      allowInInput: true,
      run: () => stepSession(-1)
    },
    {
      id: 'copySessionId',
      label: '复制会话 ID',
      keys: ['Ctrl+Alt+C'],
      run: () => void copyText(sess().meta?.sdkSessionId ?? '')
    },
    {
      id: 'copyWorkingDirectory',
      label: '复制工作目录',
      keys: ['Ctrl+Shift+C'],
      run: () => void copyText(sess().meta?.cwd ?? '')
    },
    {
      id: 'searchSessions',
      label: '搜索会话',
      // Ctrl+K 对齐 Codex 的搜索面板键位；输入框里也要能开（它是全局动作）。
      keys: ['Ctrl+K'],
      allowInInput: true,
      run: () => emitForgeEvent('openSessionSearch')
    },
    {
      id: 'openSettings',
      label: '打开设置',
      keys: ['Ctrl+,'],
      run: () => ui().setView('settings')
    }
  ]

  // Ctrl+2..9 → 列表里的第 2..9 个会话（与 Codex 的 thread2..9 对齐；
  // Codex 的 Ctrl+1 另作他用，这里也不占）。
  for (let n = 2; n <= 9; n++) {
    list.push({
      id: `gotoSession${n}`,
      label: `切到第 ${n} 个会话`,
      keys: [`Ctrl+${n}`],
      run: () => gotoSession(n)
    })
  }

  return list
}

/**
 * 挂全局监听，返回卸载函数。
 *
 * 捕获阶段（capture=true）：要抢在组件自己的 keydown 之前判定，否则
 * Composer 的 Enter/Escape 处理会先吃掉事件。命中才 preventDefault，
 * 没命中的事件原样放行——绝不能因为装了这套就让打字变卡或吞键。
 */
export function installShortcuts(): () => void {
  // 自定义绑定变更时重建动作表；不这么做的话，改完键位要重启才生效。
  let actions = resolvedShortcuts()
  const unsubscribe = onShortcutBindingsChanged(() => {
    actions = resolvedShortcuts()
  })
  const onKeyDown = (e: KeyboardEvent): void => {
    // 输入法组字过程中不参与匹配：composing 期间的 keydown 是 IME 的，
    // 拿去比对会在中文输入时误触发。
    if (e.isComposing) return
    const combo = normalizeKeyEvent(e)
    const inEditable = isEditableTarget(e.target)
    for (const action of actions) {
      if (!action.keys.includes(combo)) continue
      if (inEditable && !action.allowInInput) continue
      e.preventDefault()
      e.stopPropagation()
      action.run()
      return
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    unsubscribe()
    document.removeEventListener('keydown', onKeyDown, true)
  }
}
