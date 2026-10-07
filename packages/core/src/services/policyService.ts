import { z } from 'zod'
import { POLICY_LIMITS, PROPOSAL_LIMITS } from '../constants/limits.js'
import { TOKEN_SYMBOLS } from '../constants/tempo.js'
import { type Community, canPropose } from '../domain/community.js'
import { DiscordIdSchema } from '../domain/ids.js'
import { type Micros, formatAmount } from '../domain/money.js'
import {
  type CompiledRule,
  type Policy,
  type PolicyMode,
  PolicyModeSchema,
  PolicySchema,
  type PolicyVersion,
  canApprovePolicies,
  describeRule,
  previewWindow,
} from '../domain/policy/policy.js'
import { type PolicyRun, type PolicyRunStatus, movePolicyRun, runGuards } from '../domain/policy/policyRun.js'
import { type Schedule, ScheduleSchema, nextOccurrence, scheduleAllowed } from '../domain/policy/schedule.js'
import { type CriteriaError, resolveCriteria } from '../domain/proposal/criteria.js'
import { amountsIn } from '../domain/proposal/numbers.js'
import type { ChannelScan } from '../domain/proposal/proposal.js'
import { tokenizeInstruction } from '../domain/proposal/sources.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Run } from '../domain/run.js'
import type { ActivityReader, ReadError } from '../ports/activityReader.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { ProposalLog } from '../ports/proposalLog.js'
import type { AiUsageRepository, CommunityRepository, PayeeRepository, PolicyRepository, PolicyRunRepository, RunRepository } from '../ports/repositories.js'
import type { RunProposer } from '../ports/runProposer.js'
import type { AuditTrail } from './auditTrail.js'
import { type InvalidInput, invalidInput } from './common.js'
import type { CommunityService } from './communityService.js'
import type { PayRunService } from './payRunService.js'
import { type PolicyMatch, evaluatePolicy } from './policyEvaluation.js'
import type { CouldNotPropose } from './proposalService.js'
import { stopwatch } from './proposalTimings.js'

export type PolicyServiceDeps = {
  communities: CommunityRepository
  payees: PayeeRepository
  runs: RunRepository
  policies: PolicyRepository
  policyRuns: PolicyRunRepository
  ids: IdGenerator
  clock: Clock
  /** The model, used once per create or edit of the instruction. Never at runtime. */
  proposer: RunProposer | null
  activity: ActivityReader | null
  communityService: CommunityService
  payRuns: PayRunService
  audit: AuditTrail
  /** One content-free row per model call (the AI spend): each compile. */
  aiUsage: AiUsageRepository
  log?: ProposalLog
  /** The shortest veto window allowed, in minutes. 60 by default; the testnet demo controls lower it to 1. */
  minVetoMinutes?: number
  /** The testnet demo controls (Moderato only, `createRolepay` checks): daily schedules are allowed. */
  demoControls?: boolean
}

/** Who is asking, as Discord signed it into the interaction (or the dashboard re-read it). Checked on every request. */
export type PolicyActor = { guildId: string; actor: string; actorRoleIds: readonly string[] }
type Ref = { guildId: string; policyId: string }

type NotFound = { code: 'community_not_found' } | { code: 'policy_not_found' }
type NotPermitted = { code: 'not_permitted' }
type AiGate = { code: 'ai_not_configured' } | { code: 'ai_disabled' }
type Conflict = { code: 'concurrent_update' }
/** A daily schedule on a server without the testnet demo controls. */
export type ScheduleNotAllowed = { code: 'schedule_not_allowed'; kind: Schedule['kind'] }
export type CompileError = CouldNotPropose | CriteriaError
export type PolicyStateError =
  | { code: 'policy_archived' }
  | { code: 'policy_not_draft'; status: Policy['status'] }
  | { code: 'policy_not_active'; status: Policy['status'] }
  | { code: 'policy_not_paused'; status: Policy['status'] }
  | { code: 'policy_not_approved' }
  | { code: 'version_mismatch'; version: number }
  | { code: 'policy_blocked'; problems: string[] }
  | { code: 'creator_cannot_approve' }
  | { code: 'invalid_veto_window'; min: number; max: number }
  | ScheduleNotAllowed

