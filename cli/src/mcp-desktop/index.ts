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
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import WebSocket from 'ws'

const SERVER_VERSION = '0.3.0'
const PS_TIMEOUT_MS = 30_000

function logErr(message: string): void {
  process.stderr.write(`[tran-desktop] ${message}\n`)
}

// ---------- 活动上报（#67 屏幕光晕） ----------

/**
 * 每次工具调用往 Tran 报一声，好让「AI 控制中」的紫色光晕亮起来。
 * 复用浏览器桥的 client 通道（probe-first 握手同一套）。连不上就算了——
 * 光晕是提示，不能因为它失败而让桌面工具不可用。
 */
let bridge: WebSocket | null = null
let bridgeReady = false
let connecting = false

function bridgePairing(): { token: string; port: number } | null {
  const file =
    process.env['TRAN_BRIDGE_TOKEN_FILE'] ||
    join(process.env['APPDATA'] || '', 'Tran', 'browser-bridge-token.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: string; port?: number }
    if (typeof parsed.token === 'string' && typeof parsed.port === 'number') {
      return { token: parsed.token, port: parsed.port }
    }
  } catch {
    /* 没配对文件 = Tran 没装/没启动过，静默跳过 */
  }
  return null
}

function connectBridge(): void {
  if (bridgeReady || connecting) return
  const pairing = bridgePairing()
  if (!pairing) return
  connecting = true
  let ws: WebSocket
  try {
    ws = new WebSocket(`ws://127.0.0.1:${pairing.port}`)
  } catch {
    connecting = false
    return
  }
  const nonce = randomUUID()
  const done = (): void => {
    connecting = false
  }
  ws.on('open', () => ws.send(JSON.stringify({ type: 'probe', nonce })))
  ws.on('message', (data) => {
    let msg: { type?: string; proof?: string }
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (msg.type === 'probe_ok') {
      const expected = createHmac('sha256', pairing.token)
        .update(`${nonce}:${pairing.port}`)
        .digest('hex')
      if (msg.proof !== expected) {
        ws.close()
        done()
        return
      }
      ws.send(
        JSON.stringify({
          type: 'hello',
          role: 'client',
          token: pairing.token,
          clientVersion: SERVER_VERSION,
          protocolVersion: 1
        })
      )
      return
    }
    if (msg.type === 'hello_ok') {
      bridge = ws
      bridgeReady = true
      done()
      return
    }
    if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
  })
  ws.on('close', () => {
    if (bridge === ws) bridge = null
    bridgeReady = false
    done()
  })
  ws.on('error', () => {
    bridgeReady = false
    done()
  })
}

function reportActivity(label: string): void {
  if (!bridgeReady || !bridge) {
    connectBridge()
    return
  }
  try {
    bridge.send(JSON.stringify({ type: 'activity', label }))
  } catch {
    bridgeReady = false
  }
}

// ---------- 分屏控制（把 AI 关在一块屏里） ----------

/**
 * TRAN_DESKTOP_DISPLAY：允许 AI 操作的显示器序号（desktop_list_displays 的
 * index）。设了就是「分屏控制」——截图只截这块屏，点击越界直接拒绝，用户在
 * 另一块屏上继续干自己的活，互不干扰。没设 = 整个虚拟桌面都可操作。
 */
