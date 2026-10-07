import { z } from 'zod'
import { MAX_LINES_PER_RUN, POLICY_LIMITS } from '../../constants/limits.js'
import { DiscordIdSchema, RunIdSchema } from '../ids.js'
import { MetricsSchema } from '../proposal/amounts.js'
import { type Result, err, ok } from '../result.js'
import type { Micros } from '../money.js'
import { type PolicyCaps, PolicyIdSchema, PolicyModeSchema } from './policy.js'
import { periodKey } from './schedule.js'

/**
 * One scheduled run of a policy: at most one per policy per period (the repository's unique key
 * on policy and period), whatever restarts, double ticks or second instances do. It links to the
 * pay run it made (whose ID is chosen before the run exists, so a crash between the two never
 * makes a second run) and records what code computed, the veto and the release.
 *
 *   generating --proposed--> proposed            (propose mode: the normal one-tap approval)
 *   generating --scheduled--> scheduled          (autopilot: waits for its veto window)
 *   generating --held | empty--> held | empty     (nothing to pay, or held whole and explained)
 *   scheduled --vetoed--> vetoed                 (until it is released)
 *   scheduled --lease--> releasing --released--> released   (only once the veto window has passed)
 *   scheduled | releasing --held | cancelled--> held | cancelled
 *   generating | releasing --lease--> (same)     (another instance takes over a lease that ran out)
 */
export const POLICY_RUN_STATUSES = ['generating', 'proposed', 'scheduled', 'releasing', 'released', 'vetoed', 'held', 'empty', 'cancelled'] as const
export const PolicyRunStatusSchema = z.enum(POLICY_RUN_STATUSES)
export type PolicyRunStatus = z.infer<typeof PolicyRunStatusSchema>

/** One person the run pays, as code computed it (the policy's per-person cap applied). */
export const PolicyRunLineSchema = z.object({ discordUserId: DiscordIdSchema, amount: z.bigint().positive(), metrics: MetricsSchema, capped: z.boolean() })
export type PolicyRunLine = z.infer<typeof PolicyRunLineSchema>

/** Matched, but not a registered payee: listed, never paid (they run /payee link). */
export const PolicyRunUnregisteredSchema = z.object({ discordUserId: DiscordIdSchema, metrics: MetricsSchema })

/**
 * Why Rolepay stopped instead of paying, with the numbers when there are some (`total` against
 * `limit`). Codes: over_budget, no_active_key, over_policy_cap, too_many_lines, the key checks
 * (key_revoked, insufficient_limit, ...), over_policy_budget and policy_key_inactive (a policy
 * with its own key: that key's budget, or that key cannot pay), swaps_over_budget and
 * swaps_over_policy_budget (within the budget, but not once swaps into preferred stablecoins count
 * at their maximum input; `total` is then that most), policy_not_active, autopilot_off,
 * approver_changed, and any refusal from approving the run (creator_cannot_approve, ...).
 */
export const HoldSchema = z.object({ code: z.string().regex(/^[a-z_]{1,40}$/), total: z.bigint().nonnegative().nullable(), limit: z.bigint().nonnegative().nullable() })
export type Hold = z.infer<typeof HoldSchema>

export const PolicyRunIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/)