export type PolicySummary = { policy: Policy; nextRunAt: Date | null; lastRun: PolicyRun | null }
export type PolicyDetail = PolicySummary & { versions: PolicyVersion[]; runs: PolicyRun[]; rule: string[] }

/** "Who it applies to right now", the next run's total against the budget, and the rule in plain words. */
export type PolicyPreview = {
  policyId: string
  version: number
  /** The period in progress: from the last occurrence up to now. */
  window: { start: Date; end: Date }
  nextRunAt: Date
  matches: PolicyMatch[]
  nearMisses: { userId: string; condition: string; count: number; min: number; text: string }[]
  total: Micros
  /** What the bot key has left now; null = no active key. */
  remaining: Micros | null
  /** amount_not_in_instruction, scan_truncated, too_many_lines, over_policy_cap, no_active_key, over_budget. */
  problems: string[]
  rule: string[]
  scans: ChannelScan[]
}

const InstructionSchema = z.string().trim().min(1, 'say what to pay').max(PROPOSAL_LIMITS.maxInstructionLength)
const NameSchema = z.string().trim().min(1).max(POLICY_LIMITS.maxNameLength)
const CapsInputSchema = z.object({ perRun: z.bigint().positive().nullable().default(null), perPerson: z.bigint().positive().nullable().default(null) })
const ActorSchema = z.object({ guildId: DiscordIdSchema, actor: DiscordIdSchema, actorRoleIds: z.array(DiscordIdSchema).max(250) })

const CreateInputSchema = ActorSchema.extend({
  name: NameSchema.optional(),
  instruction: InstructionSchema,
  schedule: ScheduleSchema,
  caps: CapsInputSchema.default({ perRun: null, perPerson: null }),
  /** Where its runs are posted in Discord (the channel the command ran in). */
  channelId: DiscordIdSchema.nullable().default(null),
})
export type CreatePolicyInput = z.input<typeof CreateInputSchema>

const EditInputSchema = ActorSchema.extend({
  policyId: z.string().min(1).max(40),
  name: NameSchema.optional(),
  instruction: InstructionSchema.optional(),
  schedule: ScheduleSchema.optional(),
  caps: CapsInputSchema.optional(),
})
export type EditPolicyInput = z.input<typeof EditInputSchema>

const symbol = (c: Community) => TOKEN_SYMBOLS[c.payoutToken] ?? 'tokens'
const defaultName = (rule: CompiledRule, instruction: string) => (rule.note ?? instruction).replace(/\s+/g, ' ').trim().slice(0, POLICY_LIMITS.maxNameLength)

/**
 * Standing policies: the AI writes the rule once (criteria mode, at create or when the instruction
 * is edited), the approver role approves it, the scheduler runs it with code. Only the CURRENT
 * approver role approves, pauses, resumes, switches modes, sets veto windows, archives and vetoes,
 * checked from the roles the caller passes on every request; the approver or proposer role may
 * write and edit (an edit is a new version that needs a new approval and switches autopilot off).
 * Every action goes to the audit stream.
 */
export class PolicyService {
  constructor(private readonly deps: PolicyServiceDeps) {}

  private get minVeto() {
    return this.deps.minVetoMinutes ?? POLICY_LIMITS.minVetoMinutes
  }

  /** Whether policies here may run daily: only with the testnet demo controls on (never off Moderato). */
  get dailySchedules(): boolean {
    return this.deps.demoControls === true
  }

  private refused(s: Schedule): ScheduleNotAllowed | null {
    return scheduleAllowed(s, { demoControls: this.dailySchedules }) ? null : { code: 'schedule_not_allowed', kind: s.kind }
  }

  private nextRunAt(p: Policy, now: Date): Date | null {
    return p.status === 'active' && !this.refused(p.schedule) ? nextOccurrence(p.schedule, now) : null
  }

  // ---- writing ---------------------------------------------------------------------------

