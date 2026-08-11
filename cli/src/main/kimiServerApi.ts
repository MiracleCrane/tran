import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { log } from './logger'
import { resolveWindowsKimiCommand } from './windowsKimi'
import { kimiHome, kimiSessionsRoot } from './kimiHome'

/**
 * kimi 本地 server（REST + WebSocket + web UI 后端）连接管理。
 *
 * 实证事实（kimi CLI 0.29.0）：
 * - 启动方式：`kimi web --no-open`（前台进程，约 2s 就绪；旧的 `kimi server
 *   run` 已移除，执行后打印 deprecated 提示立即退出）。Tran 持有 child 句柄，
 *   app quit 时终止整棵进程树。默认端口 58627。
 * - token 机制不变：$KIMI_CODE_HOME/server.token，Bearer 认证。
 * - 发现机制：$KIMI_CODE_HOME/server/instances/<server_id>.json 是 JSON {pid,
 *   host, port, started_at, heartbeat_at, host_version}（不再有 server/lock）。
 *   文件可能残留（pid 死了文件还在），发现时校验 pid 存活或 heartbeat 新鲜。
 * - tasks API：GET /api/v1/sessions/<sessionId>/tasks → {data:{items:[{id,
 *   session_id, kind: "bash"|"subagent", description, status, created_at,
 *   started_at, completed_at, command?}]}}。无分页（limit 参数被忽略，全量返回）。
 *   ⚠ #34 实证（0.29.0）：REST tasks 只覆盖 web server 自己托管会话的任务；
 *   Tran 走 `kimi acp` 启动的后台任务（子代理/后台 Bash）REST 永远返回空
 *   items。真相在磁盘，见 readDiskTasks。
 * - tasks/<id> 详情与列表项同形；没有子代理"最近动态"接口（web 卡片那行走
 *   WebSocket，REST 拿不到）——Tran 只渲染 description + status。
 *
 * 连接失败一律静默降级（返回 null），绝不影响聊天主链路。
 */

const PROBE_TIMEOUT_MS = 4000
const SERVER_BOOT_TIMEOUT_MS = 10000
const TASKS_TIMEOUT_MS = 8000
const DEFAULT_PORT = 58627
// instance 心跳新鲜度阈值：pid 校验不到（如跨权限/容器）时的兜底。
const HEARTBEAT_FRESH_MS = 60000

export interface KimiTaskInfo {
  id: string
  kind: string
  description?: string
  status?: string
  command?: string
  createdAt?: string
  startedAt?: string
  completedAt?: string
}

interface ServerHandle {
  baseUrl: string
  token: string
}

function tokenPath(): string {
  return join(kimiHome(), 'server.token')
}

function readToken(): string | null {
  try {
    const token = readFileSync(tokenPath(), 'utf8').trim()
    return token || null
  } catch {
    return null
  }
}

function instancesDir(): string {
  return join(kimiHome(), 'server', 'instances')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** instances/*.json 的 started_at/heartbeat_at 实际是 epoch ms 数字（#26），
 *  兼容数字与 ISO 字符串两种形态；解析不出返回 NaN。 */
function parseInstanceTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return Date.parse(value)
  return NaN
}

/** 从 server/instances/ 发现一个活着的实例（pid 存活或 heartbeat 新鲜），取最新；
 *  拿不到返回 null（调用方回退默认端口）。instances 文件可能残留，必须校验。 */
