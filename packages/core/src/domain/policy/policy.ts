import { z } from 'zod'
import { MAX_NOTE_LENGTH, POLICY_LIMITS, PROPOSAL_LIMITS } from '../../constants/limits.js'
import type { Community } from '../community.js'
import { DiscordIdSchema } from '../ids.js'
import { type Micros, formatAmount } from '../money.js'
import { type Amounted, AmountPlanSchema, type Metric } from '../proposal/amounts.js'
import { type ConditionKey, type Criteria, type CriteriaEvidence, CriteriaSchema, type CriteriaVerdict, evaluateCriteria } from '../proposal/criteria.js'
import { type Schedule, ScheduleSchema, describeSchedule, nextOccurrence, occurrenceAtOrBefore, periodEnding } from './schedule.js'

/**
 * A standing policy: a rule the AI compiled ONCE from the treasurer's instruction (criteria
 * mode's filter and amount plan), approved by the approver role, then run by code on a schedule
 * with no AI at runtime. Each run goes through the normal pay run machinery and the bot key's
 * on-chain limit. Any edit makes a new version: an approver's edit of an approved policy is in
 * force at once (unless the community requires a separate approver), any other waits for an approval.
 */
export const PolicyIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/)

export const POLICY_STATUSES = ['draft', 'active', 'paused', 'archived'] as const
export const PolicyStatusSchema = z.enum(POLICY_STATUSES)
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>

/** `propose`: each run waits for the normal one-tap approval. `autopilot`: it pays after a veto window unless vetoed. */
export const POLICY_MODES = ['propose', 'autopilot'] as const
export const PolicyModeSchema = z.enum(POLICY_MODES)
export type PolicyMode = z.infer<typeof PolicyModeSchema>

/** Guardrails a treasurer sets on top of the rule: a run over `perRun` is held whole; each line is cut to `perPerson`. */
export const PolicyCapsSchema = z.object({ perRun: z.bigint().positive().nullable(), perPerson: z.bigint().positive().nullable() })
export type PolicyCaps = z.infer<typeof PolicyCapsSchema>
export const NO_CAPS: PolicyCaps = { perRun: null, perPerson: null }

/** What the AI compiled, after code checked it (`resolveCriteria`). Counting windows are moved onto each run's period. */
export const CompiledRuleSchema = z.object({
  criteria: CriteriaSchema,
  plan: AmountPlanSchema,
  note: z.string().max(MAX_NOTE_LENGTH).nullable(),
  assumptions: z.array(z.string().max(300)).max(10),
  /** Every amount the rule uses is stated in the instruction. If not, the policy cannot be approved: rewrite the instruction. */
  amountsInInstruction: z.boolean(),
})
export type CompiledRule = z.infer<typeof CompiledRuleSchema>

/** Everything that decides who is paid and how much: a change to any of it is a new version. */
export const PolicyDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(POLICY_LIMITS.maxNameLength),
  /** What the author typed (trusted: only the approver or proposer role can write policies). Kept next to the compiled rule. */
  instruction: z.string().max(PROPOSAL_LIMITS.maxInstructionLength),
  compiled: CompiledRuleSchema,
  schedule: ScheduleSchema,
  caps: PolicyCapsSchema,
})
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>

export const AutopilotSchema = z.object({
  /** The treasurer who switched autopilot on. Each run is approved in their name, while they hold the approver role. */
  enabledBy: DiscordIdSchema,
  enabledAt: z.date(),
  /** The approver role at that moment. If the community's approver role changes, autopilot stops. */
  approverRoleId: DiscordIdSchema,
})
export type Autopilot = z.infer<typeof AutopilotSchema>

export const PolicySchema = PolicyDefinitionSchema.extend({
  id: PolicyIdSchema,
  communityId: DiscordIdSchema,
  /** Where runs are posted in Discord. null: nowhere (the dashboard still shows them). */
  channelId: DiscordIdSchema.nullable(),
  status: PolicyStatusSchema,
  /** The version the definition fields above belong to. */
  version: z.number().int().min(1),
  mode: PolicyModeSchema,
  vetoWindowMinutes: z.number().int().min(1).max(POLICY_LIMITS.maxVetoMinutes),
  autopilot: AutopilotSchema.nullable(),
  createdBy: DiscordIdSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  /** The approval of the current version; null while it waits for one. */
  approvedBy: DiscordIdSchema.nullable(),
  approvedAt: z.date().nullable(),
  /** When the current version became active. Occurrences before it never run (no backfill). */
  activeSince: z.date().nullable(),
  /** Compare-and-set: incremented on every write. */
  rev: z.number().int().min(0),
})
export type Policy = z.infer<typeof PolicySchema>