  /** Compiles the instruction ONCE into a filter and an amount plan and stores the policy as a draft (version 1). */
  async create(input: CreatePolicyInput): Promise<Result<Policy, InvalidInput | ScheduleNotAllowed | NotFound | NotPermitted | AiGate | CompileError | ReadError>> {
    const parsed = CreateInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const i = parsed.data
    // Before anything else, and so before the model: a daily schedule is the testnet demo's only.
    const schedule = this.refused(i.schedule)
    if (schedule) return err(schedule)
    const gate = await this.writerGate(i, { ai: true })
    if (!gate.ok) return gate
    const community = gate.value
    const now = this.deps.clock.now()
    const id = this.deps.ids.policyId()
    const compiled = await this.compile(community, i.instruction, { actor: i.actor, policyId: id, version: 1 })
    if (!compiled.ok) return compiled
    const policy = PolicySchema.parse({
      id,
      communityId: community.id,
      name: i.name ?? defaultName(compiled.value, i.instruction),
      instruction: i.instruction,
      compiled: compiled.value,
      schedule: i.schedule,
      caps: i.caps,
      channelId: i.channelId,
      status: 'draft',
      version: 1,
      mode: 'propose',
      vetoWindowMinutes: POLICY_LIMITS.defaultVetoMinutes,
      autopilot: null,
      createdBy: i.actor,
      createdAt: now,
      updatedAt: now,
      approvedBy: null,
      approvedAt: null,
      activeSince: null,
      rev: 0,
    } satisfies Policy)
    await this.deps.policies.insert(policy, versionOf(policy, i.actor, now))
    await this.event(policy, 'policy.created', i.actor, { schedule: policy.schedule.kind, mode: policy.mode })
    await this.compiledEvent(policy, i.actor)
    return ok(policy)
  }

  /**
   * A new version: any of name, instruction (recompiled by the AI), schedule and caps. The policy
   * stops (draft) until an approver approves the new version, and autopilot is switched off.
   */
  async edit(
    input: EditPolicyInput,
  ): Promise<Result<Policy, InvalidInput | ScheduleNotAllowed | NotFound | NotPermitted | AiGate | CompileError | ReadError | Conflict | { code: 'policy_archived' }>> {
    const parsed = EditInputSchema.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const i = parsed.data
    const recompile = i.instruction !== undefined
    const gate = await this.writerGate(i, { ai: recompile })
    if (!gate.ok) return gate
    const policy = await this.find(i)
    if (!policy.ok) return policy
    const p = policy.value
    if (p.status === 'archived') return err({ code: 'policy_archived' })
    // The version this edit makes keeps the current schedule unless it names one: either way, no daily without the demo controls.
    const schedule = this.refused(i.schedule ?? p.schedule)
    if (schedule) return err(schedule)
    const latest = Math.max(...(await this.deps.policies.listVersions(p.id)).map((v) => v.version), p.version)
    let compiled = p.compiled
    if (recompile) {
      const c = await this.compile(gate.value, i.instruction as string, { actor: i.actor, policyId: p.id, version: latest + 1 })
      if (!c.ok) return c
      compiled = c.value
    }
    const now = this.deps.clock.now()
    const next: Policy = {
      ...p,
      name: i.name ?? p.name,
      instruction: i.instruction ?? p.instruction,
      compiled,
      schedule: i.schedule ?? p.schedule,
      caps: i.caps ?? p.caps,
      version: latest + 1,
      status: 'draft',
      mode: 'propose',
      autopilot: null,
      approvedBy: null,
      approvedAt: null,
      activeSince: null,
      updatedAt: now,
      rev: p.rev + 1,
    }
    const saved = await this.save(next, versionOf(next, i.actor, now))
    if (!saved.ok) return saved
    await this.event(next, 'policy.edited', i.actor, { recompiled: recompile, autopilotOff: p.mode === 'autopilot', previous: p.version })
    if (recompile) await this.compiledEvent(next, i.actor)
    return ok(next)
  }

