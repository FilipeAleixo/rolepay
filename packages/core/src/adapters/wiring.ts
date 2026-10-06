import type { PayrunConfig } from '../config/env.js'
import type { PayrunDeps } from '../ports/deps.js'
import type { KeyValueStore } from '../ports/keyValueStore.js'
import { AesGcmKeyVault, RandomIds, SystemClock } from './crypto/index.js'
import { openSqliteDatabase } from './sqlite/index.js'
import { TempoPayoutChain } from './tempo/index.js'

/**
 * The production adapters, opened from config: SQLite file, AES-256-GCM vault,
 * Tempo chain, random IDs, system clock. For composition roots:
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
    },
    /** Same database: passkey credentials and sessions, delivery markers. */
    kv: db.kv,
    close: db.close,
  }
}
