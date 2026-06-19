import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../store/sessionStore'

interface UserInputOption {
  label: string
  description?: string
  preview?: string
}

interface UserInputQuestion {
  id: string
  header?: string
  question: string
  options: UserInputOption[]
  multiSelect: boolean
}

interface UserInputRequest {
  questions: UserInputQuestion[]
  autoResolutionMs?: number
}

const OTHER_CHOICE = '__forge_other__'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseOption(value: unknown): UserInputOption | null {
  const option = asRecord(value)
  if (!option) return null
  const label = asString(option.label) ?? asString(option.value) ?? asString(option.id)
  if (!label) return null
  return {
    label,
    ...(asString(option.description) ? { description: asString(option.description) } : {}),
    ...(asString(option.preview) ? { preview: asString(option.preview) } : {})
  }
}

function parseQuestion(value: unknown): UserInputQuestion | null {
  const question = asRecord(value)
  if (!question) return null
  const text = asString(question.question) ?? asString(question.prompt) ?? asString(question.text)
  const id = asString(question.id) ?? text
  const options = Array.isArray(question.options)
    ? question.options.map(parseOption).filter((option): option is UserInputOption => !!option)
    : []
  if (!id || !text || options.length === 0) return null
  return {
    id,
    question: text,
    options,
    multiSelect: question.multiSelect === true || question.multi_select === true,
    ...(asString(question.header) ? { header: asString(question.header) } : {})
  }
}

function parseUserInputRequest(input: Record<string, unknown>): UserInputRequest | null {
  const candidates = [
    input,
    asRecord(input.input),
    asRecord(input.payload),
    asRecord(input.arguments),
    asRecord(input.request)
  ].filter((candidate): candidate is Record<string, unknown> => !!candidate)

  for (const candidate of candidates) {
    if (!Array.isArray(candidate.questions)) continue
    const questions = candidate.questions
      .map(parseQuestion)
      .filter((question): question is UserInputQuestion => !!question)
    if (questions.length === 0) continue
    const autoResolutionMs =
      asNumber(candidate.autoResolutionMs) ??
      asNumber(candidate.auto_resolution_ms) ??
      asNumber(input.autoResolutionMs) ??
      asNumber(input.auto_resolution_ms)
    return {
      questions,
      ...(autoResolutionMs ? { autoResolutionMs } : {})
    }
  }

  return null
}

function defaultAnswers(request: UserInputRequest): Record<string, string[]> {
  return Object.fromEntries(
    request.questions.map((question) => [question.id, question.options[0]?.label ? [question.options[0].label] : []])
  )
}

function resolveAnswers(
  request: UserInputRequest,
  selectedAnswers: Record<string, string[]>,
  customAnswers: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    request.questions.map((question) => {
      const selected = selectedAnswers[question.id]?.length
        ? selectedAnswers[question.id]
        : question.options[0]?.label
          ? [question.options[0].label]
          : []
      const answer = selected
        .map((choice) => (choice === OTHER_CHOICE ? customAnswers[question.id]?.trim() || 'Other' : choice))
        .filter(Boolean)
        .join(', ')
      return [question.id, answer]
    })
  )
}

function isChoiceSelected(selectedAnswers: Record<string, string[]>, questionId: string, choice: string): boolean {
  return (selectedAnswers[questionId] ?? []).includes(choice)
}

function selectChoice(
  current: Record<string, string[]>,
  question: UserInputQuestion,
  choice: string
): Record<string, string[]> {
  if (!question.multiSelect) return { ...current, [question.id]: [choice] }

  const selected = current[question.id] ?? []
  const next = selected.includes(choice)
    ? selected.filter((item) => item !== choice)
    : [...selected, choice]
  return { ...current, [question.id]: next }
}

