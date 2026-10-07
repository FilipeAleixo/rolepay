// Test fixtures: valid domain objects with overridable fields.
import type { NewAiUsage } from '../../src/domain/aiUsage.js'
import type { BotKey, Community, SetupLink } from '../../src/domain/community.js'
import type { LinkToken, Payee } from '../../src/domain/payee.js'
import type { NewAuditEvent } from '../../src/domain/policy/audit.js'
import type { Policy, PolicyVersion } from '../../src/domain/policy/policy.js'
import type { PolicyRun } from '../../src/domain/policy/policyRun.js'
import type { Proposal } from '../../src/domain/proposal/proposal.js'
import { type Run, type RunEvent, newRun, transition } from '../../src/domain/run.js'

export const GUILD = '1094309218049937418'
export const OTHER_GUILD = '1094309218049937419'
export const ALICE = '200000000000000001'
export const BOB = '200000000000000002'
export const CAROL = '200000000000000003'
export const TREASURER = '300000000000000001'
export const TOKEN = '0x20c0000000000000000000000000000000000001'
export const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const ADDR = {
  alice: '0x1111111111111111111111111111111111111111',
  bob: '0x2222222222222222222222222222222222222222',
  carol: '0x3333333333333333333333333333333333333333',
} as const
export const T0 = new Date('2026-10-06T12:00:00.000Z')
export const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

