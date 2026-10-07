/**
 * @rolepay/core public API: the composition function, the services it returns, and the
 * domain types/schemas callers need. Adapter implementations are NOT exported here;
 * composition roots import them from `@rolepay/core/adapters`.
 */
import type { RolepayDeps } from './ports/deps.js'
import { CommunityService } from './services/communityService.js'
import { PayeeService } from './services/payeeService.js'
import { PayRunService } from './services/payRunService.js'
import { ProposalService } from './services/proposalService.js'

export type Rolepay = {
  communities: CommunityService
  payees: PayeeService
  payRuns: PayRunService
  /** AI-proposed pay runs (drafts that become normal runs). */
  proposals: ProposalService
}

export const DEFAULT_LINK_TTL_SECONDS = 1800

export function createRolepay(deps: RolepayDeps): Rolepay {
  const { chain, repositories: r, vault, ids, clock, network } = deps
  const communities = new CommunityService({
    communities: r.communities,
    chain,
    vault,
    clock,
    network,
    ids,
    setupLinkTtlSeconds: deps.linkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
  })
  const payRuns = new PayRunService({ runs: r.runs, payees: r.payees, communities: r.communities, chain, vault, ids, clock, network, leases: deps.leases ?? null })
  return {
    communities,
    payees: new PayeeService({
      communities: r.communities,
      payees: r.payees,
      vault,
      ids,
      clock,
      linkTtlSeconds: deps.linkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
    }),
    payRuns,
    proposals: new ProposalService({
      communities: r.communities,
      payees: r.payees,
      runs: r.runs,
      proposals: r.proposals,
      ids,
      clock,
      proposer: deps.proposer ?? null,
      activity: deps.activity ?? null,
      communityService: communities,
      payRuns,
      ...(deps.proposalLog ? { log: deps.proposalLog } : {}),
    }),
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
