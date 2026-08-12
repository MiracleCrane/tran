/**
 * tran-desktop：Windows 桌面控制 MCP server（Codex 式 computer-use）。
 *
 * 与浏览器控制不同，这里不需要任何外部组件：本进程（ELECTRON_RUN_AS_NODE）
 * 就有完整用户权限，所有操作经 PowerShell + Win32 P/Invoke 完成——
 * 截屏 CopyFromScreen、鼠标 SetCursorPos/mouse_event、键盘 keybd_event、
 * 文本输入走剪贴板粘贴（完整支持中文，且保存/恢复用户剪贴板）、
 * 窗口枚举/聚焦 EnumWindows/SetForegroundWindow、UIA 无障碍树做
 * 桌面版 read_page（带元素中心坐标，模型可以不看图直接点）。
 *
 * PowerShell 代码全部 ASCII（PS 5.1 + GBK 控制台的 ParserError 坑），经
 * -EncodedCommand（UTF-16LE base64）传入，杜绝转义/编码问题；参数经环境
 * 变量传递；输出以 TRANJSON: 前缀行回传（屏蔽 Add-Type 等杂散输出）。
 *
 * 协议：MCP stdio（newline-delimited JSON-RPC 2.0），与 mcp-browser 同构。
 */
import { execFile } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const SERVER_VERSION = '0.1.0'
const PS_TIMEOUT_MS = 30_000

function logErr(message: string): void {
  process.stderr.write(`[tran-desktop] ${message}\n`)
}

// ---------- PowerShell 执行 ----------

function runPs(script: string, env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const full = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    script
  ].join('\n')
  const encoded = Buffer.from(full, 'utf16le').toString('base64')
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const line = String(stdout).split(/\r?\n/).find((l) => l.startsWith('TRANJSON:'))
        if (line) {
          try {
            resolvePromise(JSON.parse(line.slice('TRANJSON:'.length)) as Record<string, unknown>)
            return
          } catch {
            /* fallthrough */
          }
        }
        if (error) {
          rejectPromise(new Error(`PowerShell 执行失败：${String(stderr || error.message).slice(0, 400)}`))
          return
        }
        rejectPromise(new Error(`PowerShell 没有返回结果（stdout: ${String(stdout).slice(0, 200)}）`))
      }
    )
  })
}

/** 通用 user32 P/Invoke 定义（各脚本按需引用）。全 ASCII。 */
const CS_USER32 = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class TranU32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
}
'@
[void][TranU32]::SetProcessDPIAware()
`

// ---------- 各工具的 PS 实现 ----------

async function psScreenshot(): Promise<{ file: string; width: number; height: number }> {
  const file = join(tmpdir(), `tran-desktop-shot-${Date.now()}.jpg`)
  const r = await runPs(
    CS_USER32 + `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]72)
$bmp.Save($env:TRAN_SHOT_FILE, $enc, $p)
$g.Dispose(); $bmp.Dispose()
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ width = $vs.Width; height = $vs.Height; left = $vs.Left; top = $vs.Top } -Compress))
`,
    { TRAN_SHOT_FILE: file }
  )
  return { file, width: Number(r['width']), height: Number(r['height']) }
}

function psListWindows(): Promise<Record<string, unknown>> {
  return runPs(
    CS_USER32 + `
$fg = [TranU32]::GetForegroundWindow()
$list = New-Object System.Collections.ArrayList
$cb = [TranU32+EnumProc]{ param($h, $l)
  if (-not [TranU32]::IsWindowVisible($h)) { return $true }
  $len = [TranU32]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][TranU32]::GetWindowText($h, $sb, $sb.Capacity)
  $rect = New-Object TranU32+RECT
  [void][TranU32]::GetWindowRect($h, [ref]$rect)
  if (($rect.R - $rect.L) -lt 50 -or ($rect.B - $rect.T) -lt 50) { return $true }
  $procId = [uint32]0
  [void][TranU32]::GetWindowThreadProcessId($h, [ref]$procId)
  [void]$list.Add(@{ hwnd = $h.ToInt64(); title = $sb.ToString(); pid = $procId
    x = $rect.L; y = $rect.T; width = $rect.R - $rect.L; height = $rect.B - $rect.T
    focused = ($h -eq $fg); minimized = [TranU32]::IsIconic($h) })
  return $true
}
[void][TranU32]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ windows = $list } -Depth 4 -Compress))
`
  )
}

function psFocusWindow(hwnd: number): Promise<Record<string, unknown>> {
  return runPs(
    CS_USER32 + `
$h = [IntPtr][long]$env:TRAN_HWND
if ([TranU32]::IsIconic($h)) { [void][TranU32]::ShowWindow($h, 9) }
# 防抢焦点策略会让后台进程的 SetForegroundWindow 静默失败（只闪任务栏）。
# 标准解法：先合成一次 Alt 按键（让系统认为本进程有键盘输入），再置前。
[TranU32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[void][TranU32]::SetForegroundWindow($h)
[TranU32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
if ([TranU32]::GetForegroundWindow() -ne $h) {
  [void][TranU32]::ShowWindow($h, 5)
  [void][TranU32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 200
}
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ focused = ([TranU32]::GetForegroundWindow() -eq $h) } -Compress))
`,
    { TRAN_HWND: String(hwnd) }
  )
}

function psClick(x: number, y: number, button: string): Promise<Record<string, unknown>> {
  return runPs(
    CS_USER32 + `
