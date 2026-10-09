import { z } from 'zod'
import { MAX_LINES_PER_RUN, PROPOSAL_LIMITS } from '../../constants/limits.js'
import { DiscordIdSchema, RunIdSchema } from '../ids.js'
import type { Micros } from '../money.js'
import { type Result, err, ok } from '../result.js'
import type { Run } from '../run.js'
import { type AmountPlan, type Metric, type Metrics } from './amounts.js'
import { parseLooseAmount } from './numbers.js'
import type { RawActivity, RawAnchor, RawCriteriaProposal } from './raw.js'
import { type InstructionRefs, detokenize, own } from './sources.js'

/**
 * Criteria mode, "pay X to people who Y": the model turns Y into these conditions and code runs
 * them over the community's registered payees. Every condition must hold (AND); exclusions are
 * `lacksRole`, `exclude` and `excludeProposer`. Counting windows read channel history through
 * Discord's REST (author IDs need no Message Content intent), at most 31 days back.
 */
export const ActivityWindowSchema = z.object({
  channelIds: z.array(DiscordIdSchema).min(1).max(PROPOSAL_LIMITS.maxChannels),
  since: z.date(),
  until: z.date(),
  min: z.number().int().min(1),
})
export type ActivityWindow = z.infer<typeof ActivityWindowSchema>

export const CriteriaSchema = z.object({
  hasRole: z.array(DiscordIdSchema).max(20),
  lacksRole: z.array(DiscordIdSchema).max(20),
  joinedBefore: z.date().nullable(),
  joinedAfter: z.date().nullable(),
  messagesIn: ActivityWindowSchema.nullable(),
  activeDaysIn: ActivityWindowSchema.nullable(),
  repliesIn: ActivityWindowSchema.nullable(),
  reactedTo: z.object({ channelId: DiscordIdSchema, messageId: DiscordIdSchema, emoji: z.string().min(1).max(100).nullable() }).nullable(),
  mentionedIn: z.object({ channelId: DiscordIdSchema, messageId: DiscordIdSchema }).nullable(),
  postedIn: z.object({ threadId: DiscordIdSchema }).nullable(),
  /** `last`: the community's most recent paid run (resolved to `runId` when the proposal is made). */
  paidInRun: z.object({ last: z.boolean(), runId: RunIdSchema.nullable() }).nullable(),
  /**
   * Only people this community has never paid (`paidPayees`): "first-time", "who have never been
   * paid". False when not set, which is also what a rule stored before the filter existed reads as.
   */
  neverPaid: z.boolean().default(false),
  exclude: z.array(DiscordIdSchema).max(MAX_LINES_PER_RUN),
  excludeProposer: z.boolean(),
})
export type Criteria = z.infer<typeof CriteriaSchema>

const WINDOW_OF: Record<Metric, 'messagesIn' | 'activeDaysIn' | 'repliesIn'> = { messages: 'messagesIn', activeDays: 'activeDaysIn', replies: 'repliesIn' }
const windows = (c: Criteria) => [c.messagesIn, c.activeDaysIn, c.repliesIn].filter((w): w is ActivityWindow => w !== null)

/** The channels whose history must be read (counting windows), and the time span covering them all. */
export function scanPlan(c: Criteria): { channelIds: string[]; since: Date; until: Date } | null {
  const ws = windows(c)
  if (!ws.length) return null
  return {
    channelIds: [...new Set(ws.flatMap((w) => w.channelIds))],
    since: new Date(Math.min(...ws.map((w) => w.since.getTime()))),
    until: new Date(Math.max(...ws.map((w) => w.until.getTime()))),
  }
}

/** Whether evaluating needs each candidate's roles or join date (one member lookup each). */
export const needsMembers = (c: Criteria) => c.hasRole.length > 0 || c.lacksRole.length > 0 || c.joinedBefore !== null || c.joinedAfter !== null

// ---- from the model's answer ------------------------------------------------------------

export type ResolvedCriteria = {
  criteria: Criteria
  plan: AmountPlan
  note: string | null
  assumptions: string[]
  /** The lookback was cut to the 31-day bound. */
  lookbackClamped: boolean
  /** Every amount the model used appears in the instruction (else a person must check it). */
  amountsInInstruction: boolean
}

export type CriteriaError = { code: 'criteria_unclear'; problem: string } | { code: 'criteria_invalid'; issues: string[] }

