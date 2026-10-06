import type { NetworkName } from '../constants/tempo.js'
import type { Clock } from './clock.js'
import type { IdGenerator } from './idGenerator.js'
import type { KeyVault } from './keyVault.js'
import type { PayoutChain } from './payoutChain.js'
import type { CommunityRepository, PayeeRepository, RunRepository } from './repositories.js'

/** Everything `createPayrun` needs: one implementation of each port. */
export type PayrunDeps = {
  chain: PayoutChain
  repositories: { communities: CommunityRepository; payees: PayeeRepository; runs: RunRepository }
  vault: KeyVault
  ids: IdGenerator
  clock: Clock
  network: NetworkName
  /** How long a `/payee link` stays valid. Default 30 minutes. */
  linkTtlSeconds?: number
}