export const PolicyRunSchema = z.object({
  id: PolicyRunIdSchema,
  policyId: PolicyIdSchema,
  policyVersion: z.number().int().min(1),
  communityId: DiscordIdSchema,
  /** The period's end as an ISO instant: unique per policy. */
  periodKey: z.string().min(1),
  periodStart: z.date(),
  periodEnd: z.date(),
  mode: PolicyModeSchema,
  status: PolicyRunStatusSchema,
  /** Chosen when the period is claimed; the pay run carries it once created. */
  runId: RunIdSchema.nullable(),
  /** Autopilot: the end of the veto window. */
  executeAfter: z.date().nullable(),
  /** Up to 1000, so a run with too many people (more than one run can hold) is still explained. */
  lines: z.array(PolicyRunLineSchema).max(1000),
  unregistered: z.array(PolicyRunUnregisteredSchema).max(POLICY_LIMITS.maxUnregistered),
  total: z.bigint().nonnegative(),
  /** What the key that pays this policy (its own, or the bot key) had left when the run was made; null = that key cannot pay. */
  remaining: z.bigint().nonnegative().nullable(),
  /** About the counts: scan_truncated (the 10,000-message bound), lookback_clamped. */
  problems: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(10),
  hold: HoldSchema.nullable(),
  vetoedBy: DiscordIdSchema.nullable(),
  vetoedAt: z.date().nullable(),
  /** Autopilot: the treasurer in whose name the run was approved, and when. */
  releasedBy: DiscordIdSchema.nullable(),
  releasedAt: z.date().nullable(),
  /** The scheduler instance working on it holds it until then (generating, releasing). */
  leaseUntil: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  rev: z.number().int().min(0),
})
export type PolicyRun = z.infer<typeof PolicyRunSchema>

/**
 * Why a run cannot be paid as computed, in the order they are checked: more people than one run
 * holds, over the policy's cap per run, no active key, over what the key has left. The
 * scheduler holds a run on the first (whole, never in part); a preview lists them all.
 * `key`: whose budget `remaining` is. A policy with its own key (`policy`) is held against that
 * key alone, as `policy_key_inactive` or `over_policy_budget`; the bot key's codes are unchanged.
 * `spend`: the most the run can take from that key's limit (`payoutSpendCap`: a line paid in a
 * preferred stablecoin at its maximum swap input), the total by default. The key's budget is held
 * against it, so a run the pre-flight would refuse is held when it is made; when only the swaps push
 * it over, the code says so (`swaps_over_budget`, `swaps_over_policy_budget`). The policy's cap per
 * run is about what people receive, so it stays on the total.
 */
export function runGuards(input: { lines: number; total: Micros; spend?: Micros; caps: PolicyCaps; remaining: Micros | null; key?: 'bot' | 'policy' }): Hold[] {
  const { total } = input
  const spend = input.spend ?? total
  const own = input.key === 'policy'
  const out: Hold[] = []
  if (input.lines > MAX_LINES_PER_RUN) out.push({ code: 'too_many_lines', total, limit: null })
  if (input.caps.perRun !== null && total > input.caps.perRun) out.push({ code: 'over_policy_cap', total, limit: input.caps.perRun })
  if (input.remaining === null) out.push({ code: own ? 'policy_key_inactive' : 'no_active_key', total, limit: null })
  else if (total > input.remaining) out.push({ code: own ? 'over_policy_budget' : 'over_budget', total, limit: input.remaining })
  else if (spend > input.remaining) out.push({ code: own ? 'swaps_over_policy_budget' : 'swaps_over_budget', total: spend, limit: input.remaining })
  return out
}

/**
 * The hold an execute refusal becomes when autopilot releases a run. A refusal of the policy's
 * own key gets the same codes as at generation (`over_policy_budget`, `policy_key_inactive`); the
 * bot key's keep their codes, with what the key had left as the limit when it says.
 */
export function policyKeyHold(e: { code: string; remaining?: Micros; key?: 'policy'; [detail: string]: unknown }, total: Micros): Hold {
  const limit = e.code === 'insufficient_limit' && e.remaining !== undefined ? e.remaining : null
  if (e.key === 'policy') {
    if (e.code === 'insufficient_limit') return { code: 'over_policy_budget', total, limit }
    if (['key_revoked', 'key_not_authorized', 'key_expired', 'key_expires_too_soon'].includes(e.code)) return { code: 'policy_key_inactive', total, limit: null }
  }
  return { code: e.code, total, limit }
}

