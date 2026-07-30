/**
 * #8 诊断埋点：流式吐字的"到达 / 释放 / 渲染"三组数据，按 100ms 桶聚合进
 * 环形缓冲，CDP 下用 `window.__streamProbe.dump()` 取数、`reset()` 清零。
 * 常驻开启——纯计数累加，开销可忽略；不进 store、不触发任何重渲染。
 *
 * 三组数据对应 issue #8 的两个候选假说：
 * - arrived vs flushed：到达侧是否阵发（假说 A），限速器是否在放水/蓄水；
 * - commitMs（store 更新 → React commit 完成的耗时）与 mdMs（流式文本块
 *   Profiler actualDuration）：渲染侧是否随文本变长而掉帧（假说 B）。
 *
 * 第四轮起按事件类型分型（thought 思考块 vs text 正文块）：
 * - arrivedText/arrivedThink、flushedText/flushedThink：两类 delta 各自的
 *   到达/释放节奏（正文是否比思考更断）；
 * - mdMs（正文块 ReactMarkdown 重解析）与 thinkMs（思考块纯文本渲染）各自的
 *   Profiler 耗时（正文 markdown 渲染是否贵）。
 */

const BUCKET_MS = 100
/** 环形容量：约 3 分钟数据，覆盖一次完整流式回答。 */
const MAX_BUCKETS = 1800

/** delta 文本类型：正文 / 思考 / 其他（partial_json 等）。 */
export type ProbeDeltaKind = 'text' | 'thinking' | 'other'

export interface StreamProbeBucket {
  /** 桶起始时间戳（performance.now，ms）。 */
  t0: number
  /** push 入口到达字符数（限速器放水前），按块类型分。 */
  arrived: number
  arrivedText: number
  arrivedThink: number
  /** flush 出口释放字符数（实际进 store 的），按块类型分。 */
  flushed: number
  flushedText: number
  flushedThink: number
  /** 桶末限速器积压字符数。 */
  backlog: number
  /** 本桶 flush（rAF 提交 store）次数。 */
  flushes: number
  /** store→commit 完成次数。 */
  commits: number
  commitMsTotal: number
  commitMsMax: number
  /** 流式正文块 Profiler 渲染次数（mount+update）与耗时。 */
  mdRenders: number
  mdMsTotal: number
  mdMsMax: number
  /** 流式思考块 Profiler 渲染次数与耗时。 */
  thinkRenders: number
  thinkMsTotal: number
  thinkMsMax: number
}

const buckets: StreamProbeBucket[] = []
/** flush 时刻（performance.now）；Transcript commit 后据此算 commitMs。 */
let pendingFlushAt: number | null = null

function currentBucket(): StreamProbeBucket {
  const now = performance.now()
  const t0 = Math.floor(now / BUCKET_MS) * BUCKET_MS
  let b = buckets[buckets.length - 1]
  if (!b || b.t0 !== t0) {
    b = {
      t0,
      arrived: 0,
      arrivedText: 0,
      arrivedThink: 0,
      flushed: 0,
      flushedText: 0,
      flushedThink: 0,
      backlog: 0,
      flushes: 0,
      commits: 0,
      commitMsTotal: 0,
      commitMsMax: 0,
      mdRenders: 0,
      mdMsTotal: 0,
      mdMsMax: 0,
      thinkRenders: 0,
      thinkMsTotal: 0,
      thinkMsMax: 0
    }
    buckets.push(b)
    if (buckets.length > MAX_BUCKETS) buckets.splice(0, buckets.length - MAX_BUCKETS)
  }
  return b
}

/** streamBatcher push 入口：到达 `chars` 个字符，kind 区分正文/思考。 */
export function probeArrival(chars: number, kind: ProbeDeltaKind = 'other'): void {
  const b = currentBucket()
  b.arrived += chars
  if (kind === 'text') b.arrivedText += chars
  else if (kind === 'thinking') b.arrivedThink += chars
}

/** streamBatcher flush 出口：释放 text/think 字符数，此刻积压 `backlog`。 */
export function probeFlush(textChars: number, thinkChars: number, backlog: number): void {
  const b = currentBucket()
  b.flushed += textChars + thinkChars
  b.flushedText += textChars
  b.flushedThink += thinkChars
  b.backlog = backlog
  b.flushes += 1
  pendingFlushAt = performance.now()
}

/** Transcript items commit 后调用：记录本次 store→commit 耗时。 */
export function probeCommit(): void {
  if (pendingFlushAt === null) return
  const ms = performance.now() - pendingFlushAt
  pendingFlushAt = null
  const b = currentBucket()
  b.commits += 1
  b.commitMsTotal += ms
  if (ms > b.commitMsMax) b.commitMsMax = ms
}

/** 流式块 Profiler onRender：actualDuration 即该块 React 渲染耗时。
 *  Profiler id 前缀区分：stream-text- 正文块 / stream-think- 思考块。 */
/**
 * ⚠️ 目前未接线。此前由 Transcript 在流式期间用 <Profiler> 包裹文本/思考块调用，
 * 但那个包裹层随 isStreaming 出现/消失，会在 turn 结束时把整块 remount
 * （思考块折叠态丢失、markdown 整树重建）；而 Profiler 的 onRender 在生产构建
 * 里根本不回调。要重新启用得改成**恒定存在**的包裹层（Profiler 一直挂着，
 * 由本函数内部判断是否记账），不能再用条件包裹。
 */
export function probeRender(id: string, _phase: string, actualDuration: number): void {
  const b = currentBucket()
  if (id.startsWith('stream-think-')) {
    b.thinkRenders += 1
    b.thinkMsTotal += actualDuration
    if (actualDuration > b.thinkMsMax) b.thinkMsMax = actualDuration
  } else {
    b.mdRenders += 1
    b.mdMsTotal += actualDuration
    if (actualDuration > b.mdMsMax) b.mdMsMax = actualDuration
  }
}

interface StreamProbeHandle {
  dump: () => StreamProbeBucket[]
  reset: () => void
}

declare global {
  interface Window {
    __streamProbe?: StreamProbeHandle
  }
}

window.__streamProbe = {
  dump: () => buckets.map((b) => ({ ...b })),
  reset: () => {
    buckets.length = 0
    pendingFlushAt = null
  }
}
