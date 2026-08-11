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
  const pairing = await getPairing()
  if (!pairing) {
    lastError = '未配对：请在扩展选项里粘贴 Tran 的配对码'
    setBadge(false)
    return
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

/** 工具分发。第 1 步只有 ping；第 2 步在这里补 tabs_list / navigate / read_page。 */
async function handleToolCall(msg) {
  switch (msg.tool) {
    case 'ping':
      return { pong: true, extensionVersion: EXTENSION_VERSION }
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
