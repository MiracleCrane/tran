import { app } from 'electron'
import { createHmac, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { readJsonSafe, writeJsonAtomic } from './atomicWrite'
import { log } from './logger'
import type { BrowserBridgeStatus } from '../shared/ipc'

/**
 * BrowserBridge：Tran 侧的 WebSocket 服务，Chrome 扩展（cli/extension/）
 * 连过来完成 token 握手后，Tran 就能把浏览器工具调用发给扩展执行。
 *
 * 安全前提：只监听 127.0.0.1，且握手第一条消息必须带对的 token——
 * 没有 token 校验的 localhost WS 等于给本机任意进程开浏览器后门。
 */

const PROTOCOL_VERSION = 1
const DEFAULT_PORT = 9224
const MAX_PORT_TRIES = 10
const HANDSHAKE_TIMEOUT_MS = 10_000
/** 应用层 ping 周期。WS 消息到达扩展 JS 会重置 MV3 SW 的空闲计时器
 *  （Chrome 116+），这既是探活也是扩展侧的保活。 */
const PING_INTERVAL_MS = 20_000
const IDLE_TIMEOUT_MS = 45_000
const TOOL_TIMEOUT_MS = 30_000

interface PairingFile {
  token: string
  port: number
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let server: WebSocketServer | null = null
let listeningPort: number | null = null
let token: string | null = null
/** 当前已完成握手的扩展连接（同一时刻只认一个，后连的替换先连的）。 */
let extensionSocket: WebSocket | null = null
let extensionVersion: string | null = null
let extensionLastSeen = 0
let pingTimer: NodeJS.Timeout | null = null
let nextCallId = 1
const pendingCalls = new Map<string, PendingCall>()
let notifyStatus: ((status: BrowserBridgeStatus) => void) | null = null

export function tokenFilePath(): string {
  return join(app.getPath('userData'), 'browser-bridge-token.json')
}

/** 随包分发的扩展版本（extension/manifest.json）。读不到不致命，返回 null。 */
let bundledExtensionVersionCache: string | null | undefined
function bundledExtensionVersion(): string | null {
  if (bundledExtensionVersionCache !== undefined) return bundledExtensionVersionCache
  const manifestPath = app.isPackaged
    ? join(process.resourcesPath, 'browser-extension', 'manifest.json')
    : join(app.getAppPath(), 'extension', 'manifest.json')
  const read = readJsonSafe<{ version?: string }>(manifestPath)
  bundledExtensionVersionCache = read.status === 'ok' && typeof read.value.version === 'string'
    ? read.value.version
    : null
  return bundledExtensionVersionCache
}

/** token 跨启动保持稳定（否则每次升级 Tran 都要重新配对）。
 *  文件损坏时直接重建：坏文件里的 token 本来就读不出来，重新配对不可避免。 */
function loadOrCreateToken(): string {
  const path = tokenFilePath()
  const read = readJsonSafe<Partial<PairingFile>>(path)
  if (read.status === 'ok' && typeof read.value.token === 'string' && read.value.token.length >= 16) {
    return read.value.token
  }
  if (read.status === 'failed') {
    log('browser-bridge', `token 文件损坏，重建：${read.error.message}`)
  }
  return randomBytes(24).toString('base64url')
}

export function getBrowserBridgeStatus(): BrowserBridgeStatus {
  return {
    running: server !== null,
    port: listeningPort,
    pairingCode: token !== null && listeningPort !== null ? `tran1:${listeningPort}:${token}` : null,
    extensionConnected: extensionSocket !== null,
    extensionVersion,
    bundledExtensionVersion: bundledExtensionVersion()
  }
}

function broadcastStatus(): void {
  notifyStatus?.(getBrowserBridgeStatus())
}

function tryListen(port: number): Promise<WebSocketServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port })
    wss.once('listening', () => {
      wss.removeAllListeners('error')
      resolvePromise(wss)
    })
    wss.once('error', (error: NodeJS.ErrnoException) => {
      wss.close()
      rejectPromise(error)
    })
  })
}

