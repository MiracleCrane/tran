/**
 * 便宜模型端点的可复现探针。`node docs/probe-kimi-models.mjs [catalog|latency|prompt|all]`
 *
 * 为什么要有这个（而不是只留 bench-summary-models.ps1）：
 * 上一版基准手写了六个型号名，其中五个在服务端目录里压根不存在——而 chat 端点
 * 对不存在的 model 值**照样回 200 并原样回声**，于是"六个型号延迟差不多"这个
 * 结论其实是把同一个型号测了六遍。这个脚本把"存不存在"（问 /models）和
 * "通不通、多快"（打一发）分开测，就是为了不再犯同一个错。
 *
 * 凭证链与 usageService.ts 一致：读 ~/.kimi-code/credentials/kimi-code.json，
 * 过期则走 OAuth refresh 并写回（refresh_token 会轮换，必须写回）。
 * access_token 绝不打印。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CRED = join(homedir(), '.kimi-code', 'credentials', 'kimi-code.json')
const CHAT = 'https://api.kimi.com/coding/v1/chat/completions'
const MODELS = 'https://api.kimi.com/coding/v1/models'
const OAUTH = 'https://auth.kimi.com/api/oauth/token'
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

function expiryMs(c) {
  const raw = c.expires_at
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw
  const n = Number(raw)
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
  return Date.parse(raw) || 0
}

async function token() {
  const c = JSON.parse(readFileSync(CRED, 'utf8'))
  if (expiryMs(c) - 60_000 > Date.now()) return c.access_token
  const r = await fetch(OAUTH, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: c.refresh_token
    })
  })
  if (!r.ok) throw new Error('token refresh rejected ' + r.status)
  const next = await r.json()
  const merged = {
    ...c,
    ...next,
    expires_at: new Date(Date.now() + (next.expires_in ?? 900) * 1000).toISOString()
  }
  const tmp = CRED + '.probe.tmp'
  writeFileSync(tmp, JSON.stringify(merged, null, 2))
  renameSync(tmp, CRED)
  console.error('[已刷新 token 并写回]')
  return merged.access_token
}

async function call(body, timeoutMs = 30000) {
  const t = await token()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(CHAT, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    })
    const text = await res.text()
    const ms = Date.now() - startedAt
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300), ms }
    const j = JSON.parse(text)
    return {
      ok: true,
      ms,
      echoModel: j.model,
      usage: j.usage,
      content: j.choices?.[0]?.message?.content ?? ''
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), ms: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

/** 唯一权威的型号来源。 */
async function catalog() {
  const t = await token()
  const r = await fetch(MODELS, { headers: { authorization: `Bearer ${t}` } })
  if (!r.ok) throw new Error('/models ' + r.status)
  return (await r.json()).data ?? []
}

