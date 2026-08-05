import { useSessionStore } from './store/sessionStore'
import { useUiStore } from './store/uiStore'

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

export function buildShortcuts(): ShortcutAction[] {
  const ui = (): ReturnType<typeof useUiStore.getState> => useUiStore.getState()
  const sess = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

  const list: ShortcutAction[] = [
    {
      id: 'toggleSidebar',
      label: '收起 / 展开侧栏',
      // Alt+Q 是主键位（用户指定）；Ctrl+B 一并保留——它是 VS Code / Codex 的
      // 通用肌肉记忆，多绑一个不占成本。Alt+Q 在 Windows 上没冲突：Chromium
      // 未占用，且 Tran 是自绘标题栏、没有菜单栏，不会触发菜单助记键。
      keys: ['Alt+Q', 'Ctrl+B'],
      // 侧栏开合在输入时也该能用：不影响文本，纯视图动作。
      allowInInput: true,
      // 语义与手动点收起按钮**完全一致**：就是 collapsed 的切换，没有第二种状态。
      run: () => ui().toggleSidebar()
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
  const actions = buildShortcuts()
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
  return () => document.removeEventListener('keydown', onKeyDown, true)
}
