import type { PayrunConfig } from '../config/env.js'
import type { PayrunDeps } from '../ports/deps.js'
import type { KeyValueStore } from '../ports/keyValueStore.js'
import { AnthropicRunProposer } from './anthropic/index.js'
import { AesGcmKeyVault, RandomIds, SystemClock } from './crypto/index.js'
import { openSqliteDatabase } from './sqlite/index.js'
import { TempoPayoutChain } from './tempo/index.js'

/**
 * The production adapters, opened from config: SQLite file, AES-256-GCM vault,
 * Tempo chain, random IDs, system clock, and Anthropic's API when ANTHROPIC_API_KEY is set
 * (AI proposals; the Discord activity reader is added by the server). For composition roots:
 *
 *   const { deps, close } = await openPayrunAdapters(parseConfig(process.env))
 *   const payrun = createPayrun(deps)
 */
export async function openPayrunAdapters(
  config: PayrunConfig,
): Promise<{ deps: PayrunDeps; kv: KeyValueStore; close: () => Promise<void> }> {
  const clock = new SystemClock()
  const db = await openSqliteDatabase(config.dbPath, { clock })
  return {
    deps: {
      chain: new TempoPayoutChain({ network: config.network, rpcUrl: config.rpcUrl, sponsorUrl: config.sponsorUrl }),
      repositories: db.repositories,
      vault: new AesGcmKeyVault(config.masterKey),
      ids: new RandomIds(),
      clock,
      network: config.network,
      linkTtlSeconds: config.linkTtlSeconds,
      proposer: config.ai.apiKey ? new AnthropicRunProposer({ apiKey: config.ai.apiKey, model: config.ai.model }) : null,
    },
    /** Same database: passkey credentials and sessions, delivery markers. */
    kv: db.kv,
    close: db.close,
  }
}
