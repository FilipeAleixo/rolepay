import { z } from 'zod'
import { MAX_LINES_PER_RUN, PROPOSAL_LIMITS } from '../constants/limits.js'
import { TOKEN_SYMBOLS } from '../constants/tempo.js'
import { type Community, canPropose } from '../domain/community.js'
import { DiscordIdSchema } from '../domain/ids.js'
import { type Micros, formatAmount } from '../domain/money.js'
import { type CriteriaError, resolveCriteria } from '../domain/proposal/criteria.js'
import { amountsIn } from '../domain/proposal/numbers.js'
import {
  type EditError,
  type Problem,
  type Proposal,
  type ProposalLine,
  type UnregisteredLine,
  assembleProposal,
  blockingProblems,
  editProposal,
  resolveMessageProposal,
} from '../domain/proposal/proposal.js'
import { type SourceMessage, SourceMessageSchema, pseudonymizeMessages, tokenizeInstruction } from '../domain/proposal/sources.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Run } from '../domain/run.js'
import type { ActivityReader, ReadError } from '../ports/activityReader.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { ProposalLog, ProposalLogEntry } from '../ports/proposalLog.js'
import type { CommunityRepository, PayeeRepository, ProposalRepository, RunRepository } from '../ports/repositories.js'
import type { ProposerFailure, ProposerUsage, RunProposer } from '../ports/runProposer.js'
import { type InvalidInput, invalidInput } from './common.js'
import type { CommunityService } from './communityService.js'
import { runCriteria } from './criteriaRunner.js'
import type { PayRunService } from './payRunService.js'
import { type Stopwatch, stopwatch, timedActivity } from './proposalTimings.js'

export type ProposalServiceDeps = {
  communities: CommunityRepository
  payees: PayeeRepository
  runs: RunRepository
  proposals: ProposalRepository
  ids: IdGenerator
  clock: Clock
  /** null when no model is configured (no ANTHROPIC_API_KEY): every proposal answers `ai_not_configured`. */
  proposer: RunProposer | null
  /** Discord history, members and reactions. Needed for criteria mode and for reading a channel. */
  activity: ActivityReader | null
  communityService: CommunityService
  payRuns: PayRunService
  log?: ProposalLog
}

/** Who is asking, as Discord signed it into the interaction. Checked on every request. */
type Actor = { guildId: string; actor: string; actorRoleIds: readonly string[] }

export type MessageSource =
  /** The message a context-menu command targets (it arrives in the interaction). */
  | { kind: 'messages'; channelId: string; messages: SourceMessage[] }
  /** The newest messages of a channel or thread since `since` (at most 31 days back). */
  | { kind: 'history'; channelId: string; since: Date }

type Gate = { code: 'ai_not_configured' } | { code: 'community_not_found' } | { code: 'ai_disabled' } | { code: 'not_permitted' }
export type CouldNotPropose = { code: 'could_not_propose'; reason: ProposerFailure['reason'] }
export type ProposeError =
  | InvalidInput
  | Gate
  | ReadError
  | CouldNotPropose
  | CriteriaError
  | { code: 'source_empty' }
  | { code: 'no_message_content' }
type Found = { code: 'proposal_not_found' }
type ErrorOf<F extends (...args: never[]) => Promise<Result<unknown, { code: string }>>> = Extract<Awaited<ReturnType<F>>, { ok: false }>['error']
type Closed = { code: 'proposal_closed'; status: Proposal['status']; runId: string | null }

export type CreateRunError =
  | Found
  | Closed
  | Gate
  | { code: 'proposal_blocked'; problems: Problem[] }
  | ErrorOf<PayRunService['create']>
  | ErrorOf<PayRunService['submit']>

const InstructionSchema = z.string().trim().min(1, 'say what to pay').max(PROPOSAL_LIMITS.maxInstructionLength)
const EditLinesSchema = z.array(z.object({ discordUserId: DiscordIdSchema, amount: z.bigint().positive() })).max(MAX_LINES_PER_RUN)
const DAY_MS = 86_400_000