$x = [int]$env:TRAN_X; $y = [int]$env:TRAN_Y
[void][TranU32]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 60
switch ($env:TRAN_BTN) {
  'right' { [TranU32]::mouse_event(0x8, 0, 0, 0, [UIntPtr]::Zero); [TranU32]::mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero) }
  'double' {
    [TranU32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [TranU32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [TranU32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [TranU32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  }
  default { [TranU32]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); [TranU32]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero) }
}
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ clicked = $env:TRAN_BTN; x = $x; y = $y } -Compress))
`,
    { TRAN_X: String(Math.round(x)), TRAN_Y: String(Math.round(y)), TRAN_BTN: button }
  )
}

function psType(text: string, enter: boolean): Promise<Record<string, unknown>> {
  // SendInput + KEYEVENTF_UNICODE 逐字符注入（文本经环境变量传入免转义）。
  // 不走剪贴板（会被剪贴板同步类软件抢）、不经 IME（中文输入法会把字母
  // 拦成组词候选）——实测这两类干扰都真实存在。
  return runPs(
    CS_USER32 + `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TranSend {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  // union 必须把 MOUSEINPUT 包含进来：x64 上 INPUT 总大小 40（4+pad4+32），
  // 只放 KEYBDINPUT 会得到 32，SendInput 校验 cbSize 不符直接拒收（返回 0）。
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static uint SendUnicodeChar(char c) {
    INPUT[] arr = new INPUT[2];
    arr[0].type = 1; arr[0].U.ki.wScan = (ushort)c; arr[0].U.ki.dwFlags = 0x4;
    arr[1].type = 1; arr[1].U.ki.wScan = (ushort)c; arr[1].U.ki.dwFlags = 0x4 | 0x2;
    return SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendVk(ushort vk) {
    INPUT[] arr = new INPUT[2];
    arr[0].type = 1; arr[0].U.ki.wVk = vk;
    arr[1].type = 1; arr[1].U.ki.wVk = vk; arr[1].U.ki.dwFlags = 0x2;
    return SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$sent = 0
foreach ($ch in $env:TRAN_TEXT.ToCharArray()) {
  if ($ch -eq "\`n") { [void][TranSend]::SendVk(0x0D) }
  elseif ($ch -ne "\`r") { [void][TranSend]::SendUnicodeChar($ch) }
  $sent++
  Start-Sleep -Milliseconds 8
}
if ($env:TRAN_ENTER -eq '1') {
  Start-Sleep -Milliseconds 120
  [void][TranSend]::SendVk(0x0D)
}
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ typed = $sent; entered = ($env:TRAN_ENTER -eq '1') } -Compress))
`,
    { TRAN_TEXT: text, TRAN_ENTER: enter ? '1' : '0' }
  )
}

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b
}
function vkOf(key: string): number {
  const k = key.trim().toLowerCase()
  if (k in VK) return VK[k]
  if (/^[a-z]$/.test(k)) return k.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(k)) return k.charCodeAt(0)
  throw new Error(`不认识的按键: ${key}`)
}

function psKey(combo: string): Promise<Record<string, unknown>> {
  const parts = combo.split('+').map(vkOf)
  if (parts.length === 0 || parts.length > 4) throw new Error('组合键需要 1-4 个键')
  const codes = parts.join(',')
  return runPs(
    CS_USER32 + `
$codes = $env:TRAN_KEYS -split ',' | ForEach-Object { [byte][int]$_ }
foreach ($c in $codes) { [TranU32]::keybd_event($c, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25 }
[array]::Reverse($codes)
foreach ($c in $codes) { [TranU32]::keybd_event($c, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25 }
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ pressed = $env:TRAN_KEYS } -Compress))
`,
    { TRAN_KEYS: codes }
  )
}

function psReadWindow(hwnd: number | null): Promise<Record<string, unknown>> {
  // UIA 树 → 文本快照（带元素中心坐标）。hwnd 缺省用前台窗口。
  return runPs(
    CS_USER32 + `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$h = if ($env:TRAN_HWND) { [IntPtr][long]$env:TRAN_HWND } else { [TranU32]::GetForegroundWindow() }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$lines = New-Object System.Collections.ArrayList