/** One version of a policy's definition, kept for good: who wrote it, who approved or discarded it. */
export const PolicyVersionSchema = PolicyDefinitionSchema.extend({
  policyId: PolicyIdSchema,
  communityId: DiscordIdSchema,
  version: z.number().int().min(1),
  authoredBy: DiscordIdSchema,
  authoredAt: z.date(),
  approvedBy: DiscordIdSchema.nullable(),
  approvedAt: z.date().nullable(),
  discardedBy: DiscordIdSchema.nullable(),
  discardedAt: z.date().nullable(),
})
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>

/**
 * Who may approve, pause, resume, switch modes, set veto windows, archive and veto: a member
 * holding the community's CURRENT approver role, from the roles Discord signed into the request
 * (or the dashboard re-read). Manage Server alone never can, and with no approver role nobody can.
 */
export const canApprovePolicies = (community: Pick<Community, 'approverRoleId'>, actorRoleIds: readonly string[]) =>
  community.approverRoleId !== null && actorRoleIds.includes(community.approverRoleId)

// ---- periods -----------------------------------------------------------------------------

const DAY_MS = 86_400_000
const MAX_LOOKBACK_MS = PROPOSAL_LIMITS.maxLookbackDays * DAY_MS
const clampStart = (start: Date, end: Date) => (end.getTime() - start.getTime() > MAX_LOOKBACK_MS ? new Date(end.getTime() - MAX_LOOKBACK_MS) : start)

/** What the run at `occurrence` counts: since the previous occurrence, at most 31 days back. */
export function runWindow(schedule: Schedule, occurrence: Date): { start: Date; end: Date } {
  const p = periodEnding(schedule, occurrence)
  return { start: clampStart(p.start, p.end), end: p.end }
}

/** "Who it applies to right now": the period in progress, from the last occurrence up to now. */
export function previewWindow(schedule: Schedule, now: Date): { start: Date; end: Date; nextRunAt: Date } {
  const last = occurrenceAtOrBefore(schedule, now)
  return { start: clampStart(last, now), end: now, nextRunAt: nextOccurrence(schedule, now) }
}

/** The compiled criteria with every counting window moved onto `period` (channels and minimums unchanged). */
export function windowedCriteria(c: Criteria, period: { start: Date; end: Date }): Criteria {
  const move = (w: Criteria['messagesIn']) => (w ? { ...w, since: period.start, until: period.end } : null)
  return { ...c, messagesIn: move(c.messagesIn), activeDaysIn: move(c.activeDaysIn), repliesIn: move(c.repliesIn) }
}

/** The policy's cap per person, applied after the rule: overrides are cut too (the cap is the treasurer's, not the AI's). */
export function capLines(lines: readonly Amounted[], perPerson: Micros | null): Amounted[] {
  if (perPerson === null) return [...lines]
  return lines.map((l) => (l.amount > perPerson ? { ...l, amount: perPerson, capped: true } : l))
}

// ---- plain words -------------------------------------------------------------------------

export type Names = {
  money?: (micros: Micros) => string
  role?: (id: string) => string
  channel?: (id: string) => string
  user?: (id: string) => string
  /** For message links; without it a message is "a message in #channel". */
  guildId?: string
}

function namer(n: Names) {
  const role = n.role ?? ((id: string) => `<@&${id}>`)
  const channel = n.channel ?? ((id: string) => `<#${id}>`)
  return {
    money: n.money ?? ((m: Micros) => formatAmount(m)),
    roles: (ids: readonly string[]) => ids.map(role).join(' or '),
    channels: (ids: readonly string[]) => ids.map(channel).join(', '),
    channel,
    users: (ids: readonly string[]) => ids.map(n.user ?? ((id: string) => `<@${id}>`)).join(', '),
    message: (channelId: string, messageId: string) => (n.guildId ? `https://discord.com/channels/${n.guildId}/${channelId}/${messageId}` : `a message in ${channel(channelId)}`),
  }
}

