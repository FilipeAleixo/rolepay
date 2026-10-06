/**
 * @payrun/core public API: the composition function, the services it returns, and the
 * domain types/schemas callers need. Adapter implementations are NOT exported here;
 * composition roots import them from `@payrun/core/adapters`.
 */
import type { NetworkName } from './constants/tempo.js'
import type { Clock } from './ports/clock.js'
import type { IdGenerator } from './ports/idGenerator.js'
import type { KeyVault } from './ports/keyVault.js'
import type { PayoutChain } from './ports/payoutChain.js'
import type { CommunityRepository, PayeeRepository, RunRepository } from './ports/repositories.js'
import { CommunityService } from './services/communityService.js'
import { PayeeService } from './services/payeeService.js'
import { PayRunService } from './services/payRunService.js'

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

export type Payrun = {
  communities: CommunityService
  payees: PayeeService
  payRuns: PayRunService
}

export const DEFAULT_LINK_TTL_SECONDS = 1800

export function createPayrun(deps: PayrunDeps): Payrun {
  const { chain, repositories: r, vault, ids, clock, network } = deps
  return {
    communities: new CommunityService({ communities: r.communities, chain, vault, clock, network }),
    payees: new PayeeService({
      communities: r.communities,
      payees: r.payees,
      vault,
      ids,
      clock,
      linkTtlSeconds: deps.linkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
    }),
    payRuns: new PayRunService({ runs: r.runs, payees: r.payees, communities: r.communities, chain, vault, ids, clock, network }),
  }
}

export * from './config/env.js'
export * from './constants/limits.js'
export * from './constants/memo.js'
export * from './constants/tempo.js'
export * from './constants/token.js'
export * from './domain/index.js'
export type * from './ports/index.js'
export * from './services/index.js'
