/**
 * 空会话页。
 *
 * 试过三版：带图标方块的大标题版（太吵）、去掉一切装饰的降调版（还是丑）、
 * 换成项目信息+最近会话的信息版。最后回到最简单的形态：一个图标、一句话、
 * 一句副标题，标题走紫色流光。四个「建议」按钮去掉了——它们看着像功能，
 * 实际只是把词填进输入框，占了整行位置却没解决任何问题。
 */

const TerminalGlyph = (): JSX.Element => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
    <path
      d="M7 8l4 4-4 4M13 16h4"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export default function EmptyState(): JSX.Element {
  return (
    <>
      <span className="text-zinc-700">
        <TerminalGlyph />
      </span>
      <h1 className="tran-empty-title mt-5 text-[22px] font-semibold">发送消息开始对话</h1>
      <p className="mt-2 text-[13px] text-zinc-600">我可以帮助你编写代码、分析问题、执行任务</p>
    </>
  )
}
