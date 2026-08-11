// Tran 浏览器桥 - MV3 service worker
//
// 职责：维持到 Tran 主进程（ws://127.0.0.1:<port>）的 WebSocket 连接，
// 完成 token 握手，接收工具调用并回传结果。
//
// MV3 约束：SW 随时可能被 Chrome 杀掉。对策：
//  - chrome.alarms 每 30s 唤醒一次，发现掉线就重连；
//  - Tran 侧每 ~20s 发应用层 ping，WS 消息到达 JS 会重置 SW 的空闲计时器
//    （Chrome 116+），连接活跃时 SW 不会被杀；
//  - 配对信息存 chrome.storage.local，SW 重启后自动重连。

const PROTOCOL_VERSION = 1
const EXTENSION_VERSION = chrome.runtime.getManifest().version
const ALARM_NAME = 'tran-bridge-keepalive'
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30000

/** @type {WebSocket | null} */
let ws = null
let connected = false // 握手（hello_ok）完成才算 connected
let reconnectAttempts = 0
let reconnectTimer = null
let lastError = ''
let tranVersion = ''

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' })
  chrome.action.setBadgeBackgroundColor({ color: on ? '#16a34a' : '#6b7280' })
}

async function getPairing() {
  const data = await chrome.storage.local.get('pairing')
  const p = data && data.pairing
  if (!p || !p.port || !p.token) return null
  return p
}

/** 解析配对码 tran1:<port>:<token>，成功则存储并立即重连。 */
async function savePairingCode(code) {
  const m = /^tran1:(\d{2,5}):([A-Za-z0-9_-]{16,})$/.exec((code || '').trim())
  if (!m) return { ok: false, error: '配对码格式不对，应形如 tran1:9224:xxxxxxxx' }
  await chrome.storage.local.set({ pairing: { port: Number(m[1]), token: m[2] } })
  reconnectAttempts = 0
  reconnect(0)
  return { ok: true }
}

function scheduleReconnect() {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** reconnectAttempts, BACKOFF_MAX_MS)
  reconnectAttempts += 1
  reconnect(delay)
}

// ---- 端口重发现 ----
// Tran 默认监听 9224，被占会递增。存储的端口连不上时扫描 9224-9233，
// 但绝不先交 token：先发 probe（带随机 nonce），要求服务端回
// HMAC(token, nonce) 证明它就是 Tran，验证通过才走正常 hello。

const PORT_SCAN_START = 9224
const PORT_SCAN_END = 9233

async function hmacHex(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function probePort(port, token) {
  return new Promise((resolve) => {
    let sock
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}`)
    } catch {
      resolve(false)
      return
    }
    const nonce = crypto.randomUUID()
    const done = (ok) => {
      try { sock.close() } catch { /* ignore */ }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), 1500)
    sock.onopen = () => sock.send(JSON.stringify({ type: 'probe', nonce }))
    sock.onmessage = async (ev) => {
      clearTimeout(timer)
      try {
        const msg = JSON.parse(ev.data)
        // proof 绑定端口：拨号 port 必须与服务端签名用的端口一致，挡掉中继。
        if (msg.type === 'probe_ok' && msg.proof === (await hmacHex(token, `${nonce}:${port}`))) {
          done(true)
          return
        }
      } catch { /* ignore */ }
      done(false)
    }
    sock.onerror = () => {
      clearTimeout(timer)
      done(false)
    }
  })
}

async function rediscoverPort() {
  const pairing = await getPairing()
  if (!pairing) return false
  for (let port = PORT_SCAN_START; port <= PORT_SCAN_END; port++) {
    if (await probePort(port, pairing.token)) {
      if (port !== pairing.port) {
        await chrome.storage.local.set({ pairing: { port, token: pairing.token } })
        lastError = ''
      }
      return true
    }
  }
  return false
}

function reconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  // SW 若在等待期间被杀，这个 timer 会丢——由 alarms 兜底唤醒重连。
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delayMs)
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  let pairing = await getPairing()
  if (!pairing) {
    lastError = '未配对：请在扩展选项里粘贴 Tran 的配对码'
    setBadge(false)
    return
  }
  // 连续失败多次：可能 Tran 换了端口（9224 被占递增），扫一轮重发现。
  if (reconnectAttempts >= 4 && reconnectAttempts % 4 === 0) {
    if (await rediscoverPort()) pairing = await getPairing()
  }
  // 先 probe 验明端口后面确实是 Tran（服务端 HMAC 证明），再交 token——
  // 否则占用存储端口的陌生本地进程能直接骗到 token。probe 失败就走重发现，
  // 仍不行则等下次退避重连（绝不盲发 token）。
  if (!(await probePort(pairing.port, pairing.token))) {
    if (await rediscoverPort()) {
      pairing = await getPairing()
    } else {
      lastError = `端口 ${pairing.port} 后面不是 Tran（未运行或被占用），已跳过以保护配对码`
      setBadge(false)
      scheduleReconnect()
      return
    }
  }
  let socket
  try {
    socket = new WebSocket(`ws://127.0.0.1:${pairing.port}`)
  } catch (e) {
    lastError = String(e && e.message ? e.message : e)
    scheduleReconnect()
    return
  }
  ws = socket

  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        role: 'extension',
        token: pairing.token,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION
      })
    )
  }

  socket.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    handleMessage(socket, msg)
  }

  socket.onclose = () => {
    if (ws !== socket) return
    ws = null
    if (connected) lastError = ''
    connected = false
    tranVersion = ''
    setBadge(false)
    scheduleReconnect()
  }

  socket.onerror = () => {
    // onclose 紧随其后，重连交给 onclose。
    lastError = `连不上 127.0.0.1:${pairing.port}（Tran 未启动？）`
  }
}