/** 启动桥。端口被占则从 9224 起递增重试；全失败只记日志，不影响主流程。 */
export async function startBrowserBridge(
  notify: (status: BrowserBridgeStatus) => void
): Promise<void> {
  notifyStatus = notify
  token = loadOrCreateToken()

  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = DEFAULT_PORT + i
    try {
      server = await tryListen(port)
      listeningPort = port
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || code === 'EACCES') continue
      log('browser-bridge', `启动失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }
  if (!server || listeningPort === null) {
    log('browser-bridge', `启动失败：${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_TRIES - 1} 端口全被占用`)
    return
  }

  // 端口确定后落盘配对信息（MCP server 子进程之后也从这个文件读端口+token）。
  try {
    writeJsonAtomic(tokenFilePath(), { token, port: listeningPort } satisfies PairingFile)
  } catch (error) {
    log('browser-bridge', `配对文件写入失败：${error instanceof Error ? error.message : String(error)}`)
  }

  server.on('connection', handleConnection)
  server.on('error', (error) => {
    log('browser-bridge', `服务错误：${error.message}`)
  })

  pingTimer = setInterval(pingExtension, PING_INTERVAL_MS)
  pingTimer.unref?.()

  log('browser-bridge', `listening on 127.0.0.1:${listeningPort}`)
  broadcastStatus()
}

export function stopBrowserBridge(): void {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  extensionSocket?.close()
  server?.close()
  server = null
  listeningPort = null
}

function handleConnection(socket: WebSocket): void {
  // 未握手连接限时：不发 hello 或 token 不对的一律断开。
  const handshakeTimer = setTimeout(() => socket.terminate(), HANDSHAKE_TIMEOUT_MS)

  const onHandshakeMessage = (data: RawData): void => {
    let msg: {
      type?: string
      token?: string
      role?: string
      nonce?: string
      extensionVersion?: string
      clientVersion?: string
      protocolVersion?: number
    }
    try {
      msg = JSON.parse(data.toString())
    } catch {
      clearTimeout(handshakeTimer)
      socket.terminate()
      return
    }

    // 端口重发现探测：扩展在扫描端口时先要求服务端证明自己知道 token
    //（HMAC(token, nonce)），验证通过才会发真正的 hello——避免把 token
    // 发给恰好占着端口的陌生本地进程。探测不消耗握手机会。
    if (msg.type === 'probe' && typeof msg.nonce === 'string' && token) {
      // proof 绑定服务端实际监听端口：中继攻击（占 9224 转发给真 Tran 的
      // 9225）拿到的是对 9225 的 proof，拨号方按 9224 校验会不匹配而识破。
      const proof = createHmac('sha256', token)
        .update(`${msg.nonce.slice(0, 128)}:${listeningPort}`)
        .digest('hex')
      socket.send(JSON.stringify({ type: 'probe_ok', proof }))
      socket.once('message', onHandshakeMessage)
      return
    }
    clearTimeout(handshakeTimer)
    if (msg.type !== 'hello' || typeof msg.token !== 'string' || msg.token !== token) {
      log('browser-bridge', 'rejected connection: bad token or malformed hello')
      socket.send(JSON.stringify({ type: 'error', code: 'bad_token', message: '配对码不对，请在 Tran 里重新复制' }))
      socket.close()
      return
    }
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      log('browser-bridge', `rejected connection: protocol ${msg.protocolVersion} != ${PROTOCOL_VERSION}`)
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'protocol_mismatch',
          message: '扩展与 Tran 版本不匹配，请重新加载扩展目录（chrome://extensions → 重新加载）'
        })
      )
      socket.close()
      return
    }

    // client 角色：MCP server 等本机调用方，把工具调用转发给扩展执行。
    // 不带 role 视为扩展（兼容 0.2.0 及更早的扩展）。
    if (msg.role === 'client') {
      socket.send(JSON.stringify({ type: 'hello_ok', tranVersion: app.getVersion() }))
      log('browser-bridge', `client connected (v${msg.clientVersion ?? '?'})`)
      socket.on('message', (raw: RawData) => handleClientMessage(socket, raw))
      socket.on('error', (error) => {
        log('browser-bridge', `client socket error: ${error.message}`)
      })
      return
    }

    // 只保留最新的扩展连接（Chrome 重启/SW 重启会产生新连接）。
    if (extensionSocket && extensionSocket !== socket) {
      extensionSocket.removeAllListeners('close')
      extensionSocket.close(4000, 'replaced by newer connection')
      failAllPending(new Error('扩展重新连接，进行中的调用已作废'))
    }
    extensionSocket = socket
    extensionVersion = msg.extensionVersion ?? null
    extensionLastSeen = Date.now()

    socket.send(JSON.stringify({ type: 'hello_ok', tranVersion: app.getVersion() }))
    log('browser-bridge', `extension connected (v${extensionVersion ?? '?'})`)
    broadcastStatus()

    socket.on('message', (raw: RawData) => handleExtensionMessage(raw))
    socket.on('close', () => {
      if (extensionSocket !== socket) return
      extensionSocket = null
      extensionVersion = null
      failAllPending(new Error('扩展连接已断开'))
      log('browser-bridge', 'extension disconnected')
      broadcastStatus()
    })
    socket.on('error', (error) => {
      log('browser-bridge', `extension socket error: ${error.message}`)
    })
  }
  socket.once('message', onHandshakeMessage)
}

/** client（MCP server 等）的工具调用：{id, tool, args} → 转发扩展 → 原样回结果。
 *  client 自己的 id 原样带回；与扩展侧的内部 id 空间互不相干。 */
function handleClientMessage(socket: WebSocket, raw: RawData): void {
  let msg: { type?: string; id?: string; tool?: string; args?: unknown }
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.type === 'pong') return
  if (typeof msg.id !== 'string' || typeof msg.tool !== 'string') return
  const id = msg.id
  callBrowserTool(msg.tool, msg.args)
    .then((result) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id, ok: true, result }))
      }
    })
    .catch((error: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
        )
      }
    })
}

function handleExtensionMessage(raw: RawData): void {
  extensionLastSeen = Date.now()
  let msg: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string }
  try {
    msg = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (msg.type === 'pong') return
  if (typeof msg.id === 'string') {
    const pending = pendingCalls.get(msg.id)
    if (!pending) return
    pendingCalls.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error || '扩展返回未知错误'))
  }
}

function pingExtension(): void {
  const socket = extensionSocket
  if (!socket) return
  if (Date.now() - extensionLastSeen > IDLE_TIMEOUT_MS) {
    log('browser-bridge', 'extension idle timeout, terminating connection')
    socket.terminate()
    return
  }
  try {
    socket.send(JSON.stringify({ type: 'ping' }))
  } catch {
    socket.terminate()
  }
}

function failAllPending(error: Error): void {
  for (const pending of pendingCalls.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingCalls.clear()
}

/** 把工具调用发给扩展执行。扩展未连接立即报错；30s 超时。 */
export function callBrowserTool(tool: string, args: unknown): Promise<unknown> {
  const socket = extensionSocket
  if (!socket) {
    return Promise.reject(new Error('浏览器扩展未连接：请确认 Chrome 已安装并配对 Tran 浏览器桥扩展'))
  }
  const id = String(nextCallId++)
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      rejectPromise(new Error(`浏览器工具 ${tool} 调用超时（30s）`))
    }, TOOL_TIMEOUT_MS)
    pendingCalls.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
    try {
      socket.send(JSON.stringify({ id, tool, args }))
    } catch (error) {
      pendingCalls.delete(id)
      clearTimeout(timer)
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
