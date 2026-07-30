# 探测「总结旁路」用的型号与额度消耗
#
# 回答两个问题：
#   1. api.kimi.com/coding/v1/chat/completions 到底认哪些 model 值？
#   2. 这些调用费不费 Kimi Code 订阅的额度？费多少？
#
# 做法：读 /usages 记基线 → 打 N 发最小请求 → 再读 /usages 比差值。
#
# token 全程留在本机：脚本自己从
#   %USERPROFILE%\.kimi-code\credentials\kimi-code.json
# 读 access_token，不打印、不外传。输出里只有型号、状态码、延迟、额度数字。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File probe-summary-model-quota.ps1
#   powershell -ExecutionPolicy Bypass -File probe-summary-model-quota.ps1 -Calls 50
#
# 若报 401：先在终端跑一下 kimi（或 kimi login）刷新凭证再来。

param(
  # 每个可用型号打多少发。20 发看不出动静就加到 100——有些计数器很粗。
  [int]$Calls = 20,
  # 想测的型号；默认这几个候选。
  [string[]]$Models = @(
    'kimi-for-coding',
    'kimi-k2.6',
    'kimi-k2.6-turbo',
    'kimi-k2.7-code',
    'kimi-k2.7-code-turbo',
    'kimi-k3'
  )
)

$ErrorActionPreference = 'Stop'
$CredPath   = Join-Path $env:USERPROFILE '.kimi-code\credentials\kimi-code.json'
$ChatUrl    = 'https://api.kimi.com/coding/v1/chat/completions'
$UsagesUrl  = 'https://api.kimi.com/coding/v1/usages'

if (-not (Test-Path $CredPath)) {
  Write-Host "找不到凭证文件：$CredPath" -ForegroundColor Red
  Write-Host "先在终端跑一次 kimi login。"
  exit 1
}

$cred = Get-Content $CredPath -Raw | ConvertFrom-Json
$token = $cred.access_token
if ([string]::IsNullOrWhiteSpace($token)) {
  Write-Host "凭证里没有 access_token，先跑 kimi login。" -ForegroundColor Red
  exit 1
}
$headers = @{ authorization = "Bearer $token" }

# --- 额度快照 ---------------------------------------------------------------
# 只取数字字段。字段名随服务端版本会变，所以原样 dump 一份紧凑 JSON，
# 差值靠肉眼比——比猜字段名可靠。
function Get-UsageSnapshot {
  try {
    $r = Invoke-RestMethod -Uri $UsagesUrl -Headers $headers -Method Get -TimeoutSec 20
    return $r
  } catch {
    Write-Host "读取 /usages 失败：$($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Message -match '401') {
      Write-Host "→ token 过期了。跑一次 kimi 让它刷新，然后重来。" -ForegroundColor Yellow
    }
    exit 1
  }
}

function Show-Usage($label, $u) {
  Write-Host ""
  Write-Host "--- $label ---" -ForegroundColor Cyan
  if ($u.usage)  { Write-Host ("  usage : " + ($u.usage  | ConvertTo-Json -Compress -Depth 5)) }
  if ($u.limits) { Write-Host ("  limits: " + ($u.limits | ConvertTo-Json -Compress -Depth 6)) }
  if ($u.parallel) { Write-Host ("  parallel: " + ($u.parallel | ConvertTo-Json -Compress -Depth 4)) }
  if ($u.boosterWallet) { Write-Host ("  wallet: " + ($u.boosterWallet | ConvertTo-Json -Compress -Depth 4)) }
}

# --- 单发最小请求 -----------------------------------------------------------
# max_tokens=1 + thinking 关闭：把单次消耗压到最低，让"能不能用"和"费多少"
# 这两件事互不干扰。
function Invoke-Probe($model) {
  $body = @{
    model      = $model
    max_tokens = 1
    thinking   = @{ type = 'disabled' }
    messages   = @(
      @{ role = 'system'; content = '只回一个字：好' },
      @{ role = 'user';   content = '好' }
    )
  } | ConvertTo-Json -Depth 5 -Compress

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $null = Invoke-RestMethod -Uri $ChatUrl -Headers $headers -Method Post `
      -ContentType 'application/json' -Body $body -TimeoutSec 30
    $sw.Stop()
    return @{ ok = $true; ms = $sw.ElapsedMilliseconds }
  } catch {
    $sw.Stop()
    $status = ''
    $detail = $_.Exception.Message
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $detail = $reader.ReadToEnd()
        if ($detail.Length -gt 200) { $detail = $detail.Substring(0, 200) }
      } catch { }
    }
    return @{ ok = $false; ms = $sw.ElapsedMilliseconds; status = $status; detail = $detail }
  }
}

# === 第一步：哪些型号能用 ===================================================
Write-Host ""
Write-Host "=== 第 1 步：型号可用性 ===" -ForegroundColor Green
$usable = @()
foreach ($m in $Models) {
  $r = Invoke-Probe $m
  if ($r.ok) {
    Write-Host ("  [OK]   {0,-24} {1,5} ms" -f $m, $r.ms) -ForegroundColor Green
    $usable += $m
  } else {
    Write-Host ("  [FAIL] {0,-24} {1} {2}" -f $m, $r.status, $r.detail) -ForegroundColor DarkGray
  }
  Start-Sleep -Milliseconds 300   # 别把限流当成"型号不认"
}

if ($usable.Count -eq 0) {
  Write-Host ""
  Write-Host "一个都不通。要么 token 过期，要么这个端点不吃 model 参数。" -ForegroundColor Red
  exit 1
}

# === 第二步：每个可用型号费多少额度 =========================================
Write-Host ""
Write-Host "=== 第 2 步：额度消耗（每个型号 $Calls 发） ===" -ForegroundColor Green
Write-Host "把 before/after 的数字对比着看：动了就是费额度，没动就是不费" -ForegroundColor DarkGray
Write-Host "（或者计数器太粗——那就加大 -Calls 再跑一次）。" -ForegroundColor DarkGray

foreach ($m in $usable) {
  Write-Host ""
  Write-Host ("########## $m ##########") -ForegroundColor Yellow
  $before = Get-UsageSnapshot
  Show-Usage "before" $before

  $ok = 0; $fail = 0; $totalMs = 0
  for ($i = 1; $i -le $Calls; $i++) {
    $r = Invoke-Probe $m
    if ($r.ok) { $ok++ } else { $fail++ }
    $totalMs += $r.ms
    Write-Host -NoNewline "."
    Start-Sleep -Milliseconds 150
  }
  Write-Host ""
  Write-Host ("  打了 {0} 发：成功 {1}，失败 {2}，平均 {3} ms" -f $Calls, $ok, $fail, [int]($totalMs / $Calls))

  # 服务端的计数器不一定实时，给它几秒。
  Start-Sleep -Seconds 5
  $after = Get-UsageSnapshot
  Show-Usage "after" $after
}

Write-Host ""
Write-Host "=== 完 ===" -ForegroundColor Green
Write-Host "把上面整段输出发回来即可——里面没有任何凭证。" -ForegroundColor Cyan
