import { useCallback, useEffect, useState } from 'react'
import SettingText from './SettingText'
import SummaryApiSettings from './SummaryApiSettings'
import { useUiStore } from '../store/uiStore'
import { useTransientFlag } from '../hooks/useTransientFlag'

/** 与 SettingsPanel 的 ToggleControl 同款（项目惯例：各页面自带一颗，见
 *  PetSettings 的 PetToggle）——开关样式全站统一，但互不 import 页面内部组件。 */
function ToggleControl({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <div className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-45' : ''}`}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-zinc-200">{label}</div>
        {description && <SettingText className="mt-1">{description}</SettingText>}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-zinc-700'} ${disabled ? 'cursor-not-allowed' : ''}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-150 ease-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

/**
 * 侧栏「AI 功能」页（2026-08-27 用户改口：上一次把「AI 辅助」并入设置是错的方向，
 * AI 功能就该是侧栏一级入口，不进设置）。
 *
 * 内容 = 原设置「AI 功能」分类整段搬出：AI 自动命名 / 云端套餐额度 / 后台任务更新
 * 待办三颗开关 + DeepSeek 余额 Key + 摘要 / 命名 API（SummaryApiSettings，自足
 * 组件）。宠物总开关不在这儿——它在侧栏头部图标排（Alt+P 同一颗）。
 */
export default function AssistantPanel(): JSX.Element {
  const [aiNaming, setAiNaming] = useState(true)
  const [autoTodoNudge, setAutoTodoNudge] = useState(false)
  const [cloudUsage, setCloudUsage] = useState(false)
  // DeepSeek 余额（用量卡里那行）的 key，掩码回显模式：输入框只承载「本次新输入」，
  // 已配置状态用主进程回的掩码提示，界面上任何时刻都不留明文。
  const [deepseekApiKey, setDeepseekApiKey] = useState('')
  const [deepseekKeyMasked, setDeepseekKeyMasked] = useState<string | null>(null)
  // 「已保存」提示：连续保存不再互相踩定时器，卸载时也会清理。
  const [saved, flashSaved] = useTransientFlag()

  useEffect(() => {
    void window.api
      .getPreferences()
      .then((p) => {
        setAiNaming(p.aiNamingEnabled !== false)
        setAutoTodoNudge(p.autoTodoNudge === true)
        // opt-out：显式 false 才算关（与 usageService 的闸门一致）。
        setCloudUsage(p.cloudUsageEnabled !== false)
      })
      .catch(() => {})
    // DeepSeek key 状态独立拉（同样只回掩码）：它失败不值得拖垮整个初始化。
    void window.api
      .getDeepseekApiKeyStatus()
      .then((info) => setDeepseekKeyMasked(info.masked))
      .catch(() => {})
  }, [])

  /** AI 自动命名开关（默认开）：立即生效；关闭后主进程任何路径都不调命名 API。 */
  const toggleAiNaming = async (next: boolean): Promise<void> => {
    setAiNaming(next)
    try {
      await window.api.savePreferences({ aiNamingEnabled: next })
      flashSaved()
    } catch {
      setAiNaming(!next)
    }
  }

  /** 云端额度查询开关（**默认开**，opt-out）。复用 Kimi CLI 的登录凭证查
   *  api.kimi.com 的用量接口——这是查 5h / 每周额度的正确线路，2026-08-27
   *  改回默认开启；显式关闭后才不发请求。 */
  const toggleCloudUsage = async (next: boolean): Promise<void> => {
    setCloudUsage(next)
    try {
      await window.api.savePreferences({ cloudUsageEnabled: next })
      flashSaved()
    } catch {
      setCloudUsage(!next)
    }
  }

  /** 后台任务收尾后自动催 AI 更新待办。与命名那类小请求**不是一个量级**：
   *  那是一次真实对话轮，所以单独一个开关，不跟 AI 命名共用。 */
  const toggleAutoTodoNudge = async (next: boolean): Promise<void> => {
    setAutoTodoNudge(next)
    try {
      await window.api.savePreferences({ autoTodoNudge: next })
      flashSaved()
    } catch {
      setAutoTodoNudge(!next)
    }
  }

  /** DeepSeek 余额 key：保存逻辑与摘要 Key 同款——空输入忽略，清除走按钮，
   *  保存成功清空输入框并刷新掩码。主进程侧保存后会让余额缓存作废。 */
  const saveDeepseekKey = async (next: string): Promise<void> => {
    const trimmed = next.trim()
    if (!trimmed) return
    try {
      const info = await window.api.saveDeepseekApiKey(trimmed)
      setDeepseekKeyMasked(info.masked)
      setDeepseekApiKey('')
      flashSaved()
    } catch {
      /* 保留输入，方便用户修正后重试 */
    }
  }

  const clearDeepseekKey = async (): Promise<void> => {
    try {
      await window.api.saveDeepseekApiKey('')
      setDeepseekKeyMasked(null)
      setDeepseekApiKey('')
      flashSaved()
    } catch {
      /* 清除失败保持原状 */
    }
  }

  const backToChat = useCallback((): void => {
    useUiStore.getState().setView('chat')
  }, [])

  return (
    <div className="h-full overflow-y-auto bg-bg-base">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        {/* 吸顶标题栏（旧 TranslatePanel 同款）：下滚后"返回对话"仍可点。 */}
        <div className="sticky top-0 z-10 -mx-6 flex items-center gap-3 bg-bg-base/85 px-6 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={backToChat}
            className="glass-control flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] text-zinc-300 transition hover:bg-white/[0.08] hover:text-zinc-100"
          >
            ← 返回对话
          </button>
          <h1 className="text-lg font-semibold text-zinc-100">AI 功能</h1>
          {saved && <span className="text-xs text-emerald-400">已保存</span>}
        </div>

        <section className="glass-panel-soft rounded-2xl p-4">
          <div className="space-y-4">
            <ToggleControl
              label="AI 自动命名"
              description={
                '在新会话发送第一条消息后生成简短标题，也可用于补全历史会话标题。\n\n' +
                '每次命名约消耗 **120 token**。关闭后，Tran 不再发起自动命名请求。'
              }
              checked={aiNaming}
              onChange={(checked) => void toggleAiNaming(checked)}
            />
            <ToggleControl
              label="云端套餐额度显示"
              description={
                '在用量卡中显示 **5 小时额度**和**每周额度**。\n\n' +
                '数据来自 `api.kimi.com` 的用量接口，复用 Kimi Code CLI 的登录凭据，默认开启。\n\n' +
                '关闭后仅隐藏云端额度；本地 `/usage` 提供的上下文占用信息不受影响。'
              }
              checked={cloudUsage}
              onChange={(checked) => void toggleCloudUsage(checked)}
            />
            <ToggleControl
              label="后台任务结束后自动更新待办"
              description={
                '当后台任务结束且待办仍有未完成项时，自动发起一轮请求以刷新待办状态。\n\n' +
                '> **用量提示：** 该请求需要重新读取当前会话上下文，长会话可能产生较高用量，因此默认关闭。关闭后，Agent 会在下一次正常对话时收到任务完成通知。'
              }
              checked={autoTodoNudge}
              onChange={(checked) => void toggleAutoTodoNudge(checked)}
            />
            {/* DeepSeek 余额：官方 GET /user/balance，用量卡里展示一行。
                与下面的摘要 API 相互独立——那边可以是任何 OpenAI 兼容服务。 */}
            <div className="space-y-2">
              <div>
                <div className="text-xs font-medium text-zinc-200">DeepSeek 余额</div>
                <SettingText className="mt-1">
                  {'通过 DeepSeek 官方 `/user/balance` 接口，在用量卡中显示账户总额、充值余额和赠送余额。\n\n' +
                    '如果当前 AI 服务配置使用 DeepSeek，Tran 会优先复用该 API Key；只有在使用其他服务商且仍需查询 DeepSeek 余额时，才需要单独填写。\n\n' +
                    'API Key 使用系统安全存储保存。'}
                </SettingText>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={deepseekApiKey}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={deepseekKeyMasked ? `已配置 ${deepseekKeyMasked} · 输入新 Key 覆盖` : 'sk-...'}
                  onChange={(e) => setDeepseekApiKey(e.target.value)}
                  onBlur={(e) => void saveDeepseekKey(e.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-elev/60 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-accent/50"
                />
                {deepseekKeyMasked && (
                  <button
                    type="button"
                    onClick={() => void clearDeepseekKey()}
                    className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[11px] text-zinc-400 transition hover:bg-red-950/40 hover:text-red-300"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
            {/* 摘要 / 命名 API：会话命名、命令说明、思考摘要和模型翻译共用这套
                配置，自成组件（自己拉取/保存偏好），见 SummaryApiSettings.tsx。 */}
            <div className="border-t border-white/[0.06] pt-4">
              <SummaryApiSettings />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