export default function PermissionModal(): JSX.Element | null {
  const req = useSessionStore((s) => s.pendingPermissions[0])
  const respond = useSessionStore((s) => s.respondPermission)
  const [denyReason, setDenyReason] = useState('')
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const answersRef = useRef<Record<string, string>>({})

  const userInputRequest = useMemo(() => {
    if (!req) return null
    return parseUserInputRequest(req.input)
  }, [req])

  useEffect(() => {
    if (!userInputRequest) {
      answersRef.current = {}
      return
    }
    answersRef.current = resolveAnswers(userInputRequest, answers, customAnswers)
  }, [answers, customAnswers, userInputRequest])

  useEffect(() => {
    setDenyReason('')
    if (userInputRequest) {
      const initial = defaultAnswers(userInputRequest)
      answersRef.current = resolveAnswers(userInputRequest, initial, {})
      setAnswers(initial)
      setCustomAnswers({})
    } else {
      answersRef.current = {}
      setAnswers({})
      setCustomAnswers({})
    }
  }, [req?.toolUseID, userInputRequest])

  useEffect(() => {
    if (!req || !userInputRequest?.autoResolutionMs) {
      setSecondsLeft(null)
      return
    }

    const duration = userInputRequest.autoResolutionMs
    const startedAt = window.performance.now()
    setSecondsLeft(Math.ceil(duration / 1000))

    const intervalId = window.setInterval(() => {
      const remaining = Math.max(0, duration - (window.performance.now() - startedAt))
      setSecondsLeft(Math.ceil(remaining / 1000))
    }, 250)

    const timeoutId = window.setTimeout(() => {
      void respond(req.toolUseID, 'allow', undefined, answersRef.current)
    }, duration)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(timeoutId)
    }
  }, [req, respond, userInputRequest])

  if (!req) return null

  const isBash = req.toolName === 'Bash' || req.toolName === 'shell'
  const command = isBash ? (req.input as { command?: string })?.command : ''
  const inputJson = JSON.stringify(req.input, null, 2)

  const allow = (): void => {
    void respond(req.toolUseID, 'allow')
  }
  const deny = (): void => {
    void respond(req.toolUseID, 'deny', denyReason.trim() || undefined)
  }
  const submitAnswers = (): void => {
    void respond(req.toolUseID, 'allow', undefined, answersRef.current)
  }

  if (userInputRequest) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-md">
        <div className="glass-panel liquid-float-in w-full max-w-xl rounded-[22px] p-6 shadow-2xl">
          <div className="mb-1 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-accent" />
            <h2 className="text-base font-semibold text-zinc-100">需要你的选择</h2>
          </div>
          <p className="mb-4 text-sm text-zinc-400">
            Forge 正在等待你回答智能体的问题。
            {secondsLeft !== null ? <span className="text-zinc-500"> {secondsLeft}s 后自动选择推荐项。</span> : null}
          </p>

          <div className="mb-5 max-h-[52vh] space-y-4 overflow-auto pr-1">
            {userInputRequest.questions.map((question) => (
              <section key={question.id} className="rounded-xl border border-white/[0.08] bg-black/15 p-3">
                {question.header && (
                  <div className="mb-1 text-[11px] font-medium uppercase text-zinc-500">{question.header}</div>
                )}
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="text-sm font-medium leading-relaxed text-zinc-100">{question.question}</div>
                  {question.multiSelect && (
                    <span className="shrink-0 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-zinc-500">
                      多选
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {question.options.map((option) => {
                    const checked = isChoiceSelected(answers, question.id, option.label)
                    return (
                      <label
                        key={option.label}
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
                          checked
                            ? 'border-accent/45 bg-accent/10 text-zinc-100'
                            : 'border-white/[0.08] bg-white/[0.025] text-zinc-300 hover:bg-white/[0.055]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setAnswers((current) => selectChoice(current, question, option.label))
                          }
                          className="mt-0.5 h-4 w-4 flex-none accent-[#df765f]"
                        />
                        <span className="min-w-0">
                          <span className="block break-words text-sm">{option.label}</span>
                          {option.description && (
                            <span className="mt-0.5 block break-words text-xs leading-relaxed text-zinc-500">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${
                      isChoiceSelected(answers, question.id, OTHER_CHOICE)
                        ? 'border-accent/45 bg-accent/10 text-zinc-100'
                        : 'border-white/[0.08] bg-white/[0.025] text-zinc-300 hover:bg-white/[0.055]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChoiceSelected(answers, question.id, OTHER_CHOICE)}
                      onChange={() =>
                        setAnswers((current) => selectChoice(current, question, OTHER_CHOICE))
                      }
                      className="mt-0.5 h-4 w-4 flex-none accent-[#df765f]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">其他</span>
                      <input
                        value={customAnswers[question.id] ?? ''}
                        onFocus={() =>
                          setAnswers((current) =>
                            isChoiceSelected(current, question.id, OTHER_CHOICE)
                              ? current
                              : selectChoice(current, question, OTHER_CHOICE)
                          )
                        }
                        onChange={(event) => {
                          setAnswers((current) =>
                            isChoiceSelected(current, question.id, OTHER_CHOICE)
                              ? current
                              : selectChoice(current, question, OTHER_CHOICE)
                          )
                          setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                        }}
                        placeholder="输入自定义回答"
                        className="glass-control mt-2 w-full rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 outline-none focus:border-accent"
                      />
                    </span>
                  </label>
                </div>
              </section>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={deny}
              className="glass-control rounded-lg px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
            >
              取消
            </button>
            <button
              onClick={submitAnswers}
              className="accent-soft-button rounded-lg px-5 py-2 text-sm font-medium text-white hover:brightness-110"
            >
              提交
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-md">
      <div className="glass-panel liquid-float-in w-full max-w-lg rounded-[22px] p-6 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <h2 className="text-base font-semibold text-zinc-100">权限请求</h2>
        </div>
        <p className="mb-4 text-sm text-zinc-400">
          Forge 想要使用 <span className="font-mono text-zinc-200">{req.toolName}</span>
          {req.agentID ? <span className="text-zinc-500">（在子代理中）</span> : null}。
        </p>

        {req.decisionReason && (
          <p className="mb-3 text-xs text-zinc-500">{req.decisionReason}</p>
        )}

        {isBash && command ? (
          <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-[#0b0c10]/80 p-3 text-xs text-zinc-300">
            <span className="text-zinc-600">$ </span>
            {command}
          </pre>
        ) : (
          <pre className="mb-4 max-h-48 overflow-auto rounded-lg bg-[#0b0c10]/80 p-3 text-xs text-zinc-400">
            {inputJson}
          </pre>
        )}

        <input
          value={denyReason}
          onChange={(e) => setDenyReason(e.target.value)}
          placeholder="拒绝原因（可选）"
          className="glass-control mb-4 w-full rounded-lg px-3 py-2 text-xs text-zinc-300 outline-none focus:border-accent"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={deny}
            className="glass-control rounded-lg px-4 py-2 text-sm text-zinc-300 hover:bg-bg-hover"
          >
            拒绝
          </button>
          <button
            onClick={allow}
            className="accent-soft-button rounded-lg px-5 py-2 text-sm font-medium text-white hover:brightness-110"
          >
            允许
          </button>
        </div>
      </div>
    </div>
  )
}
