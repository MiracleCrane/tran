import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { log } from './logger'
import type { MarketplacePlugin } from '../shared/ipc'

/**
 * Read-only browser for local plugin marketplace catalogs. Claude Code clones
 * marketplaces under ~/.claude/plugins/marketplaces/<name>/, each with a
 * .claude-plugin/marketplace.json manifest listing available plugins (which
 * bundle skills). We surface that catalog for browsing; installation stays with
 * Claude's native /plugin command (no SDK install API, and we won't risk
 * corrupting ~/.claude.json by reimplementing it).
 */

function marketplacesRoot(): string {
  return join(homedir(), '.claude', 'plugins', 'marketplaces')
}

interface RawPlugin {
  name: string
  description?: string
  author?: { name?: string }
  category?: string
  homepage?: string
  source?: { url?: string }
}
interface RawManifest {
  name?: string
  plugins?: RawPlugin[]
}

export function listMarketplacePlugins(): MarketplacePlugin[] {
  const root = marketplacesRoot()
  if (!existsSync(root)) {
    log('marketplace', `no marketplaces dir at ${root}`)
    return []
  }

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (e) {
    log('marketplace', `readdir failed: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }

  const out: MarketplacePlugin[] = []
  for (const mp of entries) {
    const manifestPath = join(root, mp, '.claude-plugin', 'marketplace.json')
    if (!existsSync(manifestPath)) continue
    let parsed: RawManifest
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest
    } catch (e) {
      log('marketplace', `skip ${mp}: bad manifest (${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    const marketplaceName = parsed.name ?? mp
    for (const p of parsed.plugins ?? []) {
      out.push({
        name: p.name,
        description: p.description ?? '',
        author: p.author?.name,
        category: p.category,
        homepage: p.homepage,
        sourceUrl: p.source?.url,
        marketplace: marketplaceName
      })
    }
  }
  log('marketplace', `loaded ${out.length} plugins from ${entries.length} marketplace(s)`)
  return out
}
