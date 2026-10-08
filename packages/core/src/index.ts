/**
 * @rolepay/core public API: the composition function, the services it returns, and the
 * domain types/schemas callers need. Adapter implementations are NOT exported here;
 * composition roots import them from `@rolepay/core/adapters`.
 */
import type { RolepayDeps } from './ports/deps.js'
import { AiUsageService } from './services/aiUsageService.js'
import { AuditService, AuditTrail } from './services/auditTrail.js'
import { CommunityService } from './services/communityService.js'
import { FundingService } from './services/fundingService.js'
import { LiveService } from './services/liveService.js'
import { PayeeService } from './services/payeeService.js'
import { PayRunService } from './services/payRunService.js'
import { PolicyKeyService } from './services/policyKeyService.js'
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
  /** A policy's own access key ("its own budget"): authorised by the treasury passkey, used for that policy's runs only. */
  policyKeys: PolicyKeyService
  /** Runs approved policies on schedule, with code only; the server calls `tick()` on an interval. */
  scheduler: SchedulerService
  /** The audit stream: every policy and run event, filterable, as CSV. */
  audit: AuditService
  /** What the AI cost: one content-free row per model call, the month's spend. */
  aiUsage: AiUsageService
  /** Funding with attribution: deposit addresses (virtual addresses) per funding source, and the deposits they received. */
  funding: FundingService
  /** Live updates for the web pages: a community's events and the payments to one address, as they happen. */
  live: LiveService
}

export const DEFAULT_LINK_TTL_SECONDS = 1800

export function createRolepay(deps: RolepayDeps): Rolepay {
  const { chain, repositories: r, vault, ids, clock, network } = deps
  // Daily policy schedules: the testnet demo only, never off Moderato.
  const demoControls = deps.demoControls === true && network === 'moderato'
  const audit = new AuditTrail({ log: r.audit, policyRuns: r.policyRuns, clock, live: deps.live ?? null, ...(deps.onAuditError ? { onError: deps.onAuditError } : {}) })
  const communities = new CommunityService({
    communities: r.communities,
    chain,
    vault,
    clock,
    network,
    ids,
    setupLinkTtlSeconds: deps.linkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
    audit,
  })
  const policyKeys = new PolicyKeyService({ communities: r.communities, policies: r.policies, policyKeys: r.policyKeys, chain, vault, clock, audit, communityService: communities })
  const payRuns = new PayRunService({
    runs: r.runs,
    payees: r.payees,
    communities: r.communities,
    policyRuns: r.policyRuns,
    policyKeys: r.policyKeys,
    chain,
    vault,
    ids,
    clock,
    network,
    audit,
    leases: deps.leases ?? null,
    ...(deps.swapMaxSlippageBps !== undefined ? { swapMaxSlippageBps: deps.swapMaxSlippageBps } : {}),
  })
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
    policyKeys,
    payRuns,
    audit,
    aiUsage: r.aiUsage,
    ...(deps.proposalLog ? { log: deps.proposalLog } : {}),
    ...(deps.minVetoMinutes ? { minVetoMinutes: deps.minVetoMinutes } : {}),
    demoControls,
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
      network,
      signatures: deps.signatures ?? null,
      audit,
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
      aiUsage: r.aiUsage,
      ...(deps.proposalLog ? { log: deps.proposalLog } : {}),
    }),
    policies,
    policyKeys,
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
      policyKeys,
      payRuns,
      audit,
      demoControls,
    }),
    audit: new AuditService({ log: r.audit }),
    aiUsage: new AiUsageService({ usage: r.aiUsage, clock }),
    funding: new FundingService({ funding: r.funding, communities: r.communities, chain: deps.fundingChain ?? null, ids, clock, audit }),
    live: new LiveService({
      feed: deps.live ?? null,
      audit: r.audit,
      runs: r.runs,
      payees: r.payees,
      communities: r.communities,
      clock,
      ...(deps.onAuditError ? { onError: deps.onAuditError } : {}),
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
