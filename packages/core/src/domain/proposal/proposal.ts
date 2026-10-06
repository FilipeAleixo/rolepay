import { z } from 'zod'
import { MAX_LINES_PER_RUN, MAX_NOTE_LENGTH, PROPOSAL_LIMITS } from '../../constants/limits.js'
import { AddressSchema, DiscordIdSchema, RunIdSchema } from '../ids.js'
import { type Micros, sumAmounts } from '../money.js'
import { type Result, err, ok } from '../result.js'
import { AmountPlanSchema, MetricsSchema, splitPool } from './amounts.js'
import { CriteriaSchema } from './criteria.js'
import { amountsIn, parseLooseAmount } from './numbers.js'
import type { RawMessageProposal } from './raw.js'
import type { MessageTokenMap } from './sources.js'

/**
 * A pay run proposal: a draft the AI helped write, never a run. Code decides every line from the
 * model's answer with checks that do not depend on the model behaving: who a line pays, that its
 * amount is stated in the instruction (or in a message the instruction points at), that its
 * source is not the recipient's own message, registration, duplicates and the bot key's budget.
 * A line that fails a check is held (shown, left out of the run); the treasurer can type it back
 * in with Edit. A proposal becomes money only through `PayRunService.create`, the treasurer's
 * approval and the bot key's on-chain limit, all unchanged.
 */

/** Why a line is left out of the run. */
export const HOLD_REASONS = [
  /** Every message backing it was written by the person it pays ("pay me"). */
  'self_sourced',
  /** A message backing it tried to instruct the AI. */
  'suspicious_source',
  /** No message backs it. */
  'no_source',
  'amount_unreadable',
  /** The amount is not one the instruction states. */
  'amount_not_in_instruction',
  /** The amount was said to come from a message, and no backing message by someone else states it. */
  'amount_not_in_source',
  'duplicate',
  /** This line alone is more than the bot key has left. */
  'over_remaining_budget',
] as const
export const HoldReasonSchema = z.enum(HOLD_REASONS)
export type HoldReason = z.infer<typeof HoldReasonSchema>

/** Worth a look, but the line stays in. */
export const LINE_FLAGS = ['amount_from_message', 'capped'] as const
export const LineFlagSchema = z.enum(LINE_FLAGS)
export type LineFlag = z.infer<typeof LineFlagSchema>

/** About the whole proposal. The blocking ones stop "Create pay run" until an edit fixes them. */
export const PROBLEMS = ['no_lines', 'too_many_lines', 'amount_not_in_instruction', 'over_budget', 'no_active_key', 'scan_truncated', 'source_truncated', 'lookback_clamped'] as const
export const ProblemSchema = z.enum(PROBLEMS)
export type Problem = z.infer<typeof ProblemSchema>
export const BLOCKING_PROBLEMS: ReadonlySet<Problem> = new Set(['no_lines', 'too_many_lines', 'amount_not_in_instruction'])
export const blockingProblems = (p: { problems: readonly Problem[] }) => p.problems.filter((x) => BLOCKING_PROBLEMS.has(x))

export const SourceRefSchema = z.object({ channelId: DiscordIdSchema, messageId: DiscordIdSchema })
export type SourceRef = z.infer<typeof SourceRefSchema>

const ReasonSchema = z.string().max(200).nullable()

export const ProposalLineSchema = z.object({
  discordUserId: DiscordIdSchema,
  amount: z.bigint().positive(),
  /** Message mode: the model's words. Criteria mode: null (the view says it from `metrics`). */
  reason: ReasonSchema,
  metrics: MetricsSchema.nullable(),
  sources: z.array(SourceRefSchema).max(5),
  flags: z.array(LineFlagSchema),
})
export type ProposalLine = z.infer<typeof ProposalLineSchema>

export const HeldLineSchema = ProposalLineSchema.extend({ amount: z.bigint().nonnegative().nullable(), holds: z.array(HoldReasonSchema).min(1) })
export type HeldLine = z.infer<typeof HeldLineSchema>

