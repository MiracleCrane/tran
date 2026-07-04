// P0 闭环冒烟测试：不依赖 Electron，用 mock provider 验证 AgentLoop。
// 运行：node agent/test/smoke.mjs
import { AgentLoop } from '../src/loop/AgentLoop.js'
import { readFileTool } from '../src/tools/code/readFile.js'
import { bashTool } from '../src/tools/code/bash.js'

let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) {
    pass++
    console.log(`  ✓ ${msg}`)
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

// ---- Mock provider：第一次返回「调用 bash」turn，第二次返回纯文本 turn ----
class MockProvider {
  constructor() {
    this.calls = 0
  }
  async complete(_messages, _tools, _model, _signal) {
    this.calls++
    if (this.calls === 1) {
      return {
        content: '我先看看当前目录。',
        toolCalls: [
          {
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'echo hello-anvil' }
          }
        ],
        deltas: [
          { type: 'text', text: '我先看看当前目录。' },
          { type: 'tool_use_begin', toolCallId: 'call_1', toolName: 'bash' },
          { type: 'tool_use_argument', toolCallId: 'call_1', partialJson: '{"command":"echo hello-anvil"}' },
          { type: 'tool_use_end', toolCallId: 'call_1' }
        ],
        stopReason: 'tool_use'
      }
    }
    return {
      content: '完成，目录里什么都没有。',
      toolCalls: [],
      deltas: [{ type: 'text', text: '完成，目录里什么都没有。' }],
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20 }
    }
  }
}

const events = []
const controller = new AbortController()

// 注入 mock provider：用一个临时子类覆盖 AgentLoop 的 provider 字段。
const loop = new AgentLoop(
  {
    provider: { name: 'mock', baseUrl: 'http://x', token: 't', authType: 'bearer', model: 'mock-1' },
    model: 'mock-1',
    cwd: process.cwd(),
    tools: [readFileTool, bashTool],
    systemPrompt: 'test',
    onEvent: (e) => events.push(e),
    signal: controller.signal
  },
  'test-session'
)
// 替换 provider 为 mock。
loop['provider'] = new MockProvider()

await loop.handleUserMessage('列一下当前目录')

console.log('\n事件序列:')
events.forEach((e, i) => console.log(`  [${i}] ${e.type}${e.toolName ? ' ' + e.toolName : ''}${e.text ? ' "' + (e.text.length > 30 ? e.text.slice(0, 30) + '…' : e.text) + '"' : ''}`))

// 断言
assert(events.some((e) => e.type === 'init'), 'init 事件已发')
assert(events.some((e) => e.type === 'tool_use' && e.toolName === 'bash'), '调用了 bash 工具')
const tr = events.find((e) => e.type === 'tool_result')
assert(!!tr, '有 tool_result')
assert(tr && tr.content.includes('hello-anvil'), 'tool_result 含 bash 输出 hello-anvil')
assert(events.some((e) => e.type === 'text_done'), '最终 assistant 文本已发')
assert(events.some((e) => e.type === 'turn_end'), 'turn_end 收尾')
assert(!events.some((e) => e.type === 'ended' && e.error), '无错误结束')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