function discoverInstance(): { host: string; port: number } | null {
  let files: string[]
  try {
    files = readdirSync(instancesDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  let best: { host: string; port: number; startedAt: number } | null = null
  for (const file of files) {
    try {
      const inst = JSON.parse(readFileSync(join(instancesDir(), file), 'utf8')) as {
        pid?: unknown
        host?: unknown
        port?: unknown
        started_at?: unknown
        heartbeat_at?: unknown
      }
      if (typeof inst.port !== 'number' || inst.port <= 0) continue
      const alive = typeof inst.pid === 'number' && pidAlive(inst.pid)
      const heartbeat = parseInstanceTime(inst.heartbeat_at)
      const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat < HEARTBEAT_FRESH_MS
      if (!alive && !fresh) continue
      // 监听 0.0.0.0/:: 时连接走回环。
      const rawHost = typeof inst.host === 'string' ? inst.host : ''
      const host = rawHost && rawHost !== '0.0.0.0' && rawHost !== '::' ? rawHost : '127.0.0.1'
      const startedAt = parseInstanceTime(inst.started_at) || 0
      if (!best || startedAt > best.startedAt) best = { host, port: inst.port, startedAt }
    } catch {
      /* 单个文件损坏 → 跳过 */
    }
  }
  return best
}

async function probe(baseUrl: string, token: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

let cachedHandle: ServerHandle | null = null
let spawnPromise: Promise<ServerHandle | null> | null = null
let serverChild: ChildProcess | null = null

/** 终止 Tran 拉起的 kimi web（整棵进程树；Windows 上 cmd.exe 包裹 kill 不到子进程）。 */
function killServerChild(): void {
  const child = serverChild
  serverChild = null
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      // 'error' 事件必须挂监听：spawn 失败是异步事件，外层 try/catch 抓不到，
      // 没监听器会直接掀掉主进程。
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => { /* 退出路径尽力而为 */ })
      killer.unref()
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* 退出路径尽力而为 */
  }
}

app.once('before-quit', killServerChild)

/** 拉起 kimi web（前台进程，持有句柄；捕获早期输出识别 deprecated/错误直接判死，
 *  靠 instances 发现 + 轮询 probe 判活）。 */
async function spawnServer(): Promise<ServerHandle | null> {
  const token = readToken()
  if (!token) {
    log('kimi-server', 'no server.token, cannot start/probe server')
    return null
  }
  let child: ChildProcess
  let earlyOutput = ''
  let exited = false
  try {
    const resolved = await resolveWindowsKimiCommand()
    log('kimi-server', `spawning kimi web --no-open (${resolved.displayPath})`)
    child = spawn(resolved.command, [...resolved.argsPrefix, 'web', '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    serverChild = child
    const onData = (chunk: Buffer): void => {
      earlyOutput = (earlyOutput + chunk.toString('utf8')).slice(-4096)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', () => {
      exited = true
      if (serverChild === child) serverChild = null
    })
    child.on('error', () => {
      exited = true
      if (serverChild === child) serverChild = null
    })
  } catch (error) {
    log('kimi-server', `spawn failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  // server 起来需要一两秒：轮询 instances 发现 + probe 直到可用或超时。
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    // 进程已退出（如旧版 CLI 打 deprecated 提示即退）或明确报错：直接判死。
    // 收紧匹配：原来的 /error/i 会命中任何含 "error" 的输出（"0 errors"、
    // 带 error 字样的警告、URL 里的 error 路径），把已经起来的 server 误杀。
    // 只认真正表示启动失败的形态。
    if (exited || /deprecat|unknown command|command not found|fatal error|panic:|EADDRINUSE|error:/i.test(earlyOutput)) {
      log(
        'kimi-server',
        `kimi web died at boot: ${earlyOutput.trim().split(/\r?\n/).slice(-3).join(' | ') || '(no output)'}`
      )
      killServerChild()
      return null
    }
    const inst = discoverInstance()
    const handle = {
      baseUrl: `http://${inst?.host ?? '127.0.0.1'}:${inst?.port ?? DEFAULT_PORT}`,
      token
    }
    if (await probe(handle.baseUrl, handle.token)) return handle
  }
  log('kimi-server', 'server did not come up in time')
  killServerChild()
  return null
}

/**
 * 拉起失败后的冷却期（#25）。
 *
 * 此前这里没有任何失败记忆：每次调用都是 probe → 失败 → spawnServer()，
 * 而 spawnServer 要等满 SERVER_BOOT_TIMEOUT_MS 才判死。调用方
 * getSessionTasks 每 2~15s 轮询一次，于是 server 起不来时就变成
 * 「每十几秒拉起一次 kimi web」的死循环。
 *
 * ipc.ts 里那套 15s→60s→5min 的退避对此无效：#34 加入磁盘任务回退后，
 * getSessionTasks 即使 server 挂着也会返回非 null（磁盘有记录），
 * swarmFailures 永远清零，退避阶梯根本不会启动。
 */
const SPAWN_COOLDOWN_MS = 5 * 60 * 1000
let spawnFailedAt = 0
/** 探测成功的 TTL：前台会话有任务在跑时 getSessionTasks 每 2s 轮询一次，
 *  不缓存等于每 2s 一次 instances 全量读 + HTTP 探测。窗口内 server 死掉的话
 *  调用方请求会失败，下个窗口重新探测，自愈。 */
const PROBE_OK_TTL_MS = 10_000
let lastProbeOkAt = 0

/** 拿可用的 server 句柄：先探测现有实例（instances 发现，回退默认端口），不行就自己拉起一次。 */
export async function ensureKimiServer(): Promise<ServerHandle | null> {
  const token = readToken()
  if (!token) return null
  if (cachedHandle && Date.now() - lastProbeOkAt < PROBE_OK_TTL_MS) return cachedHandle
  const inst = discoverInstance()
  const baseUrl = `http://${inst?.host ?? '127.0.0.1'}:${inst?.port ?? DEFAULT_PORT}`
  if (await probe(baseUrl, token)) {
    cachedHandle = { baseUrl, token }
    spawnFailedAt = 0
    lastProbeOkAt = Date.now()
    return cachedHandle
  }
  if (cachedHandle && (await probe(cachedHandle.baseUrl, cachedHandle.token))) {
    spawnFailedAt = 0
    lastProbeOkAt = Date.now()
    return cachedHandle
  }
  // 冷却期内不再尝试拉起：探测已经做过了（上面两步），server 真起来了会
  // 被探测命中，这里只挡住反复 spawn。
  if (spawnFailedAt > 0 && Date.now() - spawnFailedAt < SPAWN_COOLDOWN_MS) {
    return null
  }
  if (!spawnPromise) {
    spawnPromise = spawnServer().finally(() => {
      spawnPromise = null
    })
  }
  const handle = await spawnPromise
  if (handle) {
    cachedHandle = handle
    spawnFailedAt = 0
    lastProbeOkAt = Date.now()
  } else {
    spawnFailedAt = Date.now()
    log('kimi-server', `拉起失败，${SPAWN_COOLDOWN_MS / 60000} 分钟内不再重试`)
  }
  return handle
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** #34 磁盘数据源：ACP 主代理把后台任务记录实时写在
 *  $KIMI_CODE_HOME/sessions/<workspace>/<sessionId>/agents/main/tasks/<taskId>.json
 *  形态 {taskId, kind: "agent"|"process", status: running|completed|failed|
 *  killed|lost, description, command?, startedAt, endedAt(epoch ms, 未完为 null)}。
 *  taskId 与 launch ack 文本里的 task_id 同空间（实证一致）。REST 查不到这些
 *  任务，所以磁盘是主数据源；server 挂了也照读。找不到会话目录返回 []。 */
function readDiskTasks(sessionId: string): KimiTaskInfo[] {
  // sessionId 拼路径，先挡目录穿越。
  if (!/^[\w-]+$/.test(sessionId)) return []
  const base = kimiSessionsRoot()
  let workspaces: string[]
  try {
    workspaces = readdirSync(base)
  } catch {
    return []
  }
  for (const ws of workspaces) {
    const tasksDir = join(base, ws, sessionId, 'agents', 'main', 'tasks')
    let files: string[]
    try {
      files = readdirSync(tasksDir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    const tasks: KimiTaskInfo[] = []
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(tasksDir, file), 'utf8')) as Record<string, unknown>
        const id = asString(raw.taskId)
        if (!id) continue
        // 磁盘词表 → REST 词表（渲染层按 subagent/bash 分类、stopped/failed 展示）。
        const rawKind = asString(raw.kind)
        const kind = rawKind === 'agent' ? 'subagent' : rawKind === 'process' ? 'bash' : rawKind
        if (!kind) continue
        const rawStatus = asString(raw.status)
        const status =
          rawStatus === 'killed' ? 'stopped' : rawStatus === 'lost' ? 'failed' : rawStatus
        const startedMs = typeof raw.startedAt === 'number' ? raw.startedAt : NaN
        const endedMs = typeof raw.endedAt === 'number' ? raw.endedAt : NaN
        tasks.push({
          id,
          kind,
          ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
          ...(status ? { status } : {}),
          ...(asString(raw.command) ? { command: asString(raw.command) } : {}),
          ...(Number.isFinite(startedMs) ? { startedAt: new Date(startedMs).toISOString() } : {}),
          ...(Number.isFinite(endedMs) ? { completedAt: new Date(endedMs).toISOString() } : {})
        })
      } catch {
        /* 单个文件损坏/写入中 → 跳过 */
      }
    }
    return tasks
  }
  return []
}

/** 该会话是否有仍在跑的后台任务（磁盘同步查，几次 readdir 的量级）。
 *  隐藏轮（/usage、/mcp、待办催更）开跑前的守卫用：后台任务完成时 kimi 会把
 *  通知 steer 进**当时活跃的 turn**——若那恰是隐藏轮，整段唤醒内容会被
 *  hiddenTurn 标志吞掉（用户看到的就是"跑完了也没反应"）。有任务在跑就
 *  别开隐藏轮，把 steer 的落点让给正常空闲态。 */
export function hasRunningDiskTasks(sessionId: string): boolean {
  return readDiskTasks(sessionId).some((t) => (t.status ?? '').toLowerCase() === 'running')
}

/** 拉取某会话的全部 tasks：REST（web server 托管任务）+ 磁盘（ACP 后台任务，
 *  #34）按 id 合并，REST 优先。server 不可用且无磁盘记录时返回 null（降级）。 */
export async function getSessionTasks(sessionId: string): Promise<KimiTaskInfo[] | null> {
  const handle = await ensureKimiServer()
  const disk = readDiskTasks(sessionId)
  if (!handle) return disk.length > 0 ? disk : null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TASKS_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${handle.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      { headers: { authorization: `Bearer ${handle.token}` }, signal: controller.signal }
    )
    if (!response.ok) {
      // token 失效（可能被 rotate）：清缓存下次重探测。
      if (response.status === 401 || response.status === 403) cachedHandle = null
      return disk.length > 0 ? disk : null
    }
    const payload = (await response.json()) as unknown
    const items = asRecord(asRecord(payload)?.data)?.items
    if (!Array.isArray(items)) return disk
    const tasks: KimiTaskInfo[] = []
    for (const raw of items) {
      const entry = asRecord(raw)
      const id = asString(entry?.id)
      const kind = asString(entry?.kind)
      if (!id || !kind) continue
      tasks.push({
        id,
        kind,
        ...(asString(entry?.description) ? { description: asString(entry?.description) } : {}),
        ...(asString(entry?.status) ? { status: asString(entry?.status) } : {}),
        ...(asString(entry?.command) ? { command: asString(entry?.command) } : {}),
        ...(asString(entry?.created_at) ? { createdAt: asString(entry?.created_at) } : {}),
        ...(asString(entry?.started_at) ? { startedAt: asString(entry?.started_at) } : {}),
        ...(asString(entry?.completed_at) ? { completedAt: asString(entry?.completed_at) } : {})
      })
    }
    const restIds = new Set(tasks.map((t) => t.id))
    return [...tasks, ...disk.filter((t) => !restIds.has(t.id))]
  } catch {
    return disk.length > 0 ? disk : null
  } finally {
    clearTimeout(timer)
  }
}
