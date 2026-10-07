/**
 * @rolepay/core public API: the composition function, the services it returns, and the
 * domain types/schemas callers need. Adapter implementations are NOT exported here;
 * composition roots import them from `@rolepay/core/adapters`.
 */
import type { RolepayDeps } from './ports/deps.js'
import { AuditService, AuditTrail } from './services/auditTrail.js'
import { CommunityService } from './services/communityService.js'
import { PayeeService } from './services/payeeService.js'
import { PayRunService } from './services/payRunService.js'
import { PolicyService } from './services/policyService.js'
import { ProposalService } from './services/proposalService.js'
import { SchedulerService } from './services/schedulerService.js'

export type Rolepay = {
  communities: CommunityService
  payees: PayeeService
  payRuns: PayRunService
  /** AI-proposed pay runs (drafts that become normal runs). */
  proposals: ProposalService
  /** Standing policies: the AI writes the rule once, a treasurer approves it, code runs it. */
  policies: PolicyService
  /** Runs approved policies on schedule, with code only; the server calls `tick()` on an interval. */
  scheduler: SchedulerService
  /** The audit stream: every policy and run event, filterable, as CSV. */
  audit: AuditService
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
  const audit = new AuditTrail({ log: r.audit, policyRuns: r.policyRuns, clock, ...(deps.onAuditError ? { onError: deps.onAuditError } : {}) })
  const payRuns = new PayRunService({ runs: r.runs, payees: r.payees, communities: r.communities, chain, vault, ids, clock, network, audit, leases: deps.leases ?? null })
  const policies = new PolicyService({
    communities: r.communities,
    payees: r.payees,
    runs: r.runs,
    policies: r.policies,
    policyRuns: r.policyRuns,
    ids,
    clock,
    proposer: deps.proposer ?? null,
    activity: deps.activity ?? null,
    communityService: communities,
    payRuns,
    audit,
    ...(deps.proposalLog ? { log: deps.proposalLog } : {}),
    ...(deps.minVetoMinutes ? { minVetoMinutes: deps.minVetoMinutes } : {}),
  })
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
    policies,
    scheduler: new SchedulerService({
      communities: r.communities,
      payees: r.payees,
      runs: r.runs,
      policies: r.policies,
      policyRuns: r.policyRuns,
      ids,
      clock,
      activity: deps.activity ?? null,
      communityService: communities,
      payRuns,
      audit,
    }),
    audit: new AuditService({ log: r.audit }),
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