  /**
   * Activates the version the approver saw (`version` must be the current one). The approval is
   * recorded with who and when, on the policy and its version. Blocked while the rule uses an
   * amount the instruction does not state; with four eyes on, the author cannot approve.
   */
  async approve(input: PolicyActor & { policyId: string; version: number }): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict>> {
    const g = await this.governed(input)
    if (!g.ok) return g
    const { community, policy: p } = g.value
    if (p.status !== 'draft') return err({ code: 'policy_not_draft', status: p.status })
    if (input.version !== p.version) return err({ code: 'version_mismatch', version: p.version })
    const schedule = this.refused(p.schedule)
    if (schedule) return err(schedule)
    if (!p.compiled.amountsInInstruction) return err({ code: 'policy_blocked', problems: ['amount_not_in_instruction'] })
    const version = await this.deps.policies.getVersion(p.id, p.version)
    if (!version) throw new Error(`policy ${p.id} has no version ${p.version}`)
    if (community.requireSeparateApprover && version.authoredBy === input.actor) return err({ code: 'creator_cannot_approve' })
    const now = this.deps.clock.now()
    const next: Policy = { ...p, status: 'active', approvedBy: input.actor, approvedAt: now, activeSince: now, updatedAt: now, rev: p.rev + 1 }
    const saved = await this.save(next, { ...version, approvedBy: input.actor, approvedAt: now })
    if (!saved.ok) return saved
    await this.event(next, 'policy.approved', input.actor, { mode: next.mode })
    return ok(next)
  }

