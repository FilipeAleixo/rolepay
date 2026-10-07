import { PROPOSAL_LIMITS } from '../constants/limits.js'
import { type AmountPlan, type Amounted, applyAmountPlan } from '../domain/proposal/amounts.js'
import {
  type Criteria,
  type CriteriaError,
  type CriteriaEvidence,
  type CriteriaVerdict,
  type ScannedMessage,
  evaluateCriteria,
  needsMembers,
  scanPlan,
  seenUsers,
} from '../domain/proposal/criteria.js'
import type { ChannelScan } from '../domain/proposal/proposal.js'
import type { ActivityReader, ReadError } from '../ports/activityReader.js'
import type { PayeeRepository, RunRepository } from '../ports/repositories.js'

export type CriteriaRunnerDeps = { activity: ActivityReader; payees: PayeeRepository; runs: RunRepository }

/** What running a compiled rule over a community found. `amounts` covers the registered matches (an amount may be 0). */
export type CriteriaRun = {
  /** The criteria as run: `paidInRun.last` resolved to the run it meant. */
  criteria: Criteria
  registered: ReadonlySet<string>
  /** Registered payees (by ID), then people the activity shows who are not registered. */
  candidates: string[]
  evidence: CriteriaEvidence
  verdicts: CriteriaVerdict[]
  matched: CriteriaVerdict[]
  amounts: Amounted[]
  scans: ChannelScan[]
  scannedMessages: number
}

export type RunCriteriaResult = { ok: true; value: CriteriaRun } | { ok: false; error: ReadError | CriteriaError; scannedMessages: number }

const DAY_MS = 86_400_000
const byId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

/**
 * Runs checked criteria and an amount plan over a community, with code only: reads what the
 * criteria need through the ActivityReader (within 31 days, 10,000 messages, 5 channels), the
 * registered payees and Rolepay's own runs, then evaluates every candidate. Shared by criteria
 * mode proposals and by standing policies (where it is all that runs on schedule: no AI).
 */
export async function runCriteria(
  deps: CriteriaRunnerDeps,
  input: { communityId: string; criteria: Criteria; plan: AmountPlan; authorId: string; now: Date },
): Promise<RunCriteriaResult> {
  const { activity } = deps
  const { now } = input
  const criteria: Criteria = { ...input.criteria }
  const scans: ChannelScan[] = []
  const scanned: ScannedMessage[] = []
  const fail = (error: ReadError | CriteriaError) => ({ ok: false as const, error, scannedMessages: scanned.length })
  let budget: number = PROPOSAL_LIMITS.maxScannedMessages
  const read = async (channelId: string, since: Date, until: Date) => {
    const r = await activity.history({ channelId, since, until, limit: budget })
    if (!r.ok) return r
    budget -= r.value.messages.length
    scans.push({ channelId, since, until, messages: r.value.messages.length, truncated: r.value.truncated })
    return { ok: true as const, value: r.value.messages.filter((m) => !m.authorIsBot) }
  }
  const span = scanPlan(criteria)
  for (const channelId of span?.channelIds ?? []) {
    const r = await read(channelId, span?.since as Date, span?.until as Date)
    if (!r.ok) return fail(r.error)
    scanned.push(...r.value.map((m) => ({ channelId: m.channelId, authorId: m.authorId, at: m.at, replyToAuthorId: m.replyTo?.authorId ?? null })))
  }
  const evidence: { -readonly [K in keyof CriteriaEvidence]: CriteriaEvidence[K] } = { messages: scanned, reactors: null, mentioned: null, threadPosters: null, paidUserIds: null, members: {} }
  if (criteria.postedIn) {
    const r = await read(criteria.postedIn.threadId, new Date(now.getTime() - PROPOSAL_LIMITS.maxLookbackDays * DAY_MS), now)
    if (!r.ok) return fail(r.error)
    evidence.threadPosters = [...new Set(r.value.map((m) => m.authorId))]
  }
  if (criteria.reactedTo) {
    const r = await activity.reactions({ ...criteria.reactedTo, limit: 1000 })
    if (!r.ok) return fail(r.error)
    evidence.reactors = r.value.userIds
  }
  if (criteria.mentionedIn) {
    const r = await activity.message(criteria.mentionedIn)
    if (!r.ok) return fail(r.error)
    evidence.mentioned = r.value.mentionIds
  }
  if (criteria.paidInRun) {
    const run = criteria.paidInRun.last
      ? (await deps.runs.listByCommunity(input.communityId, { limit: 50 })).find((r) => r.status === 'paid')
      : await deps.runs.get(criteria.paidInRun.runId as string)
    const paid = run && run.communityId === input.communityId && run.status === 'paid' ? run : null
    criteria.paidInRun = { ...criteria.paidInRun, runId: paid?.id ?? criteria.paidInRun.runId }
    evidence.paidUserIds = paid ? paid.lines.map((l) => l.payeeDiscordId) : []
  }

  // Candidates: the registered payees, plus (to list them) people the evidence shows who are not.
  const registered = new Set((await deps.payees.list(input.communityId)).map((p) => p.discordUserId))
  const others = seenUsers(criteria, evidence)
    .filter((u) => !registered.has(u))
    .slice(0, PROPOSAL_LIMITS.maxUnregisteredCandidates)
  const candidates = [...[...registered].sort(byId), ...others]
  if (needsMembers(criteria)) evidence.members = await activity.members(input.communityId, candidates)
  const verdicts = evaluateCriteria(criteria, evidence, candidates, input.authorId)
  const matched = verdicts.filter((v) => v.matched)

  const amounts = applyAmountPlan(
    input.plan,
    matched.filter((v) => registered.has(v.userId)),
  )
  if (!amounts.ok) {
    const issue = amounts.error.code === 'overrides_exceed_pool' ? 'the overrides add up to more than the pool' : 'the amount depends on a count the criteria do not make'
    return fail({ code: 'criteria_invalid', issues: [issue] })
  }
  return { ok: true, value: { criteria, registered, candidates, evidence, verdicts, matched, amounts: amounts.value, scans, scannedMessages: scanned.length } }
}