/**
 * AI-proposed pay runs: AI proposes, the protocol limits, a human approves. A proposal is a draft;
 * `createRun` turns it into a normal run through `PayRunService.create` and `submit`, so approval,
 * the never-pay-twice machinery and the bot key's on-chain limit are untouched. Only the approver
 * role, or the community's optional proposer role, may propose, edit, discard or create, checked
 * from the roles the caller passes on every request. The model sees tokens, never Discord IDs; in
 * criteria mode it never sees members at all, only the instruction and role and channel names.
 */
export class ProposalService {
  constructor(private readonly deps: ProposalServiceDeps) {}

  /** Whether this server has a model configured (an Anthropic API key). */
  isConfigured(): boolean {
    return this.deps.proposer !== null
  }

  /** Message mode: one message (the context-menu target) or a channel's recent history. */
  async proposeFromMessages(input: Actor & { instruction: string; source: MessageSource }): Promise<Result<Proposal, ProposeError>> {
    const instruction = InstructionSchema.safeParse(input.instruction)
    if (!instruction.success) return invalidInput(instruction.error)
    const gate = await this.gate(input)
    if (!gate.ok) return gate
    const { community, proposer } = gate.value
    const now = this.deps.clock.now()
    const timer = stopwatch(this.deps.clock)

    let messages: SourceMessage[]
    let truncated = false
    let remaining: Micros | null
    if (input.source.kind === 'messages') {
      const parsed = z.array(SourceMessageSchema).max(PROPOSAL_LIMITS.maxSourceMessages).safeParse(input.source.messages)
      if (!parsed.success) return invalidInput(parsed.error)
      messages = parsed.data
      remaining = await this.remaining(community.id, timer)
    } else {
      if (!this.deps.activity) return err({ code: 'ai_not_configured' })
      const earliest = new Date(now.getTime() - PROPOSAL_LIMITS.maxLookbackDays * DAY_MS)
      // The channel (Discord) and the remaining budget (the chain) are independent: read them at the same time.
      const [read, left] = await Promise.all([
        timedActivity(this.deps.activity, timer).history({
          channelId: input.source.channelId,
          since: input.source.since < earliest ? earliest : input.source.since,
          until: now,
          limit: PROPOSAL_LIMITS.maxSourceMessages,
        }),
        this.remaining(community.id, timer),
      ])
      if (!read.ok) return this.fail('messages', read.error, { sourceMessages: 0, timer })
      messages = read.value.messages
      truncated = read.value.truncated
      remaining = left
    }
    if (messages.length === 0) return err({ code: 'source_empty' })
    if (messages.every((m) => m.content.trim() === '')) return err({ code: 'no_message_content' })

    const pseudo = pseudonymizeMessages({ instruction: instruction.data, messages })
    const answer = await timer.time('modelMs', () =>
      proposer.fromMessages({
        instruction: pseudo.instruction,
        messages: pseudo.messages,
        token: symbol(community),
        remaining: remaining === null ? null : formatAmount(remaining),
        maxLines: MAX_LINES_PER_RUN,
      }),
    )
    if (!answer.ok) return this.fail('messages', { code: 'could_not_propose', reason: answer.error.reason }, { sourceMessages: messages.length, usage: answer.error.usage, timer })

    const registered = await this.registered(community.id)
    const resolved = resolveMessageProposal(answer.value.raw, { map: pseudo.map, instruction: instruction.data, isRegistered: (id) => registered.has(id) })
    const assembled = assembleProposal({
      candidates: resolved.candidates,
      held: resolved.held,
      unregistered: resolved.unregistered,
      isRegistered: (id) => registered.has(id),
      remaining,
      holdOverRemaining: true,
      problems: truncated ? ['source_truncated'] : [],
    })
    const proposal = this.draft(input, community, now, {
      mode: 'messages',
      instruction: instruction.data,
      note: resolved.note,
      source: { channelId: input.source.channelId, messageIds: pseudo.messages.map((m) => pseudo.map.messages[m.ref]?.messageId as string), truncated },
      criteria: null,
      amountPlan: null,
      scans: [],
      unresolved: resolved.unresolved,
      assumptions: resolved.assumptions,
      suspicious: resolved.suspicious,
      remaining,
      ...assembled,
    })
    await this.deps.proposals.save(proposal)
    this.record(proposal, { sourceMessages: messages.length, scannedMessages: 0, usage: answer.value.usage, timer })
    return ok(proposal)
  }