function targetDisplayIndex(): number | null {
  const raw = process.env['TRAN_DESKTOP_DISPLAY']
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

interface DisplayBounds {
  index: number
  x: number
  y: number
  width: number
  height: number
  primary: boolean
}

let displayCache: DisplayBounds[] | null = null
let displayCacheAt = 0
/** 显示器拓扑会在会话中途变（插拔扩展坞、切投影、改缩放）。永久缓存会让分屏
 *  的越界判定拿着旧坐标算——AI 以为在自己那块屏上点，其实点到用户屏上了。 */
const DISPLAY_CACHE_MS = 15_000

async function listDisplays(): Promise<DisplayBounds[]> {
  if (displayCache && Date.now() - displayCacheAt < DISPLAY_CACHE_MS) return displayCache
  const r = await runPs(
    CS_USER32 + `
Add-Type -AssemblyName System.Windows.Forms
$list = New-Object System.Collections.ArrayList
$i = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  # 各屏真实缩放：混合 DPI 下这决定了截图里的元素有多大，模型据此判断点击精度。
  $pt = New-Object TranU32+POINT
  $pt.X = $b.X + [int]($b.Width / 2); $pt.Y = $b.Y + [int]($b.Height / 2)
  $dx = 0; $dy = 0
  try { [void][TranU32]::GetDpiForMonitor([TranU32]::MonitorFromPoint($pt, 2), 0, [ref]$dx, [ref]$dy) } catch { $dx = 96 }
  if ($dx -le 0) { $dx = 96 }
  [void]$list.Add(@{ index = $i; x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height
    primary = $s.Primary; dpi = $dx; scalePercent = [math]::Round($dx / 96.0 * 100) })
  $i++
}
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ displays = $list } -Depth 4 -Compress))
`
  )
  const raw = r['displays']
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : []
  displayCache = arr.map((d) => d as unknown as DisplayBounds)
  displayCacheAt = Date.now()
  return displayCache
}

/** 分屏模式下的可操作区域；未限制时返回 null。 */
async function allowedBounds(): Promise<DisplayBounds | null> {
  const idx = targetDisplayIndex()
  if (idx === null) return null
  const displays = await listDisplays()
  const target = displays.find((d) => d.index === idx)
  if (!target) {
    throw new Error(`分屏控制指定了显示器 ${idx}，但系统只有 ${displays.length} 块屏幕（编号 0-${displays.length - 1}）`)
  }
  return target
}

/** 坐标必须落在划给 AI 的那块屏里——越界就是要去动用户正在用的屏幕。 */
function assertInBounds(b: DisplayBounds | null, x: number, y: number): void {
  if (!b) return
  if (x < b.x || x >= b.x + b.width || y < b.y || y >= b.y + b.height) {
    throw new Error(
      `坐标 (${x}, ${y}) 不在划给 AI 的显示器 ${b.index} 内` +
        `（范围 x ${b.x}~${b.x + b.width}, y ${b.y}~${b.y + b.height}）。` +
        '分屏控制模式下只能操作这块屏幕。'
    )
  }
}

/**
 * 分屏模式下的键盘守卫。
 *
 * 键盘输入没有坐标，一律打给**前台窗口**——而前台窗口是用户随手一点就会换的。
 * 只守 click/focus 的话有个明显的漏法：用户在自己那块屏上点了下别的程序，
 * 紧接着 AI 调 desktop_type，字就敲进用户正在用的窗口里了。所以键入前必须
 * 现查一次前台窗口在哪块屏。
 */
async function assertForegroundInBounds(action: string): Promise<void> {
  const bounds = await allowedBounds()
  if (!bounds) return
  const r = await runPs(
    CS_USER32 + `
$h = [TranU32]::GetForegroundWindow()
$rect = New-Object TranU32+RECT
[void][TranU32]::GetWindowRect($h, [ref]$rect)
$sb = New-Object System.Text.StringBuilder 260
[void][TranU32]::GetWindowText($h, $sb, $sb.Capacity)
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ x = $rect.L; y = $rect.T
  width = $rect.R - $rect.L; height = $rect.B - $rect.T; title = $sb.ToString() } -Compress))
`
  )
  const cx = Number(r['x']) + Number(r['width']) / 2
  const cy = Number(r['y']) + Number(r['height']) / 2
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
  if (cx < bounds.x || cx >= bounds.x + bounds.width || cy < bounds.y || cy >= bounds.y + bounds.height) {
    throw new Error(
      `拒绝${action}：当前前台窗口「${String(r['title'] ?? '')}」不在划给 AI 的显示器 ${bounds.index} 上。` +
        '分屏控制模式下键盘只能打给那块屏上的窗口——请先 desktop_focus_window 聚焦目标窗口。'
    )
  }
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
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint x, out uint y);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
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
# 每显示器 DPI 感知 v2（-4）。必须是 PMv2 而不是 SetProcessDPIAware：
# 后者是"系统 DPI 感知"，在混合 DPI 下（如 200% 笔电 + 100% 外接）会把所有
# 显示器都按主屏缩放虚拟化——外接屏截图被 2 倍上采样（糊），报出的尺寸也是
# 虚构的。PMv2 下各屏都是真实物理像素，截图 1:1，坐标与 SetCursorPos 同空间。
# 旧版 Windows（< 1703）没有这个 API，回退到系统 DPI 感知。
try { [void][TranU32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][TranU32]::SetProcessDPIAware() }
`

// ---------- 各工具的 PS 实现 ----------

async function psScreenshot(): Promise<{
  file: string
  width: number
  height: number
  left: number
  top: number
}> {
  const file = join(tmpdir(), `tran-desktop-shot-${Date.now()}.jpg`)
  // 分屏模式：只截划给 AI 的那块屏，用户那块屏的内容根本不会进 AI 的上下文
  //（既是隐私，也省 token）。未限制时截整个虚拟桌面。
  const bounds = await allowedBounds()
  const region = bounds
    ? `$rl=${bounds.x}; $rt=${bounds.y}; $rw=${bounds.width}; $rh=${bounds.height}`
    : `$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; $rl=$vs.Left; $rt=$vs.Top; $rw=$vs.Width; $rh=$vs.Height`
  const r = await runPs(
    CS_USER32 + `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
${region}
$bmp = New-Object System.Drawing.Bitmap $rw, $rh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rl, $rt, 0, 0, $bmp.Size)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]72)
$bmp.Save($env:TRAN_SHOT_FILE, $enc, $p)
$g.Dispose(); $bmp.Dispose()
Write-Output ("TRANJSON:" + (ConvertTo-Json @{ width = $rw; height = $rh; left = $rl; top = $rt } -Compress))
`,
    { TRAN_SHOT_FILE: file }
  )
  return {
    file,
    width: Number(r['width']),
    height: Number(r['height']),
    left: Number(r['left']),
    top: Number(r['top'])
  }
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
      // 截图原点不一定是 (0,0)（分屏模式截的是某块屏、或虚拟桌面含负坐标），
      // 必须把换算方式讲清楚，否则模型会拿图内坐标直接去点，整体偏移一屏。
      const origin =
        shot.left === 0 && shot.top === 0
          ? '图中像素坐标即屏幕坐标，可直接用于 desktop_click。'
          : `图左上角对应屏幕坐标 (${shot.left}, ${shot.top})：` +
            `desktop_click 的 x = ${shot.left} + 图内x，y = ${shot.top} + 图内y。`
      return [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
        { type: 'text', text: `截图 ${shot.width}x${shot.height}。${origin}` }
      ]
    }
  },
  {
    name: 'desktop_list_displays',
    description:
      '列出所有显示器及其屏幕坐标范围。分屏控制模式下会标出哪块屏划给了 AI——只有那块屏可操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const displays = await listDisplays()
      const idx = targetDisplayIndex()
      return textContent({
        displays,
        aiDisplay: idx,
        mode: idx === null ? '全屏可操作' : `分屏控制：只能操作显示器 ${idx}`
      })
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
    run: async (a) => {
      const hwnd = Number(a['hwnd'])
      // 分屏模式：只放行窗口中心落在 AI 那块屏里的窗口——把用户屏上的窗口
      // 抢到前台，等于直接打断用户。
      const bounds = await allowedBounds()
      if (bounds) {
        const list = await psListWindows()
        const wins = (Array.isArray(list['windows']) ? list['windows'] : []) as Array<Record<string, number>>
        const target = wins.find((w) => Number(w['hwnd']) === hwnd)
        if (target) {
          assertInBounds(
            bounds,
            Number(target['x']) + Number(target['width']) / 2,
            Number(target['y']) + Number(target['height']) / 2
          )
        }
      }
      return textContent(await psFocusWindow(hwnd))
    }
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
    run: async (a) => {
      const x = Number(a['x'])
      const y = Number(a['y'])
      assertInBounds(await allowedBounds(), x, y)
      return textContent(await psClick(x, y, String(a['button'] ?? 'left')))
    }
  },
  {
    name: 'desktop_type',
    description:
      '向当前焦点处输入文本（SendInput 直接注入 Unicode 字符：完整支持中文，' +
      '不经中文输入法组词，也不动系统剪贴板），可选按回车。先点击目标输入框再调用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        enter: { type: 'boolean', description: 'true 则输入后按回车' }
      },
      required: ['text'],
      additionalProperties: false
    },
    run: async (a) => {
      await assertForegroundInBounds('键入')
      return textContent(await psType(String(a['text'] ?? ''), a['enter'] === true))
    }
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
    run: async (a) => {
      await assertForegroundInBounds('按键')
      return textContent(await psKey(String(a['keys'] ?? '')))
    }
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
        // #67：每次桌面操作点亮屏幕光晕（只读的列举类也报——AI 在看你的屏幕
        // 同样该让人知道）。
        reportActivity('AI 控制桌面')
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
rl.on('close', () => {
  bridge?.close()
  process.exit(0)
})
connectBridge()
logErr(`tran-desktop MCP server v${SERVER_VERSION} 就绪（stdio）`)