export function community(over: Partial<Community> = {}): Community {
  return {
    id: GUILD,
    name: 'Test guild',
    network: 'moderato',
    treasuryAddress: TREASURY,
    payoutToken: TOKEN,
    feeMode: 'sponsor',
    feeToken: null,
    approverRoleId: null,
    requireSeparateApprover: false,
    aiProposals: false,
    proposerRoleId: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function botKey(over: Partial<BotKey> = {}): BotKey {
  return {
    address: '0x4444444444444444444444444444444444444444',
    communityId: GUILD,
    sealedSecret: 'sealed:v1:abc',
    status: 'pending_authorization',
    policy: {
      token: TOKEN,
      limit: 10_000_000n,
      periodSeconds: 2_592_000,
      expiresAt: 1_800_000_000,
      recipients: null,
      feeToken: null,
      feeBudget: null,
    },
    createdAt: T0,
    authorizedAt: null,
    revokedAt: null,
    ...over,
  }
}

export function setupLink(over: Partial<SetupLink> = {}): SetupLink {
  return {
    tokenHash: 'fp_setup_1',
    communityId: GUILD,
    discordUserId: TREASURER,
    settings: { name: 'Test guild', payoutToken: TOKEN, feeMode: 'sponsor', feeToken: null, approverRoleId: '400000000000000001', requireSeparateApprover: false },
    createdAt: T0,
    expiresAt: at(1800),
    ...over,
  }
}

export function payee(over: Partial<Payee> = {}): Payee {
  return { communityId: GUILD, discordUserId: ALICE, address: ADDR.alice, registeredAt: T0, updatedAt: T0, ...over }
}

export function linkToken(over: Partial<LinkToken> = {}): LinkToken {
  return {
    tokenHash: 'fp_1',
    communityId: GUILD,
    discordUserId: ALICE,
    createdAt: T0,
    expiresAt: at(1800),
    consumedAt: null,
    ...over,
  }
}

export function run(over: { id?: string; communityId?: string; createdAt?: Date } = {}): Run {
  const r = newRun({
    id: over.id ?? 'run_fixture01',
    communityId: over.communityId ?? GUILD,
    token: TOKEN,
    note: 'October mods',
    createdBy: ALICE,
    lines: [
      { payeeDiscordId: ALICE, address: ADDR.alice, amount: 1_500_000n },
      { payeeDiscordId: BOB, address: ADDR.bob, amount: 2_000_000n },
    ],
    now: over.createdAt ?? T0,
  })
  if (!r.ok) throw new Error(`fixture run: ${r.error.code}`)
  return r.value
}

/** Applies events, throwing on the first illegal one. */
export function advance(r: Run, ...events: RunEvent[]): Run {
  return events.reduce((current, e, i) => {
    const n = transition(current, e, at(i + 1))
    if (!n.ok) throw new Error(`fixture transition ${e.type}: ${n.error.code}`)
    return n.value
  }, r)
}

/** An open criteria-mode proposal with one line, one held line, one unregistered person and a scan. */
export function proposal(over: Partial<Proposal> = {}): Proposal {
  const line = { discordUserId: ALICE, amount: 20_000_000n, reason: null, metrics: { messages: null, activeDays: null, replies: 34 }, sources: [], flags: [] }
  return {
    id: 'prop_fixture01',
    communityId: GUILD,
    proposedBy: TREASURER,
    mode: 'criteria',
    token: TOKEN,
    instruction: 'pay 20 to every Mod who answered at least 10 questions in #help this month',
    note: 'October help desk',
    source: null,
    criteria: {
      hasRole: ['400000000000000002'],
      lacksRole: [],
      joinedBefore: null,
      joinedAfter: null,
      messagesIn: null,
      activeDaysIn: null,
      repliesIn: { channelIds: ['700000000000000001'], since: at(-30 * 86_400), until: T0, min: 10 },
      reactedTo: null,
      mentionedIn: null,
      postedIn: null,
      paidInRun: null,
      exclude: [],
      excludeProposer: false,
    },
    amountPlan: { rule: { kind: 'flat', amount: 20_000_000n }, overrides: [], perPersonCap: null },
    scans: [{ channelId: '700000000000000001', since: at(-30 * 86_400), until: T0, messages: 1234, truncated: false }],
    lines: [line],
    held: [{ ...line, discordUserId: BOB, amount: null, holds: ['amount_unreadable'] }],
    unregistered: [{ ...line, discordUserId: CAROL }],
    unresolved: [{ text: 'the new mod', why: 'not a member' }],
    assumptions: ['"this month" means the last 30 days'],
    suspicious: [],
    total: 20_000_000n,
    remaining: 100_000_000n,
    problems: [],
    status: 'open',
    runId: null,
    editedBy: null,
    closedBy: null,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: at(86_400),
    ...over,
  }
}

/** An active weekly policy (v1): 1 per reply in #help for Mods, capped at 50 each. */
export function policy(over: Partial<Policy> = {}): Policy {
  return {
    id: 'pol_fixture01',
    communityId: GUILD,
    name: 'Help desk',
    instruction: 'Every Monday: 1 per answered question in #help, max 50 a week each, for Mods',
    compiled: {
      criteria: { ...(proposal().criteria as NonNullable<Proposal['criteria']>), repliesIn: { channelIds: ['700000000000000001'], since: at(-7 * 86_400), until: T0, min: 1 } },
      plan: { rule: { kind: 'perUnit', amount: 1_000_000n, per: 'replies', cap: 50_000_000n }, overrides: [], perPersonCap: null },
      note: 'Help desk',
      assumptions: ['"a week" means since the previous run'],
      amountsInInstruction: true,
    },
    schedule: { kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'Europe/Lisbon' },
    caps: { perRun: 500_000_000n, perPerson: null },
    channelId: '700000000000000009',
    status: 'active',
    version: 1,
    mode: 'propose',
    vetoWindowMinutes: 1440,
    autopilot: null,
    createdBy: TREASURER,
    createdAt: T0,
    updatedAt: T0,
    approvedBy: TREASURER,
    approvedAt: at(60),
    activeSince: at(60),
    rev: 0,
    ...over,
  }
}

/** The version row matching a policy's current definition. */
export function policyVersion(p: Policy = policy(), over: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    policyId: p.id,
    communityId: p.communityId,
    version: p.version,
    name: p.name,
    instruction: p.instruction,
    compiled: p.compiled,
    schedule: p.schedule,
    caps: p.caps,
    authoredBy: p.createdBy,
    authoredAt: p.createdAt,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    discardedBy: null,
    discardedAt: null,
    ...over,
  }
}

/** A scheduled autopilot run of the fixture policy, with two lines and one unregistered person. */
export function policyRun(over: Partial<PolicyRun> = {}): PolicyRun {
  return {
    id: 'prun_fixture01',
    policyId: 'pol_fixture01',
    policyVersion: 1,
    communityId: GUILD,
    periodKey: at(7 * 86_400).toISOString(),
    periodStart: T0,
    periodEnd: at(7 * 86_400),
    mode: 'autopilot',
    status: 'scheduled',
    runId: 'run_fixture01',
    executeAfter: at(8 * 86_400),
    lines: [
      { discordUserId: ALICE, amount: 12_000_000n, metrics: { messages: null, activeDays: null, replies: 12 }, capped: false },
      { discordUserId: BOB, amount: 50_000_000n, metrics: { messages: null, activeDays: null, replies: 70 }, capped: true },
    ],
    unregistered: [{ discordUserId: CAROL, metrics: { messages: null, activeDays: null, replies: 3 } }],
    total: 62_000_000n,
    remaining: 100_000_000n,
    problems: [],
    hold: null,
    vetoedBy: null,
    vetoedAt: null,
    releasedBy: null,
    releasedAt: null,
    leaseUntil: null,
    createdAt: at(7 * 86_400),
    updatedAt: at(7 * 86_400),
    rev: 1,
    ...over,
  }
}

export function auditEvent(over: Partial<NewAuditEvent> = {}): NewAuditEvent {
  return { communityId: GUILD, at: T0, type: 'policy.created', actor: TREASURER, policyId: 'pol_fixture01', policyVersion: 1, policyRunId: null, runId: null, details: { mode: 'propose' }, ...over }
}

/** A warm message-mode proposal on Sonnet 5.5 that was drafted. */
export function aiUsage(over: Partial<NewAiUsage> = {}): NewAiUsage {
  return {
    communityId: GUILD,
    purpose: 'proposal_messages',
    actor: TREASURER,
    model: 'claude-sonnet-5-5',
    inputTokens: 412,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1844,
    outputTokens: 300,
    latencyMs: 2100,
    costMicroUsd: 3_869n,
    outcome: 'proposed',
    createdAt: T0,
    proposalId: 'prop_fixture01',
    runId: null,
    policyId: null,
    policyVersion: null,
    ...over,
  }
}
