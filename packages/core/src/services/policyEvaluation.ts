import { POLICY_LIMITS } from '../constants/limits.js'
import { type Micros, sumAmounts } from '../domain/money.js'
import { type CompiledRule, type MatchReason, type NearMiss, type PolicyCaps, capLines, describeMatch, matchReasons, nearMisses, windowedCriteria } from '../domain/policy/policy.js'
import type { PolicyRunLine } from '../domain/policy/policyRun.js'
import type { Metrics } from '../domain/proposal/amounts.js'
import type { Criteria, CriteriaError } from '../domain/proposal/criteria.js'
import type { ChannelScan } from '../domain/proposal/proposal.js'
import { type Result, err, ok } from '../domain/result.js'
import type { ReadError } from '../ports/activityReader.js'
import { type CriteriaRunnerDeps, runCriteria } from './criteriaRunner.js'

/** One person a policy applies to: their counts, why they match, and what a run pays them (null: not registered, so nothing). */
export type PolicyMatch = {
  discordUserId: string
  registered: boolean
  metrics: Metrics
  amount: Micros | null
  capped: boolean
  reasons: MatchReason[]
  /** The reasons in plain words, with Discord mentions (`<@&role>`, `<#channel>`). */
  reasonText: string
}

export type PolicyEvaluation = {
  /** The criteria as run (windows on the period, `paidInRun.last` resolved). */
  criteria: Criteria
  /** Registered matches, amount desc then ID, then the unregistered ones. */
  matches: PolicyMatch[]
  /** What a run would pay: registered matches with an amount above zero, the per-person cap applied. */
  lines: PolicyRunLine[]
  unregistered: { discordUserId: string; metrics: Metrics }[]
  total: Micros
  nearMisses: (NearMiss & { text: string })[]
  scans: ChannelScan[]
  /** scan_truncated: the 10,000-message bound stopped a scan, so some counts may be low. */
  problems: string[]
}

const byId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

/**
 * Runs a policy's compiled rule over one period with code only (no AI): the counting windows move
 * onto the period, the shared criteria runner reads Discord and evaluates, the policy's per-person
 * cap is applied after the rule. Used for "who it applies to right now" and by the scheduler.
 */
export async function evaluatePolicy(
  deps: CriteriaRunnerDeps,
  input: { communityId: string; compiled: CompiledRule; caps: PolicyCaps; authorId: string; window: { start: Date; end: Date }; now: Date },
): Promise<Result<PolicyEvaluation, ReadError | CriteriaError>> {
  const criteria = windowedCriteria(input.compiled.criteria, input.window)
  const ran = await runCriteria(deps, { communityId: input.communityId, criteria, plan: input.compiled.plan, authorId: input.authorId, now: input.now })
  if (!ran.ok) return err(ran.error)
  const r = ran.value
  const amountOf = new Map(capLines(r.amounts, input.caps.perPerson).map((a) => [a.userId, a]))
  const matches: PolicyMatch[] = r.matched.map((v) => {
    const a = amountOf.get(v.userId)
    const reasons = matchReasons(r.criteria, v)
    return {
      discordUserId: v.userId,
      registered: r.registered.has(v.userId),
      metrics: v.metrics,
      amount: a ? a.amount : null,
      capped: a?.capped ?? false,
      reasons,
      reasonText: describeMatch(r.criteria, reasons),
    }
  })
  matches.sort((a, b) => {
    if (a.registered !== b.registered) return a.registered ? -1 : 1
    const x = a.amount ?? 0n
    const y = b.amount ?? 0n
    return x === y ? byId(a.discordUserId, b.discordUserId) : x > y ? -1 : 1
  })
  const lines = matches
    .filter((m): m is PolicyMatch & { amount: Micros } => m.registered && m.amount !== null && m.amount > 0n)
    .map((m) => ({ discordUserId: m.discordUserId, amount: m.amount, metrics: m.metrics, capped: m.capped }))
  const unregistered = matches
    .filter((m) => !m.registered)
    .slice(0, POLICY_LIMITS.maxUnregistered)
    .map((m) => ({ discordUserId: m.discordUserId, metrics: m.metrics }))
  const near = nearMisses(r.criteria, r.evidence, r.candidates, input.authorId, r.verdicts).map((n) => ({
    ...n,
    text: describeMatch(r.criteria, [{ condition: n.condition, count: n.count, min: n.min }]),
  }))
  return ok({
    criteria: r.criteria,
    matches,
    lines,
    unregistered,
    total: sumAmounts(lines.map((l) => l.amount)),
    nearMisses: near,
    scans: r.scans,
    problems: r.scans.some((s) => s.truncated) ? ['scan_truncated'] : [],
  })
}