/** Would be paid, but is not a registered payee (they run /payee link, then propose again). */
export const UnregisteredLineSchema = ProposalLineSchema.extend({ amount: z.bigint().nonnegative().nullable() })
export type UnregisteredLine = z.infer<typeof UnregisteredLineSchema>

export const UnresolvedSchema = z.object({ text: z.string().max(200), why: z.string().max(300) })
export type Unresolved = z.infer<typeof UnresolvedSchema>

/** A message that tried to instruct the AI. Its author is kept, never its text. */
export const SuspiciousSchema = SourceRefSchema.extend({ authorId: DiscordIdSchema, summary: z.string().max(300) })
export type Suspicious = z.infer<typeof SuspiciousSchema>

export const ChannelScanSchema = z.object({
  channelId: DiscordIdSchema,
  since: z.date(),
  until: z.date(),
  messages: z.number().int().nonnegative(),
  /** The 10,000-message bound stopped the scan before `since`: counts may be low. */
  truncated: z.boolean(),
})
export type ChannelScan = z.infer<typeof ChannelScanSchema>

export const PROPOSAL_MODES = ['messages', 'criteria'] as const
export const PROPOSAL_STATUSES = ['open', 'run_created', 'discarded'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const ProposalIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/)

export const ProposalSchema = z.object({
  id: ProposalIdSchema,
  communityId: DiscordIdSchema,
  proposedBy: DiscordIdSchema,
  mode: z.enum(PROPOSAL_MODES),
  token: AddressSchema,
  /** What the proposer typed (trusted: only the approver or proposer role can propose). */
  instruction: z.string().max(PROPOSAL_LIMITS.maxInstructionLength),
  note: z.string().max(MAX_NOTE_LENGTH).nullable(),
  /** Message mode: the messages read. */
  source: z.object({ channelId: DiscordIdSchema, messageIds: z.array(DiscordIdSchema).max(PROPOSAL_LIMITS.maxSourceMessages), truncated: z.boolean() }).nullable(),
  /** Criteria mode: the filter code ran, the amount rule, and what was scanned. */
  criteria: CriteriaSchema.nullable(),
  amountPlan: AmountPlanSchema.nullable(),
  scans: z.array(ChannelScanSchema).max(PROPOSAL_LIMITS.maxChannels),
  /** More than 50 is possible in criteria mode; such a proposal cannot be created until it is edited down. */
  lines: z.array(ProposalLineSchema).max(1000),
  held: z.array(HeldLineSchema).max(200),
  unregistered: z.array(UnregisteredLineSchema).max(PROPOSAL_LIMITS.maxUnregisteredCandidates),
  unresolved: z.array(UnresolvedSchema).max(20),
  assumptions: z.array(z.string().max(300)).max(10),
  suspicious: z.array(SuspiciousSchema).max(20),
  total: z.bigint().nonnegative(),
  /** What the bot key had left when the proposal was made. null = no active key. */
  remaining: z.bigint().nonnegative().nullable(),
  problems: z.array(ProblemSchema),
  status: z.enum(PROPOSAL_STATUSES),
  runId: RunIdSchema.nullable(),
  editedBy: DiscordIdSchema.nullable(),
  closedBy: DiscordIdSchema.nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  expiresAt: z.date(),
})
export type Proposal = z.infer<typeof ProposalSchema>

// ---- message mode: from the model's answer to checked lines ------------------------------