export function newPolicyRun(input: {
  id: string
  policyId: string
  policyVersion: number
  communityId: string
  mode: PolicyRun['mode']
  window: { start: Date; end: Date }
  runId: string
  now: Date
  leaseUntil: Date
}): PolicyRun {
  return {
    id: input.id,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    communityId: input.communityId,
    periodKey: periodKey(input.window.end),
    periodStart: input.window.start,
    periodEnd: input.window.end,
    mode: input.mode,
    status: 'generating',
    runId: input.runId,
    executeAfter: null,
    lines: [],
    unregistered: [],
    total: 0n,
    remaining: null,
    problems: [],
    hold: null,
    vetoedBy: null,
    vetoedAt: null,
    releasedBy: null,
    releasedAt: null,
    leaseUntil: input.leaseUntil,
    createdAt: input.now,
    updatedAt: input.now,
    rev: 0,
  }
}

/** What code computed for the period (kept with the run, for the dashboard and the audit). */
export type Snapshot = Pick<PolicyRun, 'lines' | 'unregistered' | 'total' | 'remaining' | 'problems'>

export type PolicyRunEvent =
  | ({ type: 'proposed'; runId: string } & Snapshot)
  | ({ type: 'scheduled'; runId: string; executeAfter: Date } & Snapshot)
  /** `runId: null` when no pay run was made after all (held or empty at generation). */
  | ({ type: 'held'; hold: Hold; runId?: string | null } & Partial<Snapshot>)
  | ({ type: 'empty'; runId?: string | null } & Snapshot)
  | { type: 'lease'; until: Date }
  | { type: 'released'; by: string }
  | { type: 'vetoed'; by: string }
  | { type: 'cancelled' }

export type PolicyRunTransitionError =
  | { code: 'illegal_transition'; from: PolicyRunStatus; event: PolicyRunEvent['type'] }
  | { code: 'veto_window_open'; executeAfter: Date }
  | { code: 'leased'; leaseUntil: Date }

const FINAL: ReadonlySet<PolicyRunStatus> = new Set(['proposed', 'released', 'vetoed', 'held', 'empty', 'cancelled'])
export const isFinal = (s: PolicyRunStatus) => FINAL.has(s)

/** The PolicyRun state machine. Pure: a new record (rev + 1) or why not. */
export function movePolicyRun(pr: PolicyRun, event: PolicyRunEvent, now: Date): Result<PolicyRun, PolicyRunTransitionError> {
  const illegal = () => err({ code: 'illegal_transition' as const, from: pr.status, event: event.type })
  const next = (changes: Partial<PolicyRun>) => ok({ ...pr, ...changes, updatedAt: now, rev: pr.rev + 1 })
  const s = pr.status
  switch (event.type) {
    case 'proposed':
    case 'empty': {
      if (s !== 'generating') return illegal()
      const { type, ...rest } = event
      return next({ ...rest, status: type, leaseUntil: null })
    }
    case 'scheduled': {
      if (s !== 'generating') return illegal()
      const { type: _t, ...rest } = event
      return next({ ...rest, status: 'scheduled', leaseUntil: null })
    }
    case 'held': {
      if (s !== 'generating' && s !== 'scheduled' && s !== 'releasing') return illegal()
      const { type: _t, ...rest } = event
      return next({ ...rest, status: 'held', leaseUntil: null })
    }
    case 'lease': {
      if (s === 'scheduled') {
        if (pr.executeAfter === null || now < pr.executeAfter) return err({ code: 'veto_window_open', executeAfter: pr.executeAfter ?? now })
        return next({ status: 'releasing', leaseUntil: event.until })
      }
      if (s !== 'generating' && s !== 'releasing') return illegal()
      if (pr.leaseUntil && now < pr.leaseUntil) return err({ code: 'leased', leaseUntil: pr.leaseUntil })
      return next({ leaseUntil: event.until })
    }
    case 'released':
      return s === 'releasing' ? next({ status: 'released', releasedBy: event.by, releasedAt: now, leaseUntil: null }) : illegal()
    case 'vetoed':
      return s === 'scheduled' ? next({ status: 'vetoed', vetoedBy: event.by, vetoedAt: now }) : illegal()
    case 'cancelled':
      return s === 'scheduled' || s === 'releasing' ? next({ status: 'cancelled', leaseUntil: null }) : illegal()
  }
}