const PER: Record<Metric, string> = { messages: 'message', activeDays: 'active day', replies: 'reply to other people' }
const BY: Record<Metric, string> = { messages: 'messages sent', activeDays: 'active days', replies: 'replies to other people' }
const day = (d: Date) => d.toISOString().slice(0, 10)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

function amountWords(plan: CompiledRule['plan'], w: ReturnType<typeof namer>): string {
  const r = plan.rule
  const base =
    r.kind === 'flat'
      ? `${w.money(r.amount)} each`
      : r.kind === 'perUnit'
        ? `${w.money(r.amount)} per ${PER[r.per]}`
        : `${w.money(r.total)} split ${r.splitBy === 'equal' ? 'equally' : `by ${BY[r.splitBy]}`}`
  const caps = [r.kind === 'perUnit' ? r.cap : null, plan.perPersonCap].filter((c): c is Micros => c !== null)
  const cap = caps.length ? `, at most ${w.money(caps.reduce((a, b) => (a < b ? a : b)))} each` : ''
  const overrides = plan.overrides.map((o) => `; ${w.users([o.discordUserId])} gets ${w.money(o.amount)}`).join('')
  return `${base}${cap}${overrides}.`
}

function conditionWords(c: Criteria, w: ReturnType<typeof namer>): string[] {
  const out: string[] = []
  if (c.hasRole.length) out.push(`has ${w.roles(c.hasRole)}`)
  if (c.lacksRole.length) out.push(`does not have ${w.roles(c.lacksRole)}`)
  if (c.joinedBefore) out.push(`joined before ${day(c.joinedBefore)}`)
  if (c.joinedAfter) out.push(`joined after ${day(c.joinedAfter)}`)
  if (c.messagesIn) out.push(`sent at least ${plural(c.messagesIn.min, 'message', 'messages')} in ${w.channels(c.messagesIn.channelIds)} during the period`)
  if (c.activeDaysIn) out.push(`was active on at least ${plural(c.activeDaysIn.min, 'day', 'days')} in ${w.channels(c.activeDaysIn.channelIds)} during the period`)
  if (c.repliesIn) out.push(`replied to other people at least ${times(c.repliesIn.min)} in ${w.channels(c.repliesIn.channelIds)} during the period`)
  if (c.reactedTo) out.push(`reacted ${c.reactedTo.emoji ? `${c.reactedTo.emoji} ` : ''}to ${w.message(c.reactedTo.channelId, c.reactedTo.messageId)}`)
  if (c.mentionedIn) out.push(`is mentioned in ${w.message(c.mentionedIn.channelId, c.mentionedIn.messageId)}`)
  if (c.postedIn) out.push(`posted in ${w.channel(c.postedIn.threadId)}`)
  if (c.paidInRun) out.push(c.paidInRun.last ? 'was paid in the last paid run' : `was paid in run ${c.paidInRun.runId}`)
  if (c.neverPaid) out.push('has never been paid by this community')
  if (c.exclude.length) out.push(`never ${w.users(c.exclude)}`)
  if (c.excludeProposer) out.push("never the policy's author")
  return out
}

/** The compiled rule in plain words: how much, who, when, and the caps. Mentions render in Discord; the dashboard passes its own names. */
export function describeRule(rule: CompiledRule, ctx: { schedule: Schedule; caps: PolicyCaps } & Names): string[] {
  const w = namer(ctx)
  const who = conditionWords(rule.criteria, w)
  const caps = [ctx.caps.perRun === null ? null : `${w.money(ctx.caps.perRun)} per run`, ctx.caps.perPerson === null ? null : `${w.money(ctx.caps.perPerson)} per person`].filter(Boolean)
  return [
    amountWords(rule.plan, w),
    `Who: ${who.length ? who.join('; ') : 'every registered payee'}.`,
    `When: ${describeSchedule(ctx.schedule)}, counting activity since the previous run.`,
    ...(caps.length ? [`Caps: at most ${caps.join(' and ')}; a run over a cap or over the bot key budget is held whole, never paid in part.`] : []),
  ]
}

// ---- who matches, why, and who is just below the line ------------------------------------

