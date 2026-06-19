import { loadSettings, saveSettings, getBaiduSecret, setBaiduSecret } from './settings'
import { translateViaBaidu } from './baidu'
import type { TranslateConfig, TranslateTestResult } from '../shared/ipc'

/** Translate-engine config (Translate panel). Stored in forge-settings.json
 *  alongside providers/projects; the Baidu secretKey is safeStorage-encrypted. */

export function getTranslateConfig(): TranslateConfig {
  const s = loadSettings()
  return {
    engine: s.translateEngine ?? 'llm',
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
  s.baiduAppId = cfg.baidu.appId
  setBaiduSecret(cfg.baidu.secretKey)
  saveSettings(s)
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