  /**
   * Criteria mode, "pay X to people who Y": the model turns the instruction into a filter and an
   * amount rule; code reads what the filter needs (within 31 days, 10,000 messages, 5 channels)
   * and runs it over the registered payees. People who match but are not registered are listed.
   */
  async proposeFromCriteria(input: Actor & { instruction: string }): Promise<Result<Proposal, ProposeError>> {
    const instruction = InstructionSchema.safeParse(input.instruction)
    if (!instruction.success) return invalidInput(instruction.error)
    const gate = await this.gate(input)
    if (!gate.ok) return gate
    const { community, proposer } = gate.value
    const timer = stopwatch(this.deps.clock)
    const activity = this.deps.activity && timedActivity(this.deps.activity, timer)
    if (!activity) return err({ code: 'ai_not_configured' })
    const now = this.deps.clock.now()

    // The names (Discord) and the remaining budget (the chain) are independent: read them at the same time.
    const [names, remaining] = await Promise.all([activity.guildNames(community.id), this.remaining(community.id, timer)])
    const tokens = tokenizeInstruction(instruction.data, { guildId: community.id, roles: names.roles, channels: names.channels })
    const answer = await timer.time('modelMs', () =>
      proposer.fromCriteria({
        instruction: tokens.text,
        today: now.toISOString().slice(0, 10),
        maxLookbackDays: PROPOSAL_LIMITS.maxLookbackDays,
        roles: tokens.roles,
        channels: tokens.channels,
        token: symbol(community),
        remaining: remaining === null ? null : formatAmount(remaining),
      }),
    )
    if (!answer.ok) return this.fail('criteria', { code: 'could_not_propose', reason: answer.error.reason }, { usage: answer.error.usage, timer })
    const usage = answer.value.usage

    const resolved = resolveCriteria(answer.value.raw, { refs: tokens.refs, now, instructionAmounts: amountsIn(instruction.data) })
    if (!resolved.ok) return this.fail('criteria', resolved.error, { usage, timer })
    const { criteria, plan } = resolved.value

    // Read what the criteria need (within the bounds) and run them over the payees: code only.
    const ran = await runCriteria({ activity, payees: this.deps.payees, runs: this.deps.runs }, { communityId: community.id, criteria, plan, authorId: input.actor, now })
    if (!ran.ok) return this.fail('criteria', ran.error, { usage, scannedMessages: ran.scannedMessages, timer })
    const { matched, registered, scans } = ran.value
    const amountOf = new Map(ran.value.amounts.map((a) => [a.userId, a]))
    const sources = [criteria.reactedTo, criteria.mentionedIn].filter((s) => s !== null).map(({ channelId, messageId }) => ({ channelId, messageId }))
    const lines: ProposalLine[] = []
    const unregistered: UnregisteredLine[] = []
    for (const v of matched) {
      const base = { discordUserId: v.userId, reason: null, metrics: v.metrics, sources, flags: [] }
      const a = amountOf.get(v.userId)
      if (a && a.amount > 0n) lines.push({ ...base, amount: a.amount, flags: a.capped ? ['capped'] : [] })
      else if (!registered.has(v.userId)) unregistered.push({ ...base, amount: unregisteredAmount(plan.rule, v.metrics, plan.perPersonCap) })
    }
    lines.sort((a, b) => (a.amount === b.amount ? byId(a.discordUserId, b.discordUserId) : a.amount > b.amount ? -1 : 1))
    const ignoredOverrides = plan.overrides.filter((o) => !matched.some((v) => v.userId === o.discordUserId)).length

    const problems: Problem[] = []
    if (scans.some((s) => s.truncated)) problems.push('scan_truncated')
    if (resolved.value.lookbackClamped) problems.push('lookback_clamped')
    if (!resolved.value.amountsInInstruction) problems.push('amount_not_in_instruction')
    const assembled = assembleProposal({ candidates: lines, held: [], unregistered, isRegistered: (id) => registered.has(id), remaining, holdOverRemaining: true, problems })
    const proposal = this.draft(input, community, now, {
      mode: 'criteria',
      instruction: instruction.data,
      note: resolved.value.note,
      source: null,
      criteria: ran.value.criteria,
      amountPlan: plan,
      scans,
      unresolved: [],
      assumptions: [
        ...resolved.value.assumptions,
        ...(ignoredOverrides ? [`${ignoredOverrides === 1 ? 'An amount was' : `${ignoredOverrides} amounts were`} given for someone who does not match, so nobody is paid for it.`] : []),
      ].slice(0, 10),
      suspicious: [],
      remaining,
      ...assembled,
    })
    await this.deps.proposals.save(proposal)
    this.record(proposal, { sourceMessages: 0, scannedMessages: ran.value.scannedMessages, usage, timer })
    return ok(proposal)
  }

