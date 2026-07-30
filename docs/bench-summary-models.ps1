$c = Get-Content "$env:USERPROFILE\.kimi-code\credentials\kimi-code.json" -Raw | ConvertFrom-Json
$h = @{ authorization = "Bearer $($c.access_token)" }
$chat = 'https://api.kimi.com/coding/v1/chat/completions'
$usagesUrl = 'https://api.kimi.com/coding/v1/usages'
$models = 'kimi-for-coding','kimi-k2.6','kimi-k2.6-turbo','kimi-k2.7-code','kimi-k2.7-code-turbo','kimi-k3'
$N = 5

# 统一载荷：模拟真实的"总结一条命令"任务，这样各型号的 token 数可比
$sys = '用一句不超过12字的话说明这条命令在做什么，只输出结果。'
$usr = 'npm run build && node scripts/deploy.mjs --env prod --verbose'

function Call($m) {
  $b = @{ model=$m; max_tokens=32; thinking=@{type='disabled'};
          messages=@(@{role='system';content=$sys},@{role='user';content=$usr}) } | ConvertTo-Json -Depth 5 -Compress
  $sw=[Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod $chat -Headers $h -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 60
    $sw.Stop(); return @{ ok=$true; ms=$sw.ElapsedMilliseconds; usage=$r.usage; text=$r.choices[0].message.content }
  } catch { $sw.Stop(); return @{ ok=$false; ms=$sw.ElapsedMilliseconds; err=$_.Exception.Message } }
}
function Usage() { try { Invoke-RestMethod $usagesUrl -Headers $h -TimeoutSec 20 } catch { $null } }

Write-Host "=== 额度基线（原始 JSON，字段名随版本变，靠肉眼比） ===" -ForegroundColor Cyan
$u0 = Usage; if ($u0) { ($u0 | ConvertTo-Json -Compress -Depth 6) }

Write-Host "`n预热连接（TLS 握手不计入后面的测速）…" -ForegroundColor DarkGray
$null = Call 'kimi-for-coding'

$rows = @()
foreach ($m in $models) {
  Write-Host -NoNewline ("测 {0} " -f $m)
  $before = Usage
  $lat=@(); $pt=0; $ct=0; $tt=0; $ok=0; $err=''; $sample=''
  for ($i=1; $i -le $N; $i++) {
    $r = Call $m
    if ($r.ok) {
      $ok++; $lat += $r.ms; $sample = $r.text
      if ($r.usage) { $pt=$r.usage.prompt_tokens; $ct=$r.usage.completion_tokens; $tt=$r.usage.total_tokens }
    } else { $err = $r.err }
    Write-Host -NoNewline "."
    Start-Sleep -Milliseconds 200
  }
  Write-Host ""
  if ($ok -eq 0) { Write-Host ("  FAIL: {0}" -f $err) -ForegroundColor DarkGray; continue }
  Start-Sleep -Seconds 3
  $after = Usage
  $s = @($lat | Sort-Object)
  $d = 'n/a'
  if ($null -ne $before.usage.used -and $null -ne $after.usage.used) { $d = $after.usage.used - $before.usage.used }
  $rows += [pscustomobject]@{
    model=$m; ok=$ok
    minMs=$s[0]; medMs=$s[[int][math]::Floor($s.Count/2)]; maxMs=$s[-1]
    inTok=$pt; outTok=$ct; totalTok=$tt
    usedBefore=$before.usage.used; usedAfter=$after.usage.used; delta=$d
    sample=$sample
  }
}

Write-Host "`n=== 结果 ===" -ForegroundColor Green
$rows | Format-Table model,ok,minMs,medMs,maxMs,inTok,outTok,totalTok,usedBefore,usedAfter,delta -AutoSize
Write-Host "`n=== 各型号的实际输出（看质量够不够用） ===" -ForegroundColor Green
$rows | ForEach-Object { "  {0,-24} {1}" -f $_.model, $_.sample }

Write-Host "`n=== 额度终值 ===" -ForegroundColor Cyan
$u1 = Usage; if ($u1) { ($u1 | ConvertTo-Json -Compress -Depth 6) }
Write-Host "`ndelta = 每个型号打 $N 发前后额度计数器的变化。0 或 n/a 就把首尾两段 JSON 对比着看。" -ForegroundColor DarkGray
