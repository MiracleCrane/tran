/**
 * tran-browser：薄的 stdio MCP server，把 kimi 的浏览器工具调用转发给
 * Tran 主进程的 BrowserBridge（WS），再由 Chrome 扩展执行。
 *
 * 运行方式：作为 kimi 的子进程，用 Electron 以 ELECTRON_RUN_AS_NODE=1 跑
 * 打包出来的单文件 js（不 import electron，任何 Node ≥18 也能跑）。
 *
 * 协议：MCP stdio（newline-delimited JSON-RPC 2.0）。只实现
 * initialize / tools/list / tools/call / ping —— kimi 用到的最小面。
 *
 * 配置：环境变量 TRAN_BRIDGE_TOKEN_FILE 指向 Tran 的配对文件
 * （{token, port}），缺省取 %APPDATA%/Tran/browser-bridge-token.json。
 * 每次 tools/call 前按需连接 WS，断线下次调用自动重连。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

const SERVER_VERSION = '0.1.0'
const BRIDGE_PROTOCOL_VERSION = 1
const CONNECT_TIMEOUT_MS = 5000
const CALL_TIMEOUT_MS = 35_000

function logErr(message: string): void {
  process.stderr.write(`[tran-browser] ${message}\n`)
}

// ---------- 桥连接（WS client） ----------

interface Pairing {
  token: string
  port: number
}

function readPairing(): Pairing {
  const file =
    process.env['TRAN_BRIDGE_TOKEN_FILE'] ||
    join(process.env['APPDATA'] || '', 'Tran', 'browser-bridge-token.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`读不到 Tran 配对文件（${file}）。Tran 是否安装并至少启动过一次？`)
  }
  const parsed = JSON.parse(raw) as Partial<Pairing>
  if (typeof parsed.token !== 'string' || typeof parsed.port !== 'number') {
    throw new Error(`配对文件缺 token/port 字段（${file}）`)
  }
  return { token: parsed.token, port: parsed.port }
}

let bridge: WebSocket | null = null
let bridgeReady = false
let nextCallId = 1
const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function connectBridge(): Promise<void> {
  if (bridge && bridgeReady) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      rejectPromise(new Error(message))
    }
    let pairing: Pairing
    try {
      pairing = readPairing()
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}`)
    bridge = ws
    bridgeReady = false
    const connectTimer = setTimeout(
      () => fail(`连不上 Tran（127.0.0.1:${pairing.port}）。Tran 是否在运行？`),
      CONNECT_TIMEOUT_MS
    )

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          role: 'client',
          token: pairing.token,
          clientVersion: SERVER_VERSION,
          protocolVersion: BRIDGE_PROTOCOL_VERSION
        })
      )
    })
    ws.on('message', (data) => {
      let msg: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string; message?: string }
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (msg.type === 'hello_ok') {
        clearTimeout(connectTimer)
        bridgeReady = true
        if (!settled) {
          settled = true
          resolvePromise()
        }
        return
      }
      if (msg.type === 'error') {
        clearTimeout(connectTimer)
        fail(`Tran 拒绝连接：${msg.message || '未知原因'}`)
        ws.close()
        return
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }
      if (typeof msg.id === 'string') {
        const pending = pendingCalls.get(msg.id)
        if (!pending) return
        pendingCalls.delete(msg.id)
        if (msg.ok) pending.resolve(msg.result)
        else pending.reject(new Error(msg.error || 'Tran 返回未知错误'))
      }
    })
    ws.on('close', () => {
      if (bridge === ws) {
        bridge = null
        bridgeReady = false
      }
      clearTimeout(connectTimer)
      for (const pending of pendingCalls.values()) pending.reject(new Error('与 Tran 的连接已断开'))
      pendingCalls.clear()
      fail('与 Tran 的连接已断开')
    })
    ws.on('error', (error) => {
      clearTimeout(connectTimer)
      fail(`连接 Tran 失败：${error.message}（Tran 是否在运行？）`)
    })
  })
}

async function callBridgeTool(tool: string, args: unknown): Promise<unknown> {
  await connectBridge()
  const ws = bridge
  if (!ws || !bridgeReady) throw new Error('与 Tran 的连接不可用')
  const id = String(nextCallId++)
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      rejectPromise(new Error(`浏览器工具 ${tool} 超时（${CALL_TIMEOUT_MS / 1000}s）`))
    }, CALL_TIMEOUT_MS)
    pendingCalls.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolvePromise(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        rejectPromise(e)
      }
    })
    ws.send(JSON.stringify({ id, tool, args }))
  })
}

// ---------- MCP 工具定义 ----------

interface ToolDef {
  name: string
  bridgeTool: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: ToolDef[] = [
  {
    name: 'browser_tabs_list',
    bridgeTool: 'tabs_list',
    description: '列出用户 Chrome 里所有打开的标签页（id、标题、URL、是否活动）。操作具体标签页前先用它拿 tabId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_tab_open',
    bridgeTool: 'tab_open',
    description: '在用户 Chrome 里新开一个标签页并等待加载完成。只支持 http/https。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 http/https URL' },
        background: { type: 'boolean', description: 'true 则后台打开不抢焦点（默认前台）' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_tab_activate',
    bridgeTool: 'tab_activate',
    description: '把指定标签页切到前台并聚焦其窗口。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'tabs_list 返回的标签页 id' } },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_tab_close',
    bridgeTool: 'tab_close',
    description: '关闭指定标签页（必须显式给 tabId，防误关）。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number', description: 'tabs_list 返回的标签页 id' } },
      required: ['tabId'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_navigate',
    bridgeTool: 'navigate',
    description: '让某个标签页（缺省当前活动页）导航到指定 URL 并等待加载完成。只支持 http/https。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 http/https URL' },
        tabId: { type: 'number', description: '标签页 id，缺省用当前活动标签页' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_read_page',
    bridgeTool: 'read_page',
    description:
      '读取页面内容快照：标题、URL、正文文本、可交互元素列表（带 ref_N 编号）。这是了解页面当前状态的主要手段。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id，缺省用当前活动标签页' },
        maxChars: { type: 'number', description: '返回内容上限字符数（默认 30000）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_click',
    bridgeTool: 'click',
    description: '点击页面元素。优先用 browser_read_page 返回的 ref 编号定位，也可用 CSS selector。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'read_page 给出的 ref_N 编号（页面导航后失效，需重新 read_page）' },
        selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）' },
        tabId: { type: 'number', description: '标签页 id，缺省用当前活动标签页' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_type',
    bridgeTool: 'type',
    description: '向输入框/文本域输入文本（先清空原值），可选按回车提交。用 ref 或 CSS selector 定位。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文本' },
        ref: { type: 'number', description: 'read_page 给出的 ref_N 编号' },
        selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）' },
        submit: { type: 'boolean', description: 'true 则输入后按回车提交（默认 false）' },
        tabId: { type: 'number', description: '标签页 id，缺省用当前活动标签页' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_screenshot',
    bridgeTool: 'screenshot',
    description:
      '截取标签页当前可见区域（JPEG）。优先用 browser_read_page 读文本；只在需要看视觉布局/图片内容时用截图。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id，缺省用当前活动标签页（会被切到前台）' },
        quality: { type: 'number', description: 'JPEG 质量 1-100（默认 70）' }
      },
      additionalProperties: false
    }
  }
]

/** 工具结果 → MCP content。read_page 直接给快照文本（模型友好），其余给 JSON。 */
function formatResult(bridgeTool: string, result: unknown): string {
  if (bridgeTool === 'read_page' && result && typeof result === 'object' && 'snapshot' in result) {
    return String((result as { snapshot: unknown }).snapshot)
  }
  return JSON.stringify(result, null, 1)
}