function handleMessage(socket, msg) {
  if (msg.type === 'hello_ok') {
    connected = true
    reconnectAttempts = 0
    lastError = ''
    tranVersion = msg.tranVersion || ''
    setBadge(true)
    return
  }
  if (msg.type === 'error') {
    // 握手被拒（token 不对/版本不匹配），服务端随即断开。
    lastError = msg.message || msg.code || '服务端拒绝连接'
    return
  }
  if (msg.type === 'ping') {
    socket.send(JSON.stringify({ type: 'pong' }))
    return
  }
  if (typeof msg.id === 'string' && typeof msg.tool === 'string') {
    handleToolCall(msg)
      .then((result) => socket.send(JSON.stringify({ id: msg.id, ok: true, result })))
      .catch((e) =>
        socket.send(
          JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message ? e.message : e) })
        )
      )
  }
}

// ---- 工具实现 ----

/** 只放行普通网页地址：chrome://、file:// 等交给用户自己操作。 */
function assertNavigableUrl(url) {
  if (typeof url !== 'string' || (!/^https?:\/\//i.test(url) && url !== 'about:blank')) {
    throw new Error('只支持 http/https URL（chrome://、file:// 等请手动打开）')
  }
  return url
}

/** tabId 缺省时取当前聚焦窗口的活动标签页。 */
async function resolveTab(tabId) {
  if (typeof tabId === 'number') {
    try {
      return await chrome.tabs.get(tabId)
    } catch {
      throw new Error(`标签页 ${tabId} 不存在（可能已关闭，先用 tabs_list 刷新）`)
    }
  }
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (focused) return focused
  const [any] = await chrome.tabs.query({ active: true })
  if (any) return any
  throw new Error('没有活动标签页')
}

/** 轮询等页面加载完（先歇 300ms 让 status 翻到 loading）；超时不报错，
 *  返回当下状态由调用方判断。 */
async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now()
  await new Promise((r) => setTimeout(r, 300))
  while (Date.now() - start < timeoutMs) {
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      return // 标签页没了（导航触发关闭等），交给调用方 get 时报错
    }
    if (tab.status === 'complete') return
    await new Promise((r) => setTimeout(r, 400))
  }
}

function tabInfo(t) {
  return { id: t.id, title: t.title || '', url: t.url || '', active: t.active, windowId: t.windowId, status: t.status }
}

/**
 * 注入到页面里执行：正文文本 + 可交互元素编号快照。
 * 必须自包含（chrome.scripting 序列化后在页面 isolated world 里跑）。
 * ref → 元素的映射存 window.__tranRefs，供后续 click/type 工具用；
 * 页面导航后自动失效，click 侧要自行校验。
 */
