# 型号列表**必须**从服务端目录拉，不能手写。
# 2026-07-30 实测：chat 端点根本不校验 model 值——随便写个名字都回 200 并原样
# 回声。这个脚本的上一版手写了 kimi-k2.6 / kimi-k2.7-code / kimi-k3 等六个名字，
# 其中五个在目录里压根不存在，服务端静默回落到默认型号，于是"六个型号延迟几乎
# 一样"这个结论其实是**把同一个型号测了六遍**。
$c = Get-Content "$env:USERPROFILE\.kimi-code\credentials\kimi-code.json" -Raw | ConvertFrom-Json
$h = @{ authorization = "Bearer $($c.access_token)" }
$chat = 'https://api.kimi.com/coding/v1/chat/completions'
$usagesUrl = 'https://api.kimi.com/coding/v1/usages'
$modelsUrl = 'https://api.kimi.com/coding/v1/models'
$catalog = (Invoke-RestMethod $modelsUrl -Headers $h -TimeoutSec 20).data
$models = $catalog | ForEach-Object { $_.id }
$N = 5

Write-Host "=== 服务端目录（唯一权威的型号来源）===" -ForegroundColor Cyan
$catalog | Format-Table id,display_name,context_length -AutoSize

# 统一载荷：模拟真实的"总结一条命令"任务，这样各型号的 token 数可比。
# 少样本用真正的 user/assistant 轮次 + stop —— 塞进单条 user 消息会答非所问，
# 裸提示词则会写长文写到撞 max_tokens（那样测的是"生成 32 个 token 要多久"，
# 不是型号快慢）。见 cli/src/main/cheapModel.ts 的注释。
$sys = '说明这条命令在做什么。只输出结果本身，不要解释、不要 markdown、不超过 12 字。'
$usr = 'npm run build && node scripts/deploy.mjs --env prod --verbose'

function Call($m) {
  $msgs = @(
    @{role='system';    content=$sys},
    @{role='user';      content='git status --porcelain'},
    @{role='assistant'; content='查看改动'},
    @{role='user';      content='pytest tests/api -k login'},
    @{role='assistant'; content='跑登录相关测试'},
    @{role='user';      content=$usr}
  )
  # thinking=disabled 是载重参数：目录里的型号全是 supports_thinking_type=only，
  # 去掉这个字段，max_tokens 会被推理吃光，content 回空串。
  # temperature 一律不传：传 0 直接 400（only 0.6 is allowed for this model）。
  $b = @{ model=$m; max_tokens=32; thinking=@{type='disabled'}; stop=@("`n");
          messages=$msgs } | ConvertTo-Json -Depth 5 -Compress
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