const clean = (text: string, max: number) => {
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export type ResolvedMessageProposal = {
  candidates: ProposalLine[]
  held: HeldLine[]
  unresolved: Unresolved[]
  assumptions: string[]
  suspicious: Suspicious[]
  note: string | null
}

/**
 * Message mode: maps the model's tokens back to Discord and checks every line in code. A line is
 * held when its only source is the recipient's own message, when a source tried to instruct the
 * AI, when no message backs it, when its amount is not stated where the model says it is, or when
 * the person is listed twice. A "split" total must be in the instruction, and code computes the
 * equal split itself (the pool rounding rule). The model's words are cut and stripped of control
 * characters; the view escapes them.
 */
export function resolveMessageProposal(raw: RawMessageProposal, ctx: { map: MessageTokenMap; instruction: string }): ResolvedMessageProposal {
  const stated = new Set(amountsIn(ctx.instruction))
  const messageOf = (ref: string) => ctx.map.messages[ref.trim()]
  const suspicious: Suspicious[] = []
  const suspiciousRefs = new Set<string>()
  for (const s of raw.ignoredInstructions) {
    const m = messageOf(s.message)
    if (!m || suspiciousRefs.has(m.messageId)) continue
    suspiciousRefs.add(m.messageId)
    suspicious.push({ channelId: m.channelId, messageId: m.messageId, authorId: m.authorId, summary: clean(s.summary, 300) })
  }

  const unresolved: Unresolved[] = raw.unresolved.map((u) => ({ text: clean(u.text, 200), why: clean(u.why, 300) }))
  const candidates: (ProposalLine & { holds: HoldReason[]; split: boolean; rawAmount: Micros | null })[] = []
  const seen = new Set<string>()
  for (const line of raw.lines) {
    const userId = ctx.map.users[line.user.trim().replace(/^@/, '')]
    if (!userId) {
      unresolved.push({ text: clean(line.reason || line.user, 200), why: 'The AI named someone who is not in the messages.' })
      continue
    }
    const sources = [...new Map(line.sources.map(messageOf).filter((m) => m !== undefined).map((m) => [m.messageId, m])).values()].slice(0, 5)
    const holds: HoldReason[] = []
    const flags: LineFlag[] = []
    if (sources.length === 0) holds.push('no_source')
    else if (sources.every((s) => s.authorId === userId)) holds.push('self_sourced')
    if (sources.some((s) => suspiciousRefs.has(s.messageId))) holds.push('suspicious_source')

    const parsed = parseLooseAmount(line.amount)
    const amount = parsed.ok ? parsed.value : null
    if (amount === null) holds.push('amount_unreadable')
    else if (line.amountFrom === 'instruction' && !stated.has(amount)) holds.push('amount_not_in_instruction')
    else if (line.amountFrom === 'message') {
      const backed = sources.some((s) => s.authorId !== userId && amountsIn(s.text).includes(amount))
      if (backed) flags.push('amount_from_message')
      else holds.push('amount_not_in_source')
    }
    if (seen.has(userId)) holds.push('duplicate')
    seen.add(userId)
    candidates.push({
      discordUserId: userId,
      amount: amount ?? 0n,
      rawAmount: amount,
      reason: clean(line.reason, 200) || null,
      metrics: null,
      sources: sources.map(({ channelId, messageId }) => ({ channelId, messageId })),
      flags,
      holds,
      split: line.amountFrom === 'split',
    })
  }

  // "Split 300 between the winners": code computes the shares, from a total the instruction states.
  const split = candidates.filter((c) => c.split && c.holds.length === 0)
  const total = raw.splitTotal === null ? null : parseLooseAmount(raw.splitTotal)
  if (split.length) {
    if (!total?.ok || !stated.has(total.value)) for (const c of split) c.holds.push('amount_not_in_instruction')
    else for (const share of splitPool(total.value, split.map((c) => ({ userId: c.discordUserId, weight: 1n })))) {
      const c = split.find((x) => x.discordUserId === share.userId)
      if (c) c.amount = share.amount
    }
  }

  const out: ResolvedMessageProposal = {
    candidates: [],
    held: [],
    unresolved: unresolved.slice(0, 20),
    assumptions: raw.assumptions.map((a) => clean(a, 300)).filter(Boolean).slice(0, 10),
    suspicious: suspicious.slice(0, 20),
    note: raw.note ? clean(raw.note, MAX_NOTE_LENGTH) || null : null,
  }
  for (const { holds, split: _s, rawAmount, ...line } of candidates) {
    if (holds.length || line.amount <= 0n) out.held.push({ ...line, amount: holds.length ? rawAmount : line.amount, holds: holds.length ? holds : ['amount_unreadable'] })
    else out.candidates.push(line)
  }
  return out
}

// ---- both modes: registration, budget, the run limit -------------------------------------

export type Assembled = Pick<Proposal, 'lines' | 'held' | 'unregistered' | 'total' | 'problems'>

/**
 * The last checks, the same in both modes and after an edit: people who are not registered payees
 * are listed apart; a line larger than everything the bot key has left is held (AI lines only: an
 * amount the treasurer typed stays, with the over-budget warning); the total is compared with the
 * key's remaining budget; at most 50 lines (one run).
 */
export function assembleProposal(input: {
  candidates: readonly ProposalLine[]
  held: readonly HeldLine[]
  unregistered?: readonly UnregisteredLine[]
  isRegistered: (discordUserId: string) => boolean
  remaining: Micros | null
  holdOverRemaining: boolean
  problems: readonly Problem[]
}): Assembled {
  const lines: ProposalLine[] = []
  const held: HeldLine[] = [...input.held]
  const unregistered: UnregisteredLine[] = [...(input.unregistered ?? [])]
  for (const c of input.candidates) {
    if (!input.isRegistered(c.discordUserId)) unregistered.push(c)
    else if (input.holdOverRemaining && input.remaining !== null && c.amount > input.remaining) held.push({ ...c, holds: ['over_remaining_budget'] })
    else lines.push(c)
  }
  const total = sumAmounts(lines.map((l) => l.amount))
  const problems = new Set<Problem>(input.problems.filter((p) => !['no_lines', 'too_many_lines', 'over_budget', 'no_active_key'].includes(p)))
  if (lines.length === 0) problems.add('no_lines')
  if (lines.length > MAX_LINES_PER_RUN) problems.add('too_many_lines')
  if (input.remaining === null) problems.add('no_active_key')
  else if (total > input.remaining) problems.add('over_budget')
  return { lines, held, unregistered, total, problems: PROBLEMS.filter((p) => problems.has(p)) }
}

export type EditError = { code: 'duplicate_payee'; payeeDiscordId: string } | { code: 'too_many_lines' }

/**
 * The treasurer's Edit: the lines become exactly what they typed (person and amount). Reasons and
 * sources carry over for people already in the proposal; held lines that were typed back in are
 * no longer held; an amount the treasurer typed is explicit, so "not in the instruction" no
 * longer applies. Registration and the budget are checked again.
 */
export function editProposal(
  p: Proposal,
  edits: readonly { discordUserId: string; amount: Micros }[],
  ctx: { actor: string; isRegistered: (discordUserId: string) => boolean; remaining: Micros | null; now: Date },
): Result<Proposal, EditError> {
  if (edits.length > MAX_LINES_PER_RUN) return err({ code: 'too_many_lines' })
  const seen = new Set<string>()
  for (const e of edits) {
    if (seen.has(e.discordUserId)) return err({ code: 'duplicate_payee', payeeDiscordId: e.discordUserId })
    seen.add(e.discordUserId)
  }
  const known = new Map<string, Pick<ProposalLine, 'reason' | 'metrics' | 'sources'>>()
  for (const l of [...p.unregistered, ...p.held, ...p.lines]) known.set(l.discordUserId, { reason: l.reason, metrics: l.metrics, sources: l.sources })
  const candidates = edits.map((e) => ({ reason: null, metrics: null, sources: [], ...known.get(e.discordUserId), discordUserId: e.discordUserId, amount: e.amount, flags: [] }))
  const assembled = assembleProposal({
    candidates,
    held: p.held.filter((h) => !seen.has(h.discordUserId)),
    unregistered: p.unregistered.filter((u) => !seen.has(u.discordUserId)),
    isRegistered: ctx.isRegistered,
    remaining: ctx.remaining,
    holdOverRemaining: false,
    problems: p.problems.filter((x) => x !== 'amount_not_in_instruction'),
  })
  return ok({ ...p, ...assembled, editedBy: ctx.actor, updatedAt: ctx.now })
}