function extractPageContent(maxChars) {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    '[role="combobox"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]'
  const refs = {}
  const items = []
  let n = 0
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    n += 1
    refs[n] = el
    const tag = el.tagName.toLowerCase()
    let desc
    if (tag === 'input') {
      // 敏感字段绝不回传 value：密码、以及浏览器按 autocomplete 归类为
      // 信用卡/一次性验证码等的输入。读一次页面就把密码送进模型是不可接受的。
      const type = (el.type || 'text').toLowerCase()
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
      const sensitive =
        type === 'password' ||
        type === 'hidden' ||
        /(^|\s)(cc-number|cc-csc|cc-exp|one-time-code)(\s|$)/.test(ac) ||
        /(^|-)(cc-num|cvc|cvv|otp)(-|$)/.test(ac)
      const showValue = !sensitive && el.value
      desc =
        `<input type=${type}>` +
        (el.placeholder ? ` placeholder="${el.placeholder.slice(0, 60)}"` : '') +
        (sensitive && el.value ? ' value=[已隐藏]' : showValue ? ` value="${String(el.value).slice(0, 60)}"` : '')
    } else if (tag === 'select') {
      const opts = Array.from(el.options).slice(0, 8).map((o) => o.text.trim()).join(' | ')
      desc = `<select> 选项[${opts}]`
    } else if (tag === 'textarea') {
      desc = '<textarea>' + (el.placeholder ? ` placeholder="${el.placeholder.slice(0, 60)}"` : '')
    } else {
      const label = (el.getAttribute('aria-label') || el.innerText || el.title || '')
        .trim().replace(/\s+/g, ' ').slice(0, 80)
      const href = tag === 'a' ? (el.getAttribute('href') || '') : ''
      desc =
        `<${tag}> "${label}"` +
        (href && !href.startsWith('javascript:') ? ` → ${href.slice(0, 100)}` : '')
    }
    items.push(`ref_${n} ${desc}`)
    if (n >= 300) break
  }
  window.__tranRefs = refs

  let text = document.body ? document.body.innerText : ''
  text = text.replace(/\n{3,}/g, '\n\n')
  const head = `[页面] ${document.title} — ${location.href}`
  const itemsBlock = items.length
    ? `\n\n[可交互元素]（后续 click/type 按 ref 编号定位）\n${items.join('\n')}`
    : ''
  let budget = maxChars - head.length - itemsBlock.length - 40
  if (budget < 500) budget = 500
  const truncated = text.length > budget
  if (truncated) text = text.slice(0, budget)
  return {
    snapshot: `${head}\n\n[正文]\n${text}${truncated ? '\n…（正文已截断）' : ''}${itemsBlock}`,
    refCount: n,
    textTruncated: truncated
  }
}

/**
 * 注入执行：按 ref（read_page 编号）或 CSS selector 点击元素。
 * click() 前滚动到可视区；ref 失效（导航过）给明确提示。
 */
function clickElement(ref, selector) {
  let el = null
  if (typeof ref === 'number') {
    const refs = window.__tranRefs
    if (!refs || !refs[ref]) {
      return { error: `ref_${ref} 不存在或已失效（页面导航过？先重新 read_page）` }
    }
    el = refs[ref]
    if (!el.isConnected) return { error: `ref_${ref} 的元素已从页面移除，先重新 read_page` }
  } else if (typeof selector === 'string') {
    el = document.querySelector(selector)
    if (!el) return { error: `没有匹配 selector 的元素: ${selector}` }
  } else {
    return { error: '必须提供 ref 或 selector 之一' }
  }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const desc = (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName)
    .trim().replace(/\s+/g, ' ').slice(0, 80)
  el.click()
  return { clicked: desc }
}

/**
 * 注入执行：向输入元素写文本。用 native setter 绕过 React 等框架的受控
 * 输入（直接赋 value 不触发它们的 onChange），再补 input/change 事件；
 * submit=true 时按一次回车。
 */
function typeIntoElement(ref, selector, text, submit) {
  let el = null
  if (typeof ref === 'number') {
    const refs = window.__tranRefs
    if (!refs || !refs[ref]) {
      return { error: `ref_${ref} 不存在或已失效（页面导航过？先重新 read_page）` }
    }
    el = refs[ref]
    if (!el.isConnected) return { error: `ref_${ref} 的元素已从页面移除，先重新 read_page` }
  } else if (typeof selector === 'string') {
    el = document.querySelector(selector)
    if (!el) return { error: `没有匹配 selector 的元素: ${selector}` }
  } else {
    return { error: '必须提供 ref 或 selector 之一' }
  }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  el.focus()
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    el.textContent = text
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))
  } else {
    return { error: `元素 <${tag}> 不可输入（需要 input/textarea/contenteditable）` }
  }
  if (submit) {
    const kbOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    // 合成键盘事件不会触发浏览器原生的表单提交，所以 keydown 没被
    // preventDefault 且元素在表单里时手动补一次（模拟原生语义，避免
    // JS 自己处理了 Enter 的页面被提交两次）。
    const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', kbOpts))
    el.dispatchEvent(new KeyboardEvent('keyup', kbOpts))
    const form = el.form
    if (notPrevented && form) {
      if (form.requestSubmit) form.requestSubmit()
      else form.submit()
    }
  }
  return { typed: text.length, submitted: Boolean(submit) }
}