/**
 * 截图结果 → MCP content。默认给 image 内容块；kimi 若消费不了图片
 * （K3 的 tool result 图片支持未验证），设 TRAN_SCREENSHOT_AS_FILE=1
 * 降级为写临时文件、返回路径文本。
 */
function screenshotContent(result: unknown): Array<Record<string, unknown>> {
  const shot = result as { base64?: string; mimeType?: string; tabId?: number; url?: string }
  if (!shot || typeof shot.base64 !== 'string') {
    return [{ type: 'text', text: '截图失败：扩展没有返回图像数据' }]
  }
  if (process.env['TRAN_SCREENSHOT_AS_FILE'] === '1') {
    const file = join(tmpdir(), `tran-browser-shot-${Date.now()}.jpg`)
    writeFileSync(file, Buffer.from(shot.base64, 'base64'))
    return [{ type: 'text', text: `截图已保存：${file}（页面 ${shot.url ?? ''}）` }]
  }
  return [
    { type: 'image', data: shot.base64, mimeType: shot.mimeType ?? 'image/jpeg' },
    { type: 'text', text: `截图来自标签页 ${shot.tabId ?? '?'}（${shot.url ?? ''}）` }
  ]
}

// ---------- MCP stdio 协议 ----------

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function sendResult(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleRequest(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null
  switch (req.method) {
    case 'initialize': {
      const requested = (req.params?.['protocolVersion'] as string) || '2024-11-05'
      sendResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'tran-browser', version: SERVER_VERSION }
      })
      return
    }
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      sendResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      })
      return
    case 'tools/call': {
      const name = req.params?.['name']
      const args = (req.params?.['arguments'] as Record<string, unknown>) ?? {}
      const tool = TOOLS.find((t) => t.name === name)
      if (!tool) {
        sendError(id, -32602, `未知工具: ${String(name)}`)
        return
      }
      try {
        const result = await callBridgeTool(tool.bridgeTool, args)
        if (tool.bridgeTool === 'screenshot') {
          sendResult(id, { content: screenshotContent(result) })
          return
        }
        sendResult(id, { content: [{ type: 'text', text: formatResult(tool.bridgeTool, result) }] })
      } catch (error) {
        // 工具执行失败按 MCP 惯例回 isError 内容，不用 JSON-RPC error
        //（后者会被部分客户端当协议故障处理）。
        sendResult(id, {
          content: [{ type: 'text', text: `失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        })
      }
      return
    }
    default:
      // notifications（无 id）按规范静默忽略；未知请求回 method not found。
      if (req.id !== undefined && req.id !== null) {
        sendError(id, -32601, `不支持的方法: ${req.method}`)
      }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req: JsonRpcRequest
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest
  } catch {
    logErr(`丢弃无法解析的输入行: ${trimmed.slice(0, 120)}`)
    return
  }
  void handleRequest(req).catch((error) => {
    logErr(`处理 ${req.method} 时异常: ${error instanceof Error ? error.message : String(error)}`)
    if (req.id !== undefined && req.id !== null) {
      sendError(req.id, -32603, '内部错误')
    }
  })
})
rl.on('close', () => {
  bridge?.close()
  process.exit(0)
})
logErr(`tran-browser MCP server v${SERVER_VERSION} 就绪（stdio）`)
