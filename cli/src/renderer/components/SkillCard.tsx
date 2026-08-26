import type { SkillInfo } from '../../shared/ipc'
import HoverTip from './HoverTip'

/** 斜杠命令（skill）调用的专属卡片 —— 用户消息以 `/name` 开头且命中 kimi
 *  推送的可用命令列表时，用它替代普通用户气泡：图标 + 命令名 + Skill 徽章 +
 *  参数正文 + 命令描述。对齐方式仍靠右（它本质上是用户的一次发言）。 */

export interface SkillInvocation {
  /** 命中的命令名（不含斜杠，保留用户输入的原始大小写）。 */
  name: string
  /** `/name` 之后的参数文本（可多行；无参数则为空串）。 */
  args: string
  /** 命中的技能条目（描述用于卡片副标题）。 */
  skill: SkillInfo
}

/** 消息文本是否是一次斜杠命令调用：首个非空 token 形如 `/name` 且 name 命中
 *  已知命令（含别名，大小写不敏感）。模板类插入的是整段文本不带斜杠，天然
 *  不会误命中。 */
export function matchSkillInvocation(
  text: string | undefined,
  skills: SkillInfo[]
): SkillInvocation | null {
  if (!text || skills.length === 0) return null
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const m = /^\/([\w:-]+)([\s\S]*)$/.exec(trimmed)
  if (!m) return null
  const name = m[1]
  const lower = name.toLowerCase()
  const skill = skills.find(
    (s) =>
      s.name.toLowerCase() === lower ||
      (s.aliases ?? []).some((a) => a.toLowerCase() === lower)
  )
  if (!skill) return null
  return { name, args: m[2].trim(), skill }
}

const SkillGlyph = (): JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
)

export default function SkillCard({
  invocation,
  cutIn
}: {
  invocation: SkillInvocation
  /** Ctrl+S 插队发送的标记（与普通气泡的徽章语义一致）。 */
  cutIn?: boolean
}): JSX.Element {
  const { name, args, skill } = invocation
  return (
    <div className="tran-skill-card max-w-[85%] min-w-[240px] overflow-hidden rounded-[16px] rounded-tr-md border border-accent/30 bg-[#12111a] shadow-lg shadow-black/20">
      <div className="flex items-center gap-2.5 bg-gradient-to-r from-accent/[0.18] via-accent/[0.07] to-transparent px-3.5 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/20 text-accent">
          <SkillGlyph />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] font-semibold text-zinc-100">/{name}</span>
            {cutIn && (
              <HoverTip tip="Ctrl+S 打断并发送（插队）" tipClassName="text-left" className="inline-flex shrink-0">
                <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[9px] font-medium text-zinc-300">
                  插队
                </span>
              </HoverTip>
            )}
          </div>
          {skill.description && (
            <HoverTip tip={skill.description} tipClassName="break-words text-left" className="block min-w-0">
              <div className="truncate text-[11px] text-zinc-500">
                {skill.description}
              </div>
            </HoverTip>
          )}
        </div>
        <span className="shrink-0 rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent">
          Skill
        </span>
      </div>
      {args && (
        <div className="whitespace-pre-wrap break-words border-t border-white/[0.06] px-3.5 py-2 text-sm text-zinc-200">
          {args}
        </div>
      )}
    </div>
  )
}