// 正式路径用的形态：多轮角色少样本 + stop。这两样都不是可选项，理由见
// cli/src/main/cheapModel.ts 的注释。
const SYS = '说明这条命令在做什么。只输出结果本身，不要解释、不要 markdown、不超过 12 字。'
const SHOTS = [
  ['git status --porcelain', '查看改动'],
  ['pytest tests/api -k login', '跑登录相关测试']
]
function fewshot(input) {
  const m = [{ role: 'system', content: SYS }]
  for (const [q, a] of SHOTS) {
    m.push({ role: 'user', content: q })
    m.push({ role: 'assistant', content: a })
  }
  m.push({ role: 'user', content: input })
  return m
}
// thinking=disabled 是载重参数（型号全是 supports_thinking_type=only，去掉它
// content 会回空串）；temperature 一律不传（传 0 直接 400）。
function body(model, messages, extra = {}) {
  return { model, max_tokens: 36, thinking: { type: 'disabled' }, messages, ...extra }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function showCatalog() {
  console.log('=== 服务端目录（唯一权威的型号来源）===')
  for (const m of await catalog()) {
    console.log(
      '  ' + String(m.id).padEnd(28),
      String(m.display_name ?? '').padEnd(24),
      'ctx', m.context_length,
      m.think_efforts?.support ? `efforts=${m.think_efforts.valid_efforts?.join('/')}` : ''
    )
  }
  // 对照组：证明"打得通"不等于"存在"。
  console.log('\n=== 对照：目录之外的名字照样回 200 ===')
  for (const fake of ['gpt-4o', 'zzz-not-a-real-model-20260730']) {
    const r = await call(body(fake, [{ role: 'user', content: '你好' }]))
    console.log(
      '  ' + fake.padEnd(30),
      r.ok
        ? `HTTP 200  回声 model=${r.echoModel}  prompt_tokens=${r.usage?.prompt_tokens}`
        : `HTTP ${r.status} ${String(r.error).slice(0, 120)}`
    )
    await sleep(300)
  }
  console.log('  ↑ 若这两行是 200，就说明存在性判断只能靠 /models。')
}

async function latency(n = 3) {
  console.log(`\n=== 延迟（真实型号，每个 ${n} 发热连接）===`)
  const ids = (await catalog()).map((m) => m.id)
  const input = 'docker compose up -d --build web worker'
  await call(body(ids[0], fewshot(input), { stop: ['\n'] })) // 预热 TLS
  for (const model of ids) {
    const lat = []
    let usage = null
    let sample = ''
    for (let i = 0; i < n; i++) {
      const r = await call(body(model, fewshot(input), { stop: ['\n'] }))
      if (r.ok) {
        lat.push(r.ms)
        usage = r.usage
        sample = (r.content || '').replace(/\s+/g, ' ')
      } else {
        console.log('  ' + model.padEnd(28), `FAIL ${r.status} ${String(r.error).slice(0, 150)}`)
      }
      await sleep(300)
    }
    if (!lat.length) continue
    const s = [...lat].sort((a, b) => a - b)
    console.log(
      '  ' + model.padEnd(28),
      `min ${String(s[0]).padStart(5)}  中位 ${String(s[Math.floor(s.length / 2)]).padStart(5)}`,
      `tok ${usage?.prompt_tokens}/${usage?.completion_tokens}`,
      '|', sample
    )
  }
}

const CMDS = [
  'npm run build',
  'kubectl rollout restart deploy/api -n prod',
  'rm -rf node_modules && npm ci',
  'curl -s http://jenkins/job/foo/lastBuild/api/json',
  'ssh deploy@10.0.0.5 "systemctl restart nginx"',
  'grep -rn "TODO" src/ | wc -l'
]

/** 指令遵循：看 12 字上限压不压得住、有没有答非所问。 */
async function promptCheck(model = 'kimi-for-coding') {
  console.log(`\n=== 指令遵循（${model}，多轮少样本 + stop）===`)
  for (const cmd of CMDS) {
    const r = await call(body(model, fewshot(cmd), { stop: ['\n'] }))
    const out = r.ok ? (r.content || '').replace(/\s+/g, ' ') : `FAIL ${r.status}`
    const flag = r.ok && out.length > 0 && out.length <= 24 ? ' ' : '⚠'
    console.log(` ${flag} ${cmd.slice(0, 46).padEnd(48)} ${out}`)
    await sleep(300)
  }

  // 一次只动一个变量的形态对照。已知会 400 的只有 temperature。
  console.log(`\n=== 请求形态对照（${model}）===`)
  const plain = [{ role: 'system', content: SYS }, { role: 'user', content: CMDS[0] }]
  const variants = [
    ['单轮，无 stop', body(model, plain)],
    ['单轮 + stop', body(model, plain, { stop: ['\n'] })],
    ['多轮少样本，无 stop', body(model, fewshot(CMDS[0]))],
    ['多轮少样本 + stop（正式路径）', body(model, fewshot(CMDS[0]), { stop: ['\n'] })],
    ['去掉 thinking 字段', { model, max_tokens: 36, stop: ['\n'], messages: fewshot(CMDS[0]) }],
    ['传 temperature=0', body(model, fewshot(CMDS[0]), { stop: ['\n'], temperature: 0 })]
  ]
  for (const [label, payload] of variants) {
    const r = await call(payload)
    console.log(
      '  ' + label.padEnd(30),
      r.ok
        ? `OK ${String(r.ms).padStart(5)}ms out=${JSON.stringify((r.content || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 80))}`
        : `FAIL ${r.status} ${String(r.error).replace(/\s+/g, ' ').slice(0, 160)}`
    )
    await sleep(400)
  }
  console.log('  ↑ "去掉 thinking 字段"预期 out=""（预算被推理吃光）；')
  console.log('    "传 temperature=0" 预期 400 only 0.6 is allowed。')
}

const mode = process.argv[2] ?? 'all'
if (mode === 'catalog' || mode === 'all') await showCatalog()
if (mode === 'latency' || mode === 'all') await latency()
if (mode === 'prompt' || mode === 'all') await promptCheck(process.argv[3])
