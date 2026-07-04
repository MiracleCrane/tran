import type { ProviderClient, ProviderConfig } from '../types.js'
import { OpenAIAdapter } from './OpenAIAdapter.js'

/**
 * ProviderClient 工厂。按 provider.protocol 选择适配器；未标注时 P0 默认
 * OpenAI（覆盖面最广，智谱/DeepSeek/自建中转立即可用）。
 *
 * 后续 detect.ts 会按 baseUrl / 响应头自动探测协议；这里留扩展位。
 */
export function createProviderClient(provider: ProviderConfig): ProviderClient {
  const protocol = provider.protocol ?? 'openai'
  switch (protocol) {
    case 'openai':
      return new OpenAIAdapter(provider)
    case 'anthropic':
      // P1 再实现 AnthropicAdapter；P0 先抛出明确错误。
      throw new Error('Anvil Anthropic 协议适配器尚未实现（计划 P1）。请用 OpenAI 兼容运营商。')
    default: {
      const exhaustive: never = protocol
      throw new Error(`未知 provider 协议: ${String(exhaustive)}`)
    }
  }
}