const DAY_MS = 86_400_000
const DATE = /^(\d{4})-(\d{2})-(\d{2})/

function day(text: string): Date | null {
  const m = DATE.exec(text.trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0] ? null : d
}

/** The raw answer has no nulls (see raw.ts): an empty or blank string means "not set". */
const given = (text: string): string | null => text.trim() || null
const ANCHOR_WORDS: Record<RawAnchor['kind'], string> = { reactedTo: 'reacted to', mentionedIn: 'mentioned in', postedIn: 'posted in' }

/**
 * Checks the model's criteria and maps its tokens back to Discord IDs (and, in the words it writes
 * for people, to names: `detokenize`). Bounds are applied here, in
 * code: the lookback is cut to 31 days (and said so), windows end no later than now, at most 5
 * channels. Amounts are parsed, and each must appear in the instruction (the instruction is the
 * only text the model saw in this mode, so an amount it did not state is a model error). The raw
 * activity and anchor lists map to the domain's one window per metric and one condition per kind.
 */
export function resolveCriteria(
  raw: RawCriteriaProposal,
  ctx: { refs: InstructionRefs; now: Date; instructionAmounts: readonly Micros[] },
): Result<ResolvedCriteria, CriteriaError> {
  const { refs, now } = ctx
  // The model's words are shown to people: its tokens become names again.
  const words = (text: string) => detokenize(text.trim(), refs)
  if (!raw.understood) return err({ code: 'criteria_unclear', problem: (given(raw.problem) ? words(raw.problem) : 'The instruction could not be expressed with the filters Rolepay has.').slice(0, 300) })
  const issues: string[] = []
  const earliest = new Date(now.getTime() - PROPOSAL_LIMITS.maxLookbackDays * DAY_MS)
  let lookbackClamped = false

  // A token the request never made is "the role the AI named", never "R9"; a name it wrote instead is worth quoting.
  const named = (what: string, t: string) => (/^[@#]?[UMRC][1-9]\d*$/.test(t.trim()) ? `${what} the AI named` : `${what} "${t}"`)
  const lookup = (table: Record<string, string>, what: string) => (t: string) => {
    const id = own(table, t.trim().replace(/^[@#]/, ''))
    if (!id) issues.push(`${named(what, t)} is not one the instruction or the server names`)
    return id ?? null
  }
  const role = lookup(refs.roles, 'the role')
  const channel = lookup(refs.channels, 'the channel')
  const user = lookup(refs.users, 'the person')
  const message = (t: string) => {
    const m = own(refs.messages, t.trim())
    if (!m) issues.push(`${named('the message', t)} is not linked in the instruction (paste the message link)`)
    return m ?? null
  }

  const window = (w: RawActivity | undefined, what: string): ActivityWindow | null => {
    if (!w) return null
    const channelIds = w.channels.map(channel).filter((x): x is string => x !== null)
    if (w.channels.length === 0) issues.push(`${what}: say which channel to count in`)
    let since = day(w.since)
    if (!since) issues.push(`${what}: "${w.since}" is not a date`)
    const last = given(w.until)
    const end = last === null ? now : day(last)
    if (last !== null && !end) issues.push(`${what}: "${last}" is not a date`)
    if (!since || !end || channelIds.length !== w.channels.length || channelIds.length === 0) return null
    if (since < earliest) {
      since = earliest
      lookbackClamped = true
    }
    const until = last === null ? now : new Date(Math.min(end.getTime() + DAY_MS - 1, now.getTime()))
    if (since >= until) issues.push(`${what}: the period ends before it starts`)
    return { channelIds: [...new Set(channelIds)], since, until, min: Math.max(1, w.min) }
  }
  // The domain holds one window per metric and one condition per anchor kind: a second is refused, not guessed between.
  const only = <T, K extends string>(items: readonly T[], keyOf: (t: T) => K, words: (k: K) => string) => {
    const seen = new Map<K, T>()
    for (const item of items) {
      const key = keyOf(item)
      if (seen.has(key)) issues.push(`${words(key)}: given twice, say it once`)
      else seen.set(key, item)
    }
    return (key: K) => seen.get(key)
  }

  // A custom emoji the model saw as ":name:" maps back to Discord's form; any emoji is cut to fit.
  const emoji = (e: string) => {
    const t = given(e)
    return t ? (own(refs.emojis, t) ?? t).slice(0, 100) : null
  }
  const k = raw.conditions
  const activity = only(k.activity, (a) => a.metric, (m) => (m === 'activeDays' ? 'active days' : m))
  const anchor = only(k.anchors, (a) => a.kind, (kind) => ANCHOR_WORDS[kind])
  // The token an anchor needs (its message, or its thread); the other fields of the entry are ignored.
  const anchorToken = (kind: RawAnchor['kind'], field: 'message' | 'thread', what: string) => {
    const a = anchor(kind)
    const t = a ? given(a[field]) : null
    if (a && t === null) issues.push(`${ANCHOR_WORDS[kind]}: say which ${what}`)
    return t
  }
  const reactedToken = anchorToken('reactedTo', 'message', 'message (paste the message link)')
  const mentionedToken = anchorToken('mentionedIn', 'message', 'message (paste the message link)')
  const threadToken = anchorToken('postedIn', 'thread', 'thread')
  const reactedMessage = reactedToken === null ? null : message(reactedToken)
  const mentionedMessage = mentionedToken === null ? null : message(mentionedToken)
  const thread = threadToken === null ? null : channel(threadToken)
  const paid = given(k.paidInRun)
  if (paid !== null && paid !== 'last' && !RunIdSchema.safeParse(paid).success) issues.push(`"${paid}" is not a pay run ID`)
  if (paid !== null && k.neverPaid) issues.push('paid in a run and never paid cannot both hold: say one')
  const date = (text: string) => {
    const t = given(text)
    if (t === null) return null
    const d = day(t)
    if (!d) issues.push(`"${t}" is not a date`)
    return d
  }
  const joinedBefore = date(k.joinedBefore)
  const joinedAfter = date(k.joinedAfter)

  const criteria: Criteria = {
    hasRole: [...new Set(k.hasRole.map(role).filter((x): x is string => x !== null))],
    lacksRole: [...new Set(k.lacksRole.map(role).filter((x): x is string => x !== null))],
    joinedBefore,
    joinedAfter,
    messagesIn: window(activity('messages'), 'messages'),
    activeDaysIn: window(activity('activeDays'), 'active days'),
    repliesIn: window(activity('replies'), 'replies'),
    reactedTo: reactedMessage ? { ...reactedMessage, emoji: emoji(anchor('reactedTo')?.emoji ?? '') } : null,
    mentionedIn: mentionedMessage,
    postedIn: thread ? { threadId: thread } : null,
    paidInRun: paid === null ? null : paid === 'last' ? { last: true, runId: null } : { last: false, runId: paid },
    neverPaid: k.neverPaid,
    exclude: [...new Set(raw.exclude.map(user).filter((x): x is string => x !== null))],
    excludeProposer: raw.excludeProposer,
  }
  const scanned = new Set([...windows(criteria).flatMap((w) => w.channelIds), ...(criteria.postedIn ? [criteria.postedIn.threadId] : [])])
  if (scanned.size > PROPOSAL_LIMITS.maxChannels) issues.push(`at most ${PROPOSAL_LIMITS.maxChannels} channels per proposal`)

  // The amount plan.
  const used: Micros[] = []
  const money = (written: string, what: string, required: boolean): Micros | null => {
    const text = given(written)
    if (text === null) {
      if (required) issues.push(`the amount rule needs ${what}`)
      return null
    }
    const parsed = parseLooseAmount(text)
    if (!parsed.ok) {
      issues.push(`${what} "${text}" is not an amount`)
      return null
    }
    used.push(parsed.value)
    return parsed.value
  }
  const a = raw.amount
  let plan: AmountPlan | null = null
  if (a.kind === 'flat') {
    const amount = money(a.amount, 'an amount each', true)
    if (amount) plan = { rule: { kind: 'flat', amount }, overrides: [], perPersonCap: null }
  } else if (a.kind === 'perUnit') {
    const amount = money(a.amount, 'an amount per unit', true)
    const cap = money(a.cap, 'a cap', false)
    if (!a.per) issues.push('the amount rule needs what the amount is per (messages, active days or replies)')
    if (amount && a.per) plan = { rule: { kind: 'perUnit', amount, per: a.per, cap }, overrides: [], perPersonCap: null }
  } else {
    const total = money(a.total, 'a total', true)
    if (!a.splitBy) issues.push('the pool needs how to split it (messages, active days, replies or equally)')
    if (total && a.splitBy) plan = { rule: { kind: 'pool', total, splitBy: a.splitBy }, overrides: [], perPersonCap: null }
  }
  const metric = plan?.rule.kind === 'perUnit' ? plan.rule.per : plan?.rule.kind === 'pool' && plan.rule.splitBy !== 'equal' ? plan.rule.splitBy : null
  if (metric && !criteria[WINDOW_OF[metric]]) {
    issues.push(`the amount depends on ${metric === 'activeDays' ? 'active days' : metric}, but the instruction does not say where to count them`)
  }
  const overrides = raw.overrides.flatMap((o) => {
    const id = user(o.user)
    const amount = money(o.amount, 'an override', true)
    return id && amount ? [{ discordUserId: id, amount }] : []
  })
  const perPersonCap = money(raw.perPersonCap, 'a cap per person', false)

  if (issues.length || !plan) return err({ code: 'criteria_invalid', issues: [...new Set(issues)].slice(0, 10) })
  const stated = new Set(ctx.instructionAmounts)
  return ok({
    criteria,
    plan: { ...plan, overrides, perPersonCap },
    note: words(raw.note).slice(0, 200) || null,
    assumptions: raw.assumptions.map((s) => words(s).slice(0, 300)).filter(Boolean).slice(0, 10),
    lookbackClamped,
    amountsInInstruction: used.every((x) => stated.has(x)),
  })
}

// ---- running the criteria ---------------------------------------------------------------

/** One message as counted: its author and where and when it was sent. Bots are left out by the reader. */
export type ScannedMessage = { channelId: string; authorId: string; at: Date; replyToAuthorId: string | null }
export type MemberFacts = { roleIds: string[]; joinedAt: Date | null }

/** What code read from Discord and Rolepay's own history to run the criteria. */
export type CriteriaEvidence = {
  messages: readonly ScannedMessage[]
  reactors: readonly string[] | null
  mentioned: readonly string[] | null
  threadPosters: readonly string[] | null
  paidUserIds: readonly string[] | null
  /** Only for `neverPaid`: everyone this community has paid or is paying (`paidPayees`). null = not read, and then nobody matches. */
  paidBefore: readonly string[] | null
  /** Only for criteria with role or join-date conditions. null = not a member of the server. */
  members: Readonly<Record<string, MemberFacts | null>>
}

export const CONDITION_KEYS = [
  'excluded',
  'not_member',
  'hasRole',
  'lacksRole',
  'joinedBefore',
  'joinedAfter',
  'messagesIn',
  'activeDaysIn',
  'repliesIn',
  'reactedTo',
  'mentionedIn',
  'postedIn',
  'paidInRun',
  'neverPaid',
] as const
export type ConditionKey = (typeof CONDITION_KEYS)[number]

export type CriteriaVerdict = { userId: string; matched: boolean; metrics: Metrics; failed: ConditionKey | null }

function counter(w: ActivityWindow | null, messages: readonly ScannedMessage[], kind: Metric): Map<string, number> | null {
  if (!w) return null
  const inWindow = messages.filter((m) => w.channelIds.includes(m.channelId) && m.at >= w.since && m.at <= w.until)
  const counts = new Map<string, number>()
  if (kind === 'activeDays') {
    const days = new Map<string, Set<string>>()
    for (const m of inWindow) {
      const set = days.get(m.authorId) ?? new Set<string>()
      set.add(m.at.toISOString().slice(0, 10))
      days.set(m.authorId, set)
    }
    for (const [u, s] of days) counts.set(u, s.size)
    return counts
  }
  for (const m of inWindow) {
    if (kind === 'replies' && (m.replyToAuthorId === null || m.replyToAuthorId === m.authorId)) continue
    counts.set(m.authorId, (counts.get(m.authorId) ?? 0) + 1)
  }
  return counts
}

/** Everyone the evidence shows doing something the criteria count: candidates beyond the registered payees. */
export function seenUsers(c: Criteria, ev: CriteriaEvidence): string[] {
  const activity = new Map<string, number>()
  for (const [w, kind] of [
    [c.messagesIn, 'messages'],
    [c.activeDaysIn, 'activeDays'],
    [c.repliesIn, 'replies'],
  ] as const) {
    for (const [u, n] of counter(w, ev.messages, kind) ?? []) activity.set(u, (activity.get(u) ?? 0) + n)
  }
  for (const u of [...(ev.reactors ?? []), ...(ev.mentioned ?? []), ...(ev.threadPosters ?? []), ...(ev.paidUserIds ?? [])]) activity.set(u, (activity.get(u) ?? 0) + 1)
  return [...activity.entries()].sort((a, b) => b[1] - a[1] || (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1)).map(([u]) => u)
}

/** Runs the criteria over the candidates, in their order. Each verdict says the first condition that failed. */
export function evaluateCriteria(c: Criteria, ev: CriteriaEvidence, candidates: readonly string[], proposerId: string): CriteriaVerdict[] {
  const messages = counter(c.messagesIn, ev.messages, 'messages')
  const activeDays = counter(c.activeDaysIn, ev.messages, 'activeDays')
  const replies = counter(c.repliesIn, ev.messages, 'replies')
  const sets = {
    reactedTo: ev.reactors ? new Set(ev.reactors) : null,
    mentionedIn: ev.mentioned ? new Set(ev.mentioned) : null,
    postedIn: ev.threadPosters ? new Set(ev.threadPosters) : null,
    paidInRun: ev.paidUserIds ? new Set(ev.paidUserIds) : null,
  }
  const paidBefore = ev.paidBefore ? new Set(ev.paidBefore) : null
  const exclude = new Set(c.exclude)
  const memberChecks = needsMembers(c)

  return candidates.map((userId) => {
    const metrics: Metrics = {
      messages: messages ? (messages.get(userId) ?? 0) : null,
      activeDays: activeDays ? (activeDays.get(userId) ?? 0) : null,
      replies: replies ? (replies.get(userId) ?? 0) : null,
    }
    const fail = (failed: ConditionKey): CriteriaVerdict => ({ userId, matched: false, metrics, failed })
    if (exclude.has(userId) || (c.excludeProposer && userId === proposerId)) return fail('excluded')
    if (memberChecks) {
      const m = ev.members[userId]
      if (!m) return fail('not_member')
      if (c.hasRole.length && !c.hasRole.some((r) => m.roleIds.includes(r))) return fail('hasRole')
      if (c.lacksRole.some((r) => m.roleIds.includes(r))) return fail('lacksRole')
      if (c.joinedBefore && !(m.joinedAt && m.joinedAt < c.joinedBefore)) return fail('joinedBefore')
      if (c.joinedAfter && !(m.joinedAt && m.joinedAt.getTime() >= c.joinedAfter.getTime() + DAY_MS)) return fail('joinedAfter')
    }
    if (c.messagesIn && (metrics.messages ?? 0) < c.messagesIn.min) return fail('messagesIn')
    if (c.activeDaysIn && (metrics.activeDays ?? 0) < c.activeDaysIn.min) return fail('activeDaysIn')
    if (c.repliesIn && (metrics.replies ?? 0) < c.repliesIn.min) return fail('repliesIn')
    for (const key of ['reactedTo', 'mentionedIn', 'postedIn', 'paidInRun'] as const) {
      const set = sets[key]
      if (c[key] && !set?.has(userId)) return fail(key)
    }
    // Never paid: fails for anyone already paid, and for everyone when the history was not read.
    if (c.neverPaid && (!paidBefore || paidBefore.has(userId))) return fail('neverPaid')
    return { userId, matched: true, metrics, failed: null }
  })
}

const PAYING: ReadonlySet<Run['status']> = new Set(['paid', 'approved', 'executing'])

/**
 * Who a community has paid, for `neverPaid`: everyone with a line in one of its runs that paid, or
 * that may still pay or may have paid, so a person is never in two runs that both pay them. That is
 * a paid run, a run approved or being paid now, and a failed run whose failure is not retryable (the
 * chain showed money moving, so a person must look). Drafts, runs waiting for approval, cancelled
 * (vetoed) runs and failures that sent nothing do not count, nor does any other community's run.
 * In the order the runs come, each person once.
 */
export function paidPayees(runs: readonly Run[], communityId: string): string[] {
  const counted = runs.filter((r) => r.communityId === communityId && (PAYING.has(r.status) || (r.status === 'failed' && r.failure?.retryable === false)))
  return [...new Set(counted.flatMap((r) => r.lines.map((l) => l.payeeDiscordId)))]
}