const NAVIGATE_TIMEOUT_MS = 15000
const READ_PAGE_DEFAULT_MAX_CHARS = 30000

async function handleToolCall(msg) {
  const args = msg.args || {}
  switch (msg.tool) {
    case 'ping':
      return { pong: true, extensionVersion: EXTENSION_VERSION }

    case 'tabs_list': {
      const tabs = await chrome.tabs.query({})
      return { tabs: tabs.map(tabInfo) }
    }

    case 'tab_open': {
      const url = args.url ? assertNavigableUrl(args.url) : 'about:blank'
      const tab = await chrome.tabs.create({ url, active: args.background !== true })
      await waitForTabComplete(tab.id, NAVIGATE_TIMEOUT_MS)
      return tabInfo(await chrome.tabs.get(tab.id))
    }

    case 'tab_activate': {
      const tab = await resolveTab(args.tabId)
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return tabInfo(await chrome.tabs.get(tab.id))
    }

    case 'tab_close': {
      if (typeof args.tabId !== 'number') throw new Error('tab_close 必须指定 tabId（防误关当前页）')
      const tab = await resolveTab(args.tabId)
      await chrome.tabs.remove(tab.id)
      return { closed: tab.id }
    }

    case 'navigate': {
      const url = assertNavigableUrl(args.url)
      const tab = await resolveTab(args.tabId)
      await chrome.tabs.update(tab.id, { url })
      await waitForTabComplete(tab.id, NAVIGATE_TIMEOUT_MS)
      const done = await chrome.tabs.get(tab.id)
      return { ...tabInfo(done), loaded: done.status === 'complete' }
    }

    case 'read_page': {
      const tab = await resolveTab(args.tabId)
      const maxChars =
        typeof args.maxChars === 'number' && args.maxChars > 0
          ? args.maxChars
          : READ_PAGE_DEFAULT_MAX_CHARS
      let results
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageContent,
          args: [maxChars]
        })
      } catch (e) {
        throw new Error(
          `无法读取该页面：${e && e.message ? e.message : e}（chrome:// 应用商店等受保护页面不允许注入）`
        )
      }
      const first = results && results[0]
      if (!first || !first.result) throw new Error('页面脚本没有返回内容')
      return { tabId: tab.id, url: tab.url, title: tab.title, ...first.result }
    }

    case 'click':
    case 'type': {
      const tab = await resolveTab(args.tabId)
      const func = msg.tool === 'click' ? clickElement : typeIntoElement
      const funcArgs =
        msg.tool === 'click'
          ? [args.ref, args.selector]
          : [args.ref, args.selector, String(args.text ?? ''), args.submit === true]
      let results
      try {
        results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: funcArgs })
      } catch (e) {
        throw new Error(`无法在该页面执行：${e && e.message ? e.message : e}（受保护页面不允许注入）`)
      }
      const first = results && results[0]
      if (!first || !first.result) throw new Error('页面脚本没有返回结果')
      if (first.result.error) throw new Error(first.result.error)
      return { tabId: tab.id, ...first.result }
    }

    case 'screenshot': {
      const tab = await resolveTab(args.tabId)
      // captureVisibleTab 只能拍窗口当前可见的标签页：先激活目标页。
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true })
        await new Promise((r) => setTimeout(r, 350))
      }
      await chrome.windows.update(tab.windowId, { focused: true })
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: typeof args.quality === 'number' ? args.quality : 70
      })
      const comma = dataUrl.indexOf(',')
      return {
        tabId: tab.id,
        url: tab.url,
        mimeType: 'image/jpeg',
        base64: dataUrl.slice(comma + 1)
      }
    }

    default:
      throw new Error(`未知工具: ${msg.tool}`)
  }
}

// ---- 保活与启动 ----

chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void connect()
})

chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => {
  setBadge(false)
  void connect()
})

// options 页交互：查询状态 / 保存配对码。
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get_status') {
    getPairing().then((pairing) => {
      sendResponse({
        paired: Boolean(pairing),
        port: pairing ? pairing.port : null,
        connected,
        tranVersion,
        extensionVersion: EXTENSION_VERSION,
        lastError
      })
    })
    return true
  }
  if (msg && msg.type === 'save_pairing') {
    savePairingCode(msg.code).then(sendResponse)
    return true
  }
  return false
})

// SW 每次被拉起（包括冷启动）都尝试连一次。
void connect()
setBadge(connected)
