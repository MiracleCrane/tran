import SummaryApiSettings from './SummaryApiSettings'
import { useUiStore } from '../store/uiStore'

/**
 * 翻译设置页（2026-08-14 用户定稿：通道统一）。
 *
 * 技能/插件描述翻译、思考块全文翻译、会话命名、命令说明、思考摘要——全部走
 * 同一个「摘要 / 命名 API」通道，就是下面这套配置。不再有百度/运营商的引擎
 * 选择（那套分叉让用户困惑"这块啥意思"）。
 */
export default function TranslatePanel(): JSX.Element {
  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        {/* #35 吸顶标题栏：下滚后"返回对话"仍可点。 */}
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={() => useUiStore.getState().setView('chat')}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">翻译</h1>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
          所有翻译、命名、摘要都走同一个通道——就是下面这套「摘要 / 命名 API」，
          不用单独区分。技能/插件描述翻译和思考块全文翻译都用它；没配 Key 时
          描述翻译回退到当前运营商，思考块显示原文。
        </p>
        <SummaryApiSettings />
      </div>
    </div>
  )
}