export type MatchReason = { condition: ConditionKey; count: number | null; min: number | null }
const COUNTS = { messagesIn: 'messages', activeDaysIn: 'activeDays', repliesIn: 'replies' } as const
type CountKey = keyof typeof COUNTS
const isCount = (k: ConditionKey | null): k is CountKey => k !== null && k in COUNTS

/** For a person who matched: each condition the rule has, with their count where it counts something. */
export function matchReasons(c: Criteria, verdict: CriteriaVerdict): MatchReason[] {
  const out: MatchReason[] = []
  const plain = (condition: ConditionKey) => out.push({ condition, count: null, min: null })
  if (c.hasRole.length) plain('hasRole')
  if (c.lacksRole.length) plain('lacksRole')
  if (c.joinedBefore) plain('joinedBefore')
  if (c.joinedAfter) plain('joinedAfter')
  for (const key of ['messagesIn', 'activeDaysIn', 'repliesIn'] as const) {
    const w = c[key]
    if (w) out.push({ condition: key, count: verdict.metrics[COUNTS[key]] ?? 0, min: w.min })
  }
  for (const key of ['reactedTo', 'mentionedIn', 'postedIn', 'paidInRun', 'neverPaid'] as const) if (c[key]) plain(key)
  return out
}

/** A match's reasons in plain words, for example "has @Mods; 12 replies to other people in #help (at least 1)". */
export function describeMatch(c: Criteria, reasons: readonly MatchReason[], names: Names = {}): string {
  const w = namer(names)
  return reasons
    .map((r) => {
      switch (r.condition) {
        case 'hasRole':
          return `has ${w.roles(c.hasRole)}`
        case 'lacksRole':
          return `does not have ${w.roles(c.lacksRole)}`
        case 'joinedBefore':
          return c.joinedBefore ? `joined before ${day(c.joinedBefore)}` : 'joined before the date'
        case 'joinedAfter':
          return c.joinedAfter ? `joined after ${day(c.joinedAfter)}` : 'joined after the date'
        case 'messagesIn':
          return `${plural(r.count ?? 0, 'message', 'messages')} in ${w.channels(c.messagesIn?.channelIds ?? [])} (at least ${r.min})`
        case 'activeDaysIn':
          return `active on ${plural(r.count ?? 0, 'day', 'days')} in ${w.channels(c.activeDaysIn?.channelIds ?? [])} (at least ${r.min})`
        case 'repliesIn':
          return `${plural(r.count ?? 0, 'reply', 'replies')} to other people in ${w.channels(c.repliesIn?.channelIds ?? [])} (at least ${r.min})`
        case 'reactedTo':
          return 'reacted to the message'
        case 'mentionedIn':
          return 'is mentioned in the message'
        case 'postedIn':
          return c.postedIn ? `posted in ${w.channel(c.postedIn.threadId)}` : 'posted in the thread'
        case 'paidInRun':
          return 'was paid in that run'
        case 'neverPaid':
          return 'never paid by this community'
        default:
          return r.condition
      }
    })
    .join('; ')
}

export type NearMiss = { userId: string; condition: CountKey; count: number; min: number }

/**
 * People just below the line: they failed only a count (fewer messages, active days or replies
 * than the minimum) and had at least one. Checked by lowering that one minimum to their count and
 * running the criteria again, so someone who also fails another condition is not listed.
 * Closest first.
 */
export function nearMisses(
  c: Criteria,
  ev: CriteriaEvidence,
  candidates: readonly string[],
  authorId: string,
  verdicts: readonly CriteriaVerdict[],
  limit: number = POLICY_LIMITS.maxNearMisses,
): NearMiss[] {
  const known = new Set(candidates)
  const out: NearMiss[] = []
  for (const v of verdicts) {
    if (v.matched || !known.has(v.userId) || !isCount(v.failed)) continue
    const window = c[v.failed]
    const count = v.metrics[COUNTS[v.failed]] ?? 0
    if (!window || count < 1) continue
    const relaxed = { ...c, [v.failed]: { ...window, min: count } }
    if (evaluateCriteria(relaxed, ev, [v.userId], authorId)[0]?.matched) out.push({ userId: v.userId, condition: v.failed, count, min: window.min })
  }
  return out.sort((a, b) => a.min - a.count - (b.min - b.count) || (BigInt(a.userId) < BigInt(b.userId) ? -1 : 1)).slice(0, limit)
}