  async get(input: { guildId: string; proposalId: string }): Promise<Result<Proposal, Found>> {
    const p = await this.deps.proposals.get(input.proposalId)
    if (!p || p.communityId !== input.guildId || p.expiresAt <= this.deps.clock.now()) return err({ code: 'proposal_not_found' })
    return ok(p)
  }

  /** The treasurer's Edit: the lines become exactly what they typed. */
  async edit(
    input: Actor & { proposalId: string; lines: readonly { discordUserId: string; amount: Micros }[] },
  ): Promise<Result<Proposal, Found | Closed | InvalidInput | Gate | EditError>> {
    const loaded = await this.openForActor(input)
    if (!loaded.ok) return loaded
    const lines = EditLinesSchema.safeParse(input.lines)
    if (!lines.success) return invalidInput(lines.error)
    const registered = await this.registered(input.guildId)
    const edited = editProposal(loaded.value, lines.data, {
      actor: input.actor,
      isRegistered: (id) => registered.has(id),
      remaining: await this.remaining(input.guildId),
      now: this.deps.clock.now(),
    })
    if (!edited.ok) return edited
    await this.deps.proposals.save(edited.value)
    return edited
  }

  async discard(input: Actor & { proposalId: string }): Promise<Result<Proposal, Found | Closed | Gate>> {
    const loaded = await this.openForActor(input)
    if (!loaded.ok) return loaded
    const discarded: Proposal = { ...loaded.value, status: 'discarded', closedBy: input.actor, updatedAt: this.deps.clock.now() }
    await this.deps.proposals.save(discarded)
    return ok(discarded)
  }

  /**
   * "Create pay run": the existing create and submit, so the run waits for the treasurer's
   * approval exactly like one from /rolepay new. A claim makes it once per proposal, however many
   * clicks arrive.
   */
  async createRun(
    input: Actor & { proposalId: string },
  ): Promise<Result<{ proposal: Proposal; run: Run }, CreateRunError>> {
    const loaded = await this.openForActor(input)
    if (!loaded.ok) return loaded
    const p = loaded.value
    const blocking = blockingProblems(p)
    if (blocking.length) return err({ code: 'proposal_blocked', problems: blocking })
    if (!(await this.deps.proposals.claim(p.id))) return err({ code: 'proposal_closed', status: 'run_created', runId: null })
    // The claim is given back only while no run exists: after `create` succeeds, nothing that fails
    // later (a write, the submit) may let a second click create a second run.
    let created: Run | null = null
    try {
      const made = await this.deps.payRuns.create({
        guildId: p.communityId,
        createdBy: input.actor,
        note: p.note,
        lines: p.lines.map((l) => ({ discordUserId: l.discordUserId, amount: l.amount })),
      })
      if (!made.ok) {
        await this.deps.proposals.release(p.id)
        return made
      }
      created = made.value
      const proposal: Proposal = { ...p, status: 'run_created', runId: created.id, closedBy: input.actor, updatedAt: this.deps.clock.now() }
      await this.deps.proposals.save(proposal)
      // If the submit fails the run stays a draft (it shows in /rolepay status and can be cancelled), never a second run.
      const submitted = await this.deps.payRuns.submit({ guildId: p.communityId, runId: created.id, actor: input.actor })
      if (!submitted.ok) return submitted
      return ok({ proposal, run: submitted.value })
    } catch (e) {
      if (!created) await this.deps.proposals.release(p.id)
      throw e
    }
  }

  // ---- internals -------------------------------------------------------------------------