  /**
   * Drops a draft. An edit of an approved policy goes back to the last approved version, paused
   * (an approver resumes it); a policy never approved is archived. The author or an approver.
   */
  async discard(input: PolicyActor & { policyId: string }): Promise<Result<Policy, NotFound | NotPermitted | Conflict | { code: 'policy_not_draft'; status: Policy['status'] }>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const found = await this.find(input)
    if (!found.ok) return found
    const p = found.value
    const versions = await this.deps.policies.listVersions(p.id)
    const current = versions.find((v) => v.version === p.version)
    if (!canApprovePolicies(community, input.actorRoleIds) && current?.authoredBy !== input.actor) return err({ code: 'not_permitted' })
    if (p.status !== 'draft') return err({ code: 'policy_not_draft', status: p.status })
    const now = this.deps.clock.now()
    const prior = versions.filter((v) => v.version < p.version && v.approvedBy !== null && v.discardedBy === null).at(-1)
    const next: Policy = prior
      ? {
          ...p,
          name: prior.name,
          instruction: prior.instruction,
          compiled: prior.compiled,
          schedule: prior.schedule,
          caps: prior.caps,
          version: prior.version,
          status: 'paused',
          approvedBy: prior.approvedBy,
          approvedAt: prior.approvedAt,
          activeSince: null,
          updatedAt: now,
          rev: p.rev + 1,
        }
      : { ...p, status: 'archived', updatedAt: now, rev: p.rev + 1 }
    const discarded = current ? { ...current, discardedBy: input.actor, discardedAt: now } : undefined
    const saved = await this.save(next, discarded)
    if (!saved.ok) return saved
    await this.event(next, 'policy.discarded', input.actor, { discarded: p.version, restored: prior?.version ?? null })
    return ok(next)
  }

  async pause(input: PolicyActor & { policyId: string }): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict>> {
    return this.transition(input, 'policy.paused', (p) => (p.status === 'active' ? ok({ status: 'paused' }) : err({ code: 'policy_not_active', status: p.status })))
  }

  /** Resumes a paused policy. Periods that ended while it was paused are never run (no backfill). */
  async resume(input: PolicyActor & { policyId: string }): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict>> {
    return this.transition(input, 'policy.resumed', (p, now) => {
      if (p.status !== 'paused') return err({ code: 'policy_not_paused', status: p.status })
      const schedule = this.refused(p.schedule)
      return schedule ? err(schedule) : ok({ status: 'active', activeSince: now })
    })
  }

  async archive(input: PolicyActor & { policyId: string }): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict>> {
    return this.transition(input, 'policy.archived', () => ok({ status: 'archived', autopilot: null, mode: 'propose' }))
  }

  /**
   * Propose (each run waits for the one-tap approval) or autopilot (each run pays after the veto
   * window unless vetoed), and the veto window. Autopilot is an explicit switch on an approved
   * policy; runs are then approved in the name of the approver who switched it on, while they still
   * hold the approver role.
   */
  async setMode(
    input: PolicyActor & { policyId: string; mode: PolicyMode; vetoWindowMinutes?: number },
  ): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict | InvalidInput>> {
    const mode = PolicyModeSchema.safeParse(input.mode)
    if (!mode.success) return invalidInput(mode.error)
    const g = await this.governed(input)
    if (!g.ok) return g
    const { community, policy: p } = g.value
    if (mode.data === 'autopilot') {
      if (p.approvedBy === null || p.status === 'draft') return err({ code: 'policy_not_approved' })
      const version = await this.deps.policies.getVersion(p.id, p.version)
      if (community.requireSeparateApprover && version?.authoredBy === input.actor) return err({ code: 'creator_cannot_approve' })
    }
    const minutes = input.vetoWindowMinutes ?? p.vetoWindowMinutes
    if (!Number.isInteger(minutes) || minutes < this.minVeto || minutes > POLICY_LIMITS.maxVetoMinutes) {
      return err({ code: 'invalid_veto_window', min: this.minVeto, max: POLICY_LIMITS.maxVetoMinutes })
    }
    const now = this.deps.clock.now()
    const next: Policy = {
      ...p,
      mode: mode.data,
      vetoWindowMinutes: minutes,
      autopilot: mode.data === 'autopilot' ? { enabledBy: input.actor, enabledAt: now, approverRoleId: community.approverRoleId as string } : null,
      updatedAt: now,
      rev: p.rev + 1,
    }
    const saved = await this.save(next)
    if (!saved.ok) return saved
    await this.event(next, 'policy.mode_changed', input.actor, { from: p.mode, to: next.mode, vetoWindowMinutes: minutes })
    return ok(next)
  }

  /**
   * Veto an autopilot run during its window (the approver role): the run is cancelled and nothing
   * is paid. A veto counts until the scheduler has released the run.
   */
  async veto(
    input: PolicyActor & { policyRunId: string },
  ): Promise<
    Result<
      { policyRun: PolicyRun; run: Run | null },
      NotFound | NotPermitted | Conflict | { code: 'policy_run_not_found' } | { code: 'not_scheduled'; status: PolicyRunStatus } | { code: 'too_late'; status: Run['status'] }
    >
  > {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canApprovePolicies(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const pr = await this.deps.policyRuns.get(input.policyRunId)
    if (!pr || pr.communityId !== input.guildId) return err({ code: 'policy_run_not_found' })
    if (pr.status !== 'scheduled') return err({ code: 'not_scheduled', status: pr.status })
    const run = pr.runId ? await this.deps.payRuns.get({ guildId: input.guildId, runId: pr.runId }) : null
    if (run?.ok && run.value.status !== 'pending_approval' && run.value.status !== 'draft') return err({ code: 'too_late', status: run.value.status })
    const moved = movePolicyRun(pr, { type: 'vetoed', by: input.actor }, this.deps.clock.now())
    if (!moved.ok) return err({ code: 'not_scheduled', status: pr.status })
    // The compare-and-set against the scheduler's release: exactly one of the two wins.
    if ((await this.deps.policyRuns.update(moved.value)) === 'conflict') {
      const now = await this.deps.policyRuns.get(pr.id)
      return err({ code: 'not_scheduled', status: now?.status ?? pr.status })
    }
    const cancelled = pr.runId ? await this.deps.payRuns.cancel({ guildId: input.guildId, runId: pr.runId, actor: input.actor }) : null
    await this.deps.audit.record({
      communityId: pr.communityId,
      type: 'policy_run.vetoed',
      actor: input.actor,
      policyId: pr.policyId,
      policyVersion: pr.policyVersion,
      policyRunId: pr.id,
      runId: pr.runId,
      details: { total: formatAmount(pr.total), lines: pr.lines.length },
    })
    if (cancelled && !cancelled.ok) {
      const current = await this.deps.payRuns.get({ guildId: input.guildId, runId: pr.runId as string })
      return err({ code: 'too_late', status: current.ok ? current.value.status : 'executing' })
    }
    return ok({ policyRun: moved.value, run: cancelled?.ok ? cancelled.value : null })
  }

  // ---- reading ---------------------------------------------------------------------------

  async get(input: Ref): Promise<Result<Policy, { code: 'policy_not_found' }>> {
    return this.find(input)
  }

  /** Every policy of the community, newest first, with its next run (active ones) and its latest run. */
  async list(input: { guildId: string }): Promise<PolicySummary[]> {
    const now = this.deps.clock.now()
    const policies = await this.deps.policies.listByCommunity(input.guildId)
    return Promise.all(policies.map(async (policy) => ({ policy, nextRunAt: this.nextRunAt(policy, now), lastRun: (await this.deps.policyRuns.list(input.guildId, { policyId: policy.id, limit: 1 }))[0] ?? null })))
  }

  /** One policy: its version history (oldest first), its recent runs, the next run and the rule in plain words. */
  async detail(input: Ref & { runs?: number }): Promise<Result<PolicyDetail, { code: 'policy_not_found' }>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const policy = found.value
    const [versions, runs] = await Promise.all([this.deps.policies.listVersions(policy.id), this.deps.policyRuns.list(input.guildId, { policyId: policy.id, limit: input.runs ?? 20 })])
    return ok({
      policy,
      versions,
      runs,
      lastRun: runs[0] ?? null,
      nextRunAt: this.nextRunAt(policy, this.deps.clock.now()),
      rule: describeRule(policy.compiled, { schedule: policy.schedule, caps: policy.caps, guildId: policy.communityId }),
    })
  }

  /**
   * Who the policy applies to right now: the period in progress (since the last occurrence) run
   * through the compiled rule, with each person's metric, why they match and what the next run
   * would pay; the unregistered and the near misses apart; the total against the bot key's budget.
   * Reads Discord and the chain; never calls the model.
   */
  async preview(input: Ref): Promise<Result<PolicyPreview, { code: 'policy_not_found' } | { code: 'discord_not_configured' } | ReadError | CriteriaError>> {
    const found = await this.find(input)
    if (!found.ok) return found
    const p = found.value
    if (!this.deps.activity) return err({ code: 'discord_not_configured' })
    const now = this.deps.clock.now()
    const window = previewWindow(p.schedule, now)
    const author = (await this.deps.policies.getVersion(p.id, p.version))?.authoredBy ?? p.createdBy
    const ev = await evaluatePolicy(
      { activity: this.deps.activity, payees: this.deps.payees, runs: this.deps.runs },
      { communityId: p.communityId, compiled: p.compiled, caps: p.caps, authorId: author, window, now },
    )
    if (!ev.ok) return ev
    const remaining = await this.remaining(p.communityId)
    const e = ev.value
    return ok({
      policyId: p.id,
      version: p.version,
      window: { start: window.start, end: window.end },
      nextRunAt: window.nextRunAt,
      matches: e.matches,
      nearMisses: e.nearMisses,
      total: e.total,
      remaining,
      problems: [
        ...(p.compiled.amountsInInstruction ? [] : ['amount_not_in_instruction']),
        ...e.problems,
        ...runGuards({ lines: e.lines.length, total: e.total, caps: p.caps, remaining }).map((h) => h.code),
      ],
      rule: describeRule(p.compiled, { schedule: p.schedule, caps: p.caps, guildId: p.communityId }),
      scans: e.scans,
    })
  }

  /** The dashboard name for the same read: who it applies to right now. */
  listMatches(input: Ref) {
    return this.preview(input)
  }

  /** The next scheduled run of each active policy, soonest first. */
  async nextRuns(input: { guildId: string; limit?: number }): Promise<{ policyId: string; name: string; mode: PolicyMode; at: Date }[]> {
    const now = this.deps.clock.now()
    return (await this.deps.policies.listByCommunity(input.guildId))
      .flatMap((p) => {
        const at = this.nextRunAt(p, now)
        return at ? [{ policyId: p.id, name: p.name, mode: p.mode, at }] : []
      })
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, input.limit ?? 10)
  }

  /** Runs of the community's policies (or one policy's), newest period first. */
  listRuns(input: { guildId: string; policyId?: string; statuses?: readonly PolicyRunStatus[]; limit?: number }): Promise<PolicyRun[]> {
    return this.deps.policyRuns.list(input.guildId, { ...(input.policyId ? { policyId: input.policyId } : {}), ...(input.statuses ? { statuses: input.statuses } : {}), limit: input.limit ?? 50 })
  }

  async getRun(input: { guildId: string; policyRunId: string }): Promise<Result<PolicyRun, { code: 'policy_run_not_found' }>> {
    const pr = await this.deps.policyRuns.get(input.policyRunId)
    return pr && pr.communityId === input.guildId ? ok(pr) : err({ code: 'policy_run_not_found' })
  }

  /** Which policy (and version) made a pay run, if any: for the run detail page and the Discord embeds. */
  async runFor(input: { guildId: string; runId: string }): Promise<{ policy: Policy; policyRun: PolicyRun } | null> {
    const pr = await this.deps.policyRuns.getByRunId(input.runId)
    if (!pr || pr.communityId !== input.guildId) return null
    const policy = await this.deps.policies.get(pr.policyId)
    return policy ? { policy, policyRun: pr } : null
  }

  // ---- internals -------------------------------------------------------------------------

  /** May write policies: the approver or the proposer role; with `ai`, the model must be configured and AI on. */
  private async writerGate(input: PolicyActor, opts: { ai: boolean }): Promise<Result<Community, NotFound | NotPermitted | AiGate>> {
    if (opts.ai && (!this.deps.proposer || !this.deps.activity)) return err({ code: 'ai_not_configured' })
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canPropose(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    if (opts.ai && !community.aiProposals) return err({ code: 'ai_disabled' })
    return ok(community)
  }

  /** The community and policy, for a caller holding the CURRENT approver role. */
  private async governed(input: PolicyActor & { policyId: string }): Promise<Result<{ community: Community; policy: Policy }, NotFound | NotPermitted | { code: 'policy_archived' }>> {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canApprovePolicies(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const policy = await this.find(input)
    if (!policy.ok) return policy
    if (policy.value.status === 'archived') return err({ code: 'policy_archived' })
    return ok({ community, policy: policy.value })
  }

  private async transition(
    input: PolicyActor & { policyId: string },
    type: 'policy.paused' | 'policy.resumed' | 'policy.archived',
    change: (p: Policy, now: Date) => Result<Partial<Policy>, PolicyStateError>,
  ): Promise<Result<Policy, NotFound | NotPermitted | PolicyStateError | Conflict>> {
    const g = await this.governed(input)
    if (!g.ok) return g
    const p = g.value.policy
    const now = this.deps.clock.now()
    const changes = change(p, now)
    if (!changes.ok) return changes
    const next: Policy = { ...p, ...changes.value, updatedAt: now, rev: p.rev + 1 }
    const saved = await this.save(next)
    if (!saved.ok) return saved
    await this.event(next, type, input.actor, { status: next.status })
    return ok(next)
  }

  private async find(input: Ref): Promise<Result<Policy, { code: 'policy_not_found' }>> {
    const p = await this.deps.policies.get(input.policyId)
    return p && p.communityId === input.guildId ? ok(p) : err({ code: 'policy_not_found' })
  }

  private async save(next: Policy, version?: PolicyVersion): Promise<Result<void, Conflict>> {
    return (await this.deps.policies.update(PolicySchema.parse(next), version)) === 'updated' ? ok(undefined) : err({ code: 'concurrent_update' })
  }

  /**
   * Criteria mode, once: the instruction (roles, channels and people as tokens) to a checked filter
   * and amount plan. Every call that reaches the model is a usage row; one that compiles is linked
   * to the version it makes.
   */
  private async compile(
    community: Community,
    instruction: string,
    target: { actor: string; policyId: string; version: number },
  ): Promise<Result<CompiledRule, CompileError | AiGate>> {
    const { policyId } = target
    const { proposer, activity } = this.deps
    if (!proposer || !activity) return err({ code: 'ai_not_configured' })
    const now = this.deps.clock.now()
    const watch = stopwatch(this.deps.clock)
    const [names, remaining] = await Promise.all([
      watch.time('discordMs', () => activity.guildNames(community.id)),
      watch.time('chainMs', () => this.remaining(community.id)),
    ])
    const tokens = tokenizeInstruction(instruction, { guildId: community.id, roles: names.roles, channels: names.channels })
    const answer = await watch.time('modelMs', () => proposer.fromCriteria({
      instruction: tokens.text,
      today: now.toISOString().slice(0, 10),
      maxLookbackDays: PROPOSAL_LIMITS.maxLookbackDays,
      roles: tokens.roles,
      channels: tokens.channels,
      token: symbol(community),
      remaining: remaining === null ? null : formatAmount(remaining),
    }))
    const timings = watch.done()
    const usage = answer.ok ? answer.value.usage : answer.error.usage
    const log = async (outcome: string) => {
      this.deps.log?.({
        proposalId: policyId,
        mode: 'criteria',
        outcome,
        sourceMessages: 0,
        scannedMessages: 0,
        lines: 0,
        held: 0,
        unregistered: 0,
        model: usage?.model ?? proposer.model,
        inputTokens: usage?.inputTokens ?? null,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: usage?.costMicroUsd == null ? null : formatAmount(BigInt(usage.costMicroUsd)),
        latencyMs: usage?.latencyMs ?? null,
        timings,
      })
      // Past the daily cap the model was not called: nothing was spent.
      if (!answer.ok && answer.error.reason === 'daily_cap') return
      const compiled = outcome === 'policy_compiled'
      await this.deps.aiUsage.append({
        communityId: community.id,
        purpose: 'policy_compile',
        actor: target.actor,
        model: usage?.model ?? proposer.model,
        inputTokens: usage?.inputTokens ?? null,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        latencyMs: usage?.latencyMs ?? null,
        costMicroUsd: usage?.costMicroUsd == null ? null : BigInt(usage.costMicroUsd),
        outcome: compiled ? 'proposed' : outcome,
        createdAt: this.deps.clock.now(),
        proposalId: null,
        runId: null,
        policyId: compiled ? policyId : null,
        policyVersion: compiled ? target.version : null,
      })
    }
    if (!answer.ok) {
      await log('could_not_propose')
      return err({ code: 'could_not_propose', reason: answer.error.reason })
    }
    const resolved = resolveCriteria(answer.value.raw, { refs: tokens.refs, now, instructionAmounts: amountsIn(instruction) })
    if (!resolved.ok) {
      await log(resolved.error.code)
      return resolved
    }
    await log('policy_compiled')
    const r = resolved.value
    return ok({ criteria: r.criteria, plan: r.plan, note: r.note, assumptions: r.assumptions, amountsInInstruction: r.amountsInInstruction })
  }

  private async remaining(guildId: string): Promise<Micros | null> {
    const status = await this.deps.communityService.keyStatus({ guildId })
    return status.ok && status.value.key.status === 'active' && status.value.state.status === 'active' ? status.value.state.remaining : null
  }

  private event(p: Policy, type: Parameters<AuditTrail['record']>[0]['type'], actor: string | null, details: Record<string, string | number | boolean | null>) {
    return this.deps.audit.record({ communityId: p.communityId, type, actor, policyId: p.id, policyVersion: p.version, details })
  }

  private compiledEvent(p: Policy, actor: string) {
    const c = p.compiled.criteria
    const conditions = [c.hasRole.length, c.lacksRole.length, c.joinedBefore, c.joinedAfter, c.messagesIn, c.activeDaysIn, c.repliesIn, c.reactedTo, c.mentionedIn, c.postedIn, c.paidInRun, c.neverPaid, c.exclude.length, c.excludeProposer].filter(
      Boolean,
    ).length
    return this.event(p, 'policy.compiled', actor, { rule: p.compiled.plan.rule.kind, conditions, amountsInInstruction: p.compiled.amountsInInstruction })
  }
}

function versionOf(p: Policy, authoredBy: string, at: Date): PolicyVersion {
  return {
    policyId: p.id,
    communityId: p.communityId,
    version: p.version,
    name: p.name,
    instruction: p.instruction,
    compiled: p.compiled,
    schedule: p.schedule,
    caps: p.caps,
    authoredBy,
    authoredAt: at,
    approvedBy: null,
    approvedAt: null,
    discardedBy: null,
    discardedAt: null,
  }
}
