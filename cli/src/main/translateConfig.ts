import { loadSettings, saveSettings, getBaiduSecret, setBaiduSecret } from './settings'
import { resetBaiduBreaker, translateViaBaidu } from './baidu'
import type { TranslateConfig, TranslateTestResult, TranslateEngine, ThinkingTranslateEngine } from '../shared/ipc'

/** Translate-engine config (Translate panel). Stored in tran-settings.json
 *  alongside providers/projects; the Baidu secretKey is safeStorage-encrypted. */

export function getTranslateConfig(): TranslateConfig {
  const s = loadSettings()
  return {
    engine: s.translateEngine ?? 'llm',
    thinkingEngine: s.thinkingTranslateEngine ?? 'follow',
    baidu: {
      appId: s.baiduAppId ?? '',
      secretKey: getBaiduSecret() ?? ''
    }
  }
}

/** Persist the engine choice + Baidu credentials. secretKey is encrypted at
 *  rest via setBaiduSecret. Only the provided keys are overwritten. */
export function saveTranslateConfig(cfg: TranslateConfig): TranslateConfig {
  const s = loadSettings()
  s.translateEngine = cfg.engine
  s.thinkingTranslateEngine = cfg.thinkingEngine
  s.baiduAppId = cfg.baidu.appId
  setBaiduSecret(cfg.baidu.secretKey)
  saveSettings(s)
  // 换了凭据/引擎就把熔断放开：给新配置一次机会（见 baidu.ts 的熔断说明）。
  resetBaiduBreaker()
  return getTranslateConfig()
}

/** Credentials for translate.ts to use, or null if Baidu isn't configured. */
export function getBaiduCreds(): { appId: string; secretKey: string } | null {
  const s = loadSettings()
  const secretKey = getBaiduSecret()
  if (!s.baiduAppId || !secretKey) return null
  return { appId: s.baiduAppId, secretKey }
}

/** Which engine translateTexts() should route to. */
export function getTranslateEngine(): TranslateConfig['engine'] {
  return loadSettings().translateEngine ?? 'llm'
}

/** 用户在设置里选的思考翻译引擎（未选过 = 'follow'，即跟随描述翻译）。 */
export function getThinkingTranslateEngine(): ThinkingTranslateEngine {
  return loadSettings().thinkingTranslateEngine ?? 'follow'
}

/**
 * 思考翻译最终落到哪条通道。
 *
 * 'auto' 的含义是「优先免费、但绝不因此让功能消失」：配了百度密钥就走百度
 * （免费额度内不花钱），没配则回落到摘要旁路的便宜模型。
 *
 * 为什么不干脆把默认值设成 'baidu'：没配密钥的用户会**静默失去翻译**——
 * translateViaBaiduEngine 拿不到凭据只会记一行日志然后返回 null，界面上就是
 * 「展开思考还是一屏英文」，而用户根本不知道是自己没填密钥。
 */
export function resolveThinkingTranslateEngine(): TranslateEngine {
  const choice = getThinkingTranslateEngine()
  // follow = 用技能描述翻译那一个开关，默认就是它：两套引擎多数人不需要。
  if (choice === 'follow') return getTranslateEngine()
  if (choice === 'auto') return getBaiduCreds() ? 'baidu' : 'llm'
  return choice
}

/** Test Baidu credentials by translating a sample — does NOT persist. */
export async function testTranslate(
  appId: string,
  secretKey: string
): Promise<TranslateTestResult> {
  if (!appId.trim() || !secretKey.trim()) {
    return { ok: false, error: '请填写完整的 appId 与 secretKey' }
  }
  try {
    const [translated] = await translateViaBaidu(['hello world'], appId.trim(), secretKey.trim())
    if (!translated) return { ok: false, error: '翻译返回为空,请检查凭据' }
    return { ok: true, translated }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