  /** Configured, registered, permitted, switched on: in that order, on every request. */
  private async gate(input: Actor): Promise<Result<{ community: Community; proposer: RunProposer }, Gate>> {
    const proposer = this.deps.proposer
    if (!proposer) return err({ code: 'ai_not_configured' })
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canPropose(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    if (!community.aiProposals) return err({ code: 'ai_disabled' })
    return ok({ community, proposer })
  }

  /** An open proposal of this server, for a caller allowed to propose. Edits work with AI off too (no model call). */
  private async openForActor(input: Actor & { proposalId: string }): Promise<Result<Proposal, Found | Closed | Gate>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canPropose(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const p = await this.get(input)
    if (!p.ok) return p
    if (p.value.status !== 'open') return err({ code: 'proposal_closed', status: p.value.status, runId: p.value.runId })
    return p
  }

  private async registered(guildId: string): Promise<Set<string>> {
    return new Set((await this.deps.payees.list(guildId)).map((p) => p.discordUserId))
  }

  /** What the active bot key has left, read from the chain; null without an active key. */
  private async remaining(guildId: string, timer?: Stopwatch): Promise<Micros | null> {
    const read = () => this.deps.communityService.keyStatus({ guildId })
    const status = await (timer ? timer.time('chainMs', read) : read())
    return status.ok && status.value.key.status === 'active' && status.value.state.status === 'active' ? status.value.state.remaining : null
  }

  private draft(
    who: Actor,
    community: Community,
    now: Date,
    body: Omit<Proposal, 'id' | 'communityId' | 'proposedBy' | 'token' | 'status' | 'runId' | 'editedBy' | 'closedBy' | 'createdAt' | 'updatedAt' | 'expiresAt'>,
  ): Proposal {
    return {
      id: this.deps.ids.proposalId(),
      communityId: community.id,
      proposedBy: who.actor,
      token: community.payoutToken,
      status: 'open',
      runId: null,
      editedBy: null,
      closedBy: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PROPOSAL_LIMITS.ttlSeconds * 1000),
      ...body,
    }
  }

  private fail<E extends { code: string }>(
    mode: Proposal['mode'],
    error: E,
    counts: { sourceMessages?: number; scannedMessages?: number; usage?: ProposerUsage | null; timer?: Stopwatch },
  ): { ok: false; error: E } {
    this.log({ proposalId: null, mode, outcome: error.code, lines: 0, held: 0, unregistered: 0, ...counts })
    return err(error)
  }

  private record(p: Proposal, counts: { sourceMessages: number; scannedMessages: number; usage: ProposerUsage; timer: Stopwatch }) {
    this.log({ proposalId: p.id, mode: p.mode, outcome: 'proposed', lines: p.lines.length, held: p.held.length, unregistered: p.unregistered.length, ...counts })
  }

  private log(e: Omit<ProposalLogEntry, 'model' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'latencyMs' | 'sourceMessages' | 'scannedMessages' | 'timings'> & {
    sourceMessages?: number
    scannedMessages?: number
    usage?: ProposerUsage | null
    timer?: Stopwatch
  }) {
    const { usage, timer, ...rest } = e
    this.deps.log?.({
      sourceMessages: 0,
      scannedMessages: 0,
      ...rest,
      model: usage?.model ?? this.deps.proposer?.model ?? null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: usage?.costMicroUsd == null ? null : formatAmount(BigInt(usage.costMicroUsd)),
      latencyMs: usage?.latencyMs ?? null,
      timings: timer?.done() ?? null,
    })
  }
}

const symbol = (c: Community) => TOKEN_SYMBOLS[c.payoutToken] ?? 'tokens'
const byId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)

/** For a person who matched but is not registered: what the rule would give them (a pool share is not defined). */
function unregisteredAmount(rule: NonNullable<Proposal['amountPlan']>['rule'], metrics: ProposalLine['metrics'], cap: Micros | null): Micros | null {
  if (rule.kind === 'pool') return null
  const raw = rule.kind === 'flat' ? rule.amount : rule.amount * BigInt(metrics?.[rule.per] ?? 0)
  const capped = rule.kind === 'perUnit' && rule.cap !== null && raw > rule.cap ? rule.cap : raw
  return cap !== null && capped > cap ? cap : capped
}

