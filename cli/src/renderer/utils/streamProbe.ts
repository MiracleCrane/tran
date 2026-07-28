/**
 * #8 诊断埋点：流式吐字的"到达 / 释放 / 渲染"三组数据，按 100ms 桶聚合进
 * 环形缓冲，CDP 下用 `window.__streamProbe.dump()` 取数、`reset()` 清零。
 * 常驻开启——纯计数累加，开销可忽略；不进 store、不触发任何重渲染。
 *
 * 三组数据对应 issue #8 的两个候选假说：
 * - arrived vs flushed：到达侧是否阵发（假说 A），限速器是否在放水/蓄水；
 * - commitMs（store 更新 → React commit 完成的耗时）与 mdMs（流式文本块
 *   Profiler actualDuration）：渲染侧是否随文本变长而掉帧（假说 B）。
 */

const BUCKET_MS = 100
/** 环形容量：约 3 分钟数据，覆盖一次完整流式回答。 */
const MAX_BUCKETS = 1800

export interface StreamProbeBucket {
  /** 桶起始时间戳（performance.now，ms）。 */
  t0: number
  /** push 入口到达字符数（限速器放水前）。 */
  arrived: number
  /** flush 出口释放字符数（实际进 store 的）。 */
  flushed: number
  /** 桶末限速器积压字符数。 */
  backlog: number
  /** 本桶 flush（rAF 提交 store）次数。 */
  flushes: number
  /** store→commit 完成次数。 */
  commits: number
  commitMsTotal: number
  commitMsMax: number
  /** 流式文本块 Profiler 渲染次数（mount+update）。 */
  mdRenders: number
  mdMsTotal: number
  mdMsMax: number
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
      flushed: 0,
      backlog: 0,
      flushes: 0,
      commits: 0,
      commitMsTotal: 0,
      commitMsMax: 0,
      mdRenders: 0,
      mdMsTotal: 0,
      mdMsMax: 0
    }
    buckets.push(b)
    if (buckets.length > MAX_BUCKETS) buckets.splice(0, buckets.length - MAX_BUCKETS)
  }
  return b
}

/** streamBatcher push 入口：到达 `chars` 个字符。 */
export function probeArrival(chars: number): void {
  currentBucket().arrived += chars
}

/** streamBatcher flush 出口：释放 `chars` 个字符，此刻积压 `backlog`。 */
export function probeFlush(chars: number, backlog: number): void {
  const b = currentBucket()
  b.flushed += chars
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

/** 流式文本块 Profiler onRender：actualDuration 即该块 React 渲染耗时。 */
export function probeRender(_id: string, _phase: string, actualDuration: number): void {
  const b = currentBucket()
  b.mdRenders += 1
  b.mdMsTotal += actualDuration
  if (actualDuration > b.mdMsMax) b.mdMsMax = actualDuration
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
