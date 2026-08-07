import { useEffect, useState } from 'react'

/**
 * 「便宜模型」一句话说明的取用侧（命令说明 / 思考块摘要 / 思考翻译共用）。
 *
 * 三条纪律，全部对应交接文档记下的实测约束：
 * 1. **绝不在流式期间请求**——调用方传 ready=false 直到块收尾。流式期间界面用
 *    规则摘要，本来就够看，而这时候发请求既拿不到完整输入也在跟主链路抢带宽。
 * 2. **绝不阻塞渲染**——先返回 null，调用方照常显示原来的兜底文案，说明到了
 *    再替换。
 * 3. 缓存在主进程（按内容哈希落盘），这里不再做第二层缓存——同一条命令在一屏
 *    里出现多次时主进程侧会合并成一发请求。
 *
 * settled：请求已落地（无论成败）。调用方靠它区分「还在等」和「没拿到」——
 * 比如思考翻译失败后要把"翻译中…"换成一句"翻译不可用"的轻提示（2026-08
 * 用户要求：翻不了就直说，别一直转），而不是永远停在等待态。
 *
 * 组件卸载后不 setState：这些请求慢的时候要一秒多，用户早滚走了。
 */
export interface CheapNoteState {
  value: string | null
  settled: boolean
}

export function useCheapNote(
  fetcher: (input: string) => Promise<string | null>,
  input: string,
  ready: boolean
): CheapNoteState {
  const [state, setState] = useState<CheapNoteState>({ value: null, settled: false })

  // input 变化先清掉旧说明：请求是异步的，不清的话旧输入的说明会挂在新输入上，
  // 直到新请求返回（失败则永远挂着）。
  // 已经是空态时原样返回 prev（React 引用相等即跳过重渲染）：流式期间 input
  // 每个 chunk 都在变，不这么做等于给每个思考块每帧多一次无效重渲染。
  useEffect(() => {
    setState((prev) => (prev.value === null && !prev.settled ? prev : { value: null, settled: false }))
  }, [input])

  useEffect(() => {
    if (!ready || !input.trim()) return
    let cancelled = false
    void fetcher(input)
      .then((result) => {
        if (!cancelled) setState({ value: result ?? null, settled: true })
      })
      .catch(() => {
        if (!cancelled) setState({ value: null, settled: true })
      })
    return () => {
      cancelled = true
    }
  }, [fetcher, input, ready])

  return state
}
