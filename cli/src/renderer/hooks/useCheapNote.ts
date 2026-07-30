import { useEffect, useState } from 'react'

/**
 * 「便宜模型」一句话说明的取用侧（命令说明 / 思考块摘要共用）。
 *
 * 三条纪律，全部对应交接文档记下的实测约束：
 * 1. **绝不在流式期间请求**——调用方传 ready=false 直到块收尾。流式期间界面用
 *    规则摘要，本来就够看，而这时候发请求既拿不到完整输入也在跟主链路抢带宽。
 * 2. **绝不阻塞渲染**——先返回 null，调用方照常显示原来的兜底文案，说明到了
 *    再替换。任何一次失败都不该在界面上留痕。
 * 3. 缓存在主进程（按内容哈希落盘），这里不再做第二层缓存——同一条命令在一屏
 *    里出现多次时主进程侧会合并成一发请求。
 *
 * 组件卸载后不 setState：这些请求慢的时候要一秒多，用户早滚走了。
 */
export function useCheapNote(
  fetcher: (input: string) => Promise<string | null>,
  input: string,
  ready: boolean
): string | null {
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!ready || !input.trim()) return
    let cancelled = false
    void fetcher(input)
      .then((result) => {
        if (!cancelled && result) setNote(result)
      })
      .catch(() => {
        /* 静默：拿不到说明就继续用兜底文案 */
      })
    return () => {
      cancelled = true
    }
  }, [fetcher, input, ready])

  return note
}