$queue = New-Object System.Collections.Queue
$queue.Enqueue(@($root, 0))
$count = 0
while ($queue.Count -gt 0 -and $count -lt 400) {
  $pair = $queue.Dequeue()
  $el = $pair[0]; $depth = $pair[1]
  $count++
  try {
    $name = $el.Current.Name
    $type = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
    $r = $el.Current.BoundingRectangle
    $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
    if ($name -and $name.Length -gt 0 -and $r.Width -gt 0) {
      if ($name.Length -gt 80) { $name = $name.Substring(0, 80) }
      [void]$lines.Add(('  ' * [Math]::Min($depth, 8)) + '[' + $type + '] "' + $name + '" @(' + $cx + ',' + $cy + ')')
    }
    if ($depth -lt 12) {
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null) {
        $queue.Enqueue(@($child, $depth + 1))
        $child = $walker.GetNextSibling($child)
      }
    }
  } catch {}
}
$title = ''
try { $title = $root.Current.Name } catch {}
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ title = $title; nodeCount = $count; tree = ($lines -join [char]10) } -Compress))
`,
    { TRAN_HWND: hwnd === null ? '' : String(hwnd) }
  )
}

// ---------- MCP 工具定义 ----------

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

const textContent = (obj: unknown): Array<Record<string, unknown>> => [
  { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }
]

const TOOLS: ToolDef[] = [
  {
    name: 'desktop_screenshot',
    description:
      '截取整个屏幕（虚拟桌面）为 JPEG。返回图像与屏幕尺寸；图中坐标 = desktop_click 可直接使用的坐标。优先用 desktop_read_window 的文本树定位，需要看视觉布局时才截图。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const shot = await psScreenshot()
      const base64 = readFileSync(shot.file).toString('base64')
      try { unlinkSync(shot.file) } catch { /* ignore */ }
      return [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
        { type: 'text', text: `屏幕 ${shot.width}x${shot.height}，图中像素坐标可直接用于 desktop_click。` }
      ]
    }
  },
  {
    name: 'desktop_list_windows',
    description: '列出所有可见窗口（hwnd、标题、位置尺寸、是否前台/最小化）。操作某窗口前先用它拿 hwnd。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => textContent(await psListWindows())
  },
  {
    name: 'desktop_focus_window',
    description: '把指定窗口带到前台（最小化则先还原）。键鼠操作只作用于前台窗口，操作前必须先聚焦。',
    inputSchema: {
      type: 'object',
      properties: { hwnd: { type: 'number', description: 'desktop_list_windows 返回的窗口句柄' } },
      required: ['hwnd'],
      additionalProperties: false
    },
    run: async (a) => textContent(await psFocusWindow(Number(a['hwnd'])))
  },
  {
    name: 'desktop_read_window',
    description:
      '读取窗口的 UI 自动化树（控件类型、文本、中心坐标），桌面版 read_page。拿到坐标即可 desktop_click，通常不需要截图。缺省读前台窗口。',
    inputSchema: {
      type: 'object',
      properties: { hwnd: { type: 'number', description: '窗口句柄，缺省用前台窗口' } },
      additionalProperties: false
    },
    run: async (a) => {
      const r = await psReadWindow(typeof a['hwnd'] === 'number' ? Number(a['hwnd']) : null)
      return textContent(`[窗口] ${String(r['title'])}（${String(r['nodeCount'])} 节点）\n${String(r['tree'])}`)
    }
  },
  {
    name: 'desktop_click',
    description: '在屏幕坐标处点击鼠标（left/right/double）。坐标来自 desktop_read_window 或 desktop_screenshot。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'double'], description: '默认 left' }
      },
      required: ['x', 'y'],
      additionalProperties: false
    },
    run: async (a) => textContent(await psClick(Number(a['x']), Number(a['y']), String(a['button'] ?? 'left')))
  },
  {
    name: 'desktop_type',
    description: '向当前焦点处输入文本（剪贴板粘贴，完整支持中文；会自动恢复用户剪贴板），可选按回车。先点击目标输入框再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        enter: { type: 'boolean', description: 'true 则输入后按回车' }
      },
      required: ['text'],
      additionalProperties: false
    },
    run: async (a) => textContent(await psType(String(a['text'] ?? ''), a['enter'] === true))
  },
  {
    name: 'desktop_key',
    description:
      '按组合键，如 "ctrl+c"、"alt+tab"、"ctrl+shift+esc"、"enter"、"f5"。作用于前台窗口。注意：单独的字母键会被中文输入法拦成组词候选，输入文本请一律用 desktop_type。',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string', description: '用 + 连接的组合键（1-4 个键）' } },
      required: ['keys'],
      additionalProperties: false
    },
    run: async (a) => textContent(await psKey(String(a['keys'] ?? '')))
  }
]

// ---------- MCP stdio 协议（与 mcp-browser 同构） ----------

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
  if ((req.id === undefined || req.id === null) && !req.method.startsWith('notifications/')) {
    return
  }
  switch (req.method) {
    case 'initialize': {
      const requested = (req.params?.['protocolVersion'] as string) || '2024-11-05'
      sendResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'tran-desktop', version: SERVER_VERSION }
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
        sendResult(id, { content: await tool.run(args) })
      } catch (error) {
        sendResult(id, {
          content: [{ type: 'text', text: `失败：${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        })
      }
      return
    }
    default:
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
    logErr(`处理 ${req.method} 异常: ${error instanceof Error ? error.message : String(error)}`)
    if (req.id !== undefined && req.id !== null) sendError(req.id, -32603, '内部错误')
  })
})
rl.on('close', () => process.exit(0))
logErr(`tran-desktop MCP server v${SERVER_VERSION} 就绪（stdio）`)
