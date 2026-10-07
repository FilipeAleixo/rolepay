import { POLICY_LIMITS } from '../constants/limits.js'
import { formatAmount } from '../domain/money.js'
import type { Community } from '../domain/community.js'
import { type Policy, canApprovePolicies, runWindow } from '../domain/policy/policy.js'
import { type Hold, type PolicyRun, type PolicyRunEvent, type Snapshot, movePolicyRun, newPolicyRun, runGuards } from '../domain/policy/policyRun.js'
import { nextOccurrence, occurrenceAtOrBefore, periodKey } from '../domain/policy/schedule.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Run } from '../domain/run.js'
import type { ActivityReader } from '../ports/activityReader.js'
import type { Clock } from '../ports/clock.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { CommunityRepository, PayeeRepository, PolicyRepository, PolicyRunRepository, RunRepository } from '../ports/repositories.js'
import type { AuditTrail } from './auditTrail.js'
import type { CommunityService } from './communityService.js'
import type { ExecuteOutcome, PayRunService } from './payRunService.js'
import { evaluatePolicy } from './policyEvaluation.js'
import type { PolicyActor } from './policyService.js'

export type SchedulerServiceDeps = {
  communities: CommunityRepository
  payees: PayeeRepository
  runs: RunRepository
  policies: PolicyRepository
  policyRuns: PolicyRunRepository
  ids: IdGenerator
  clock: Clock
  /** Discord history and members: what the compiled rule counts, and whether autopilot's approver still holds the role. */
  activity: ActivityReader | null
  communityService: CommunityService
  payRuns: PayRunService
  audit: AuditTrail
  /** How long an instance holds a run it is working on before another may take it over. */
  leaseSeconds?: number
}

/**
 * What a tick (or runNow) did, for the caller to tell people (the Discord layer posts these):
 * - `generated`: a period's run was made. Its status says how: `proposed` (the normal one-tap
 *   approval), `scheduled` (autopilot: pays at `executeAfter` unless vetoed), `held` (whole, with
 *   why) or `empty` (nobody matched). `run` is the pay run, if one was made.
 * - `released`: autopilot approved the run after its veto window and paid it (`outcome`).
 * - `held`: autopilot stopped at the release (paused, switched to propose, approver changed, the
 *   key cannot pay); the run, if pending, waits for a person's approval.
 * - `cancelled`: someone cancelled the run during the window.
 */
export type SchedulerEvent =
  | { kind: 'generated'; policy: Policy; policyRun: PolicyRun; run: Run | null; outcome?: undefined }
  | { kind: 'released'; policy: Policy; policyRun: PolicyRun; run: Run; outcome: ExecuteOutcome['status'] }
  | { kind: 'held'; policy: Policy; policyRun: PolicyRun; run: Run | null; outcome?: undefined }
  | { kind: 'cancelled'; policy: Policy; policyRun: PolicyRun; run: Run | null; outcome?: undefined }

export type TickReport = { events: SchedulerEvent[]; errors: { policyId: string; policyRunId: string | null; error: string }[] }

const NO_SNAPSHOT = { lines: [], unregistered: [], total: 0n, remaining: null, problems: [] } satisfies Snapshot
const redact = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)

/**
 * Runs approved policies on their schedules with code only (never the model): driven by the
 * server's interval like the recovery sweep. Safe with restarts and with two instances: a period
 * is claimed once (the unique key on policy and period), the run's ID is chosen before the run
 * exists (so a crash in between never makes a second run), work in progress holds a lease that
 * another instance takes over only once it has run out, and every move is a compare-and-set.
 * Autopilot runs pay only after their veto window, only if not vetoed, and through the normal
 * approve and execute (the bot key's on-chain limit caps them). A run that would exceed the key's
 * remaining budget, the policy's cap or one run's size is held whole and explained.
 */
export class SchedulerService {
  constructor(private readonly deps: SchedulerServiceDeps) {}

  private get leaseMs() {
    return (this.deps.leaseSeconds ?? POLICY_LIMITS.leaseSeconds) * 1000
  }

  /** One pass: make the runs that are due, take over abandoned work, release autopilot runs whose window has passed. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { events: [], errors: [] }
    const attempt = async (policyId: string, policyRunId: string | null, work: () => Promise<SchedulerEvent | null>) => {
      try {
        const e = await work()
        if (e) report.events.push(e)
      } catch (error) {
        report.errors.push({ policyId, policyRunId, error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }
    for (const policy of await this.deps.policies.listByStatus('active')) await attempt(policy.id, null, () => this.due(policy))
    const now = this.deps.clock.now()
    for (const pr of await this.deps.policyRuns.listByStatus(['generating', 'scheduled', 'releasing'])) {
      if (pr.status === 'scheduled' && pr.executeAfter && pr.executeAfter <= now) await attempt(pr.policyId, pr.id, () => this.release(pr))
      else if (pr.status !== 'scheduled' && pr.leaseUntil && pr.leaseUntil <= now) await attempt(pr.policyId, pr.id, () => this.takeOver(pr))
    }
    return report
  }

  /**
   * Makes the NEXT period's run now (an approver; the testnet dev shortcut that lets a demo skip
   * to Monday). The period is the same one the schedule would run, so the scheduled tick later
   * finds it made and does nothing.
   */
  async runNow(
    input: PolicyActor & { policyId: string },
  ): Promise<
    Result<
      SchedulerEvent,
      { code: 'community_not_found' } | { code: 'not_permitted' } | { code: 'policy_not_found' } | { code: 'policy_not_active' } | { code: 'already_run'; policyRunId: string }
    >
  > {
    const community = await this.deps.communities.get(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    if (!canApprovePolicies(community, input.actorRoleIds)) return err({ code: 'not_permitted' })
    const policy = await this.deps.policies.get(input.policyId)
    if (!policy || policy.communityId !== input.guildId) return err({ code: 'policy_not_found' })
    if (policy.status !== 'active') return err({ code: 'policy_not_active' })
    const occurrence = nextOccurrence(policy.schedule, this.deps.clock.now())
    const existing = await this.deps.policyRuns.getByPeriod(policy.id, periodKey(occurrence))
    if (existing) return err({ code: 'already_run', policyRunId: existing.id })
    const event = await this.claim(policy, occurrence, input.actor)
    if (!event) {
      const taken = await this.deps.policyRuns.getByPeriod(policy.id, periodKey(occurrence))
      return err({ code: 'already_run', policyRunId: taken?.id ?? '' })
    }
    return ok(event)
  }

  // ---- generating ------------------------------------------------------------------------

  /** The latest occurrence of an active policy's schedule, if it is after activation and not made yet. */
  private async due(policy: Policy): Promise<SchedulerEvent | null> {
    const occurrence = occurrenceAtOrBefore(policy.schedule, this.deps.clock.now())
    if (!policy.activeSince || occurrence < policy.activeSince) return null
    if (await this.deps.policyRuns.getByPeriod(policy.id, periodKey(occurrence))) return null
    return this.claim(policy, occurrence, null)
  }

  /** Claims the period (once, whoever asks) with a lease and the run ID it will use, then makes the run. */
  private async claim(policy: Policy, occurrence: Date, actor: string | null): Promise<SchedulerEvent | null> {
    const now = this.deps.clock.now()
    const pr = newPolicyRun({
      id: this.deps.ids.policyRunId(),
      policyId: policy.id,
      policyVersion: policy.version,
      communityId: policy.communityId,
      mode: policy.mode,
      window: runWindow(policy.schedule, occurrence),
      runId: this.deps.ids.runId(),
      now,
      leaseUntil: new Date(now.getTime() + this.leaseMs),
    })
    if (!(await this.deps.policyRuns.claim(pr))) return null
    return this.generate(policy, pr, actor)
  }

  /** Abandoned work (its instance died): take the lease and carry on from where the records say. */
  private async takeOver(pr: PolicyRun): Promise<SchedulerEvent | null> {
    const leased = await this.move(pr, { type: 'lease', until: new Date(this.deps.clock.now().getTime() + this.leaseMs) })
    if (!leased) return null
    if (leased.status === 'releasing') return this.finishRelease(leased)
    const policy = await this.deps.policies.get(leased.policyId)
    if (!policy) throw new Error(`policy ${leased.policyId} is missing`)
    return this.generate(policy, leased, null)
  }

  /**
   * Runs the compiled rule over the period with code, applies the guards, and makes the pay run
   * with the ID chosen at the claim. If that run already exists (a crash after making it), it
   * carries on from it instead of making another.
   */
  private async generate(policy: Policy, pr: PolicyRun, actor: string | null): Promise<SchedulerEvent | null> {
    const existing = pr.runId ? await this.deps.runs.get(pr.runId) : null
    if (existing) return this.finishGeneration(policy, pr, existing, fromRun(existing), actor)
    const author = (await this.deps.policies.getVersion(policy.id, pr.policyVersion))?.authoredBy ?? policy.createdBy
    const hold = (h: Hold, snapshot: Partial<Snapshot> = {}) => this.hold(policy, pr, h, null, { ...snapshot, runId: null }, actor, 'generated')
    if (!this.deps.activity) return hold({ code: 'discord_not_configured', total: null, limit: null })
    const now = this.deps.clock.now()
    const ev = await evaluatePolicy(
      { activity: this.deps.activity, payees: this.deps.payees, runs: this.deps.runs },
      { communityId: policy.communityId, compiled: policy.compiled, caps: policy.caps, authorId: author, window: { start: pr.periodStart, end: pr.periodEnd }, now },
    )
    if (!ev.ok) return hold({ code: ev.error.code, total: null, limit: null })
    const remaining = await this.remaining(policy.communityId)
    const snapshot: Snapshot = { lines: ev.value.lines.slice(0, 1000), unregistered: ev.value.unregistered, total: ev.value.total, remaining, problems: ev.value.problems }
    if (snapshot.lines.length === 0) {
      const empty = await this.move(pr, { type: 'empty', runId: null, ...snapshot })
      if (!empty) return null
      await this.event(empty, 'policy_run.empty', actor, { unregistered: snapshot.unregistered.length })
      return { kind: 'generated', policy, policyRun: empty, run: null }
    }
    const guard = runGuards({ lines: ev.value.lines.length, total: ev.value.total, caps: policy.caps, remaining })[0]
    if (guard) return hold(guard, snapshot)
    const created = await this.deps.payRuns.create(
      { guildId: policy.communityId, createdBy: author, note: policy.compiled.note ?? policy.name, lines: ev.value.lines.map((l) => ({ discordUserId: l.discordUserId, amount: l.amount })) },
      { runId: pr.runId as string },
    )
    if (!created.ok) return hold({ code: created.error.code, total: ev.value.total, limit: null }, snapshot)
    return this.finishGeneration(policy, pr, created.value, snapshot, actor)
  }

  private async finishGeneration(policy: Policy, pr: PolicyRun, made: Run, snapshot: Snapshot, actor: string | null): Promise<SchedulerEvent | null> {
    let run = made
    if (run.status === 'draft') {
      const submitted = await this.deps.payRuns.submit({ guildId: run.communityId, runId: run.id, actor: run.createdBy })
      if (submitted.ok) run = submitted.value
    }
    const now = this.deps.clock.now()
    const moved =
      pr.mode === 'autopilot'
        ? await this.move(pr, { type: 'scheduled', runId: run.id, executeAfter: new Date(now.getTime() + policy.vetoWindowMinutes * 60_000), ...snapshot })
        : await this.move(pr, { type: 'proposed', runId: run.id, ...snapshot })
    if (!moved) return null
    await this.event(moved, 'policy_run.generated', actor, {
      mode: moved.mode,
      total: formatAmount(moved.total),
      lines: moved.lines.length,
      unregistered: moved.unregistered.length,
      executeAfter: moved.executeAfter?.toISOString() ?? null,
    })
    return { kind: 'generated', policy, policyRun: moved, run }
  }

  // ---- releasing (autopilot) ---------------------------------------------------------------

  /** The veto window has passed: take the run (the domain refuses before `executeAfter`), then approve and pay it. */
  private async release(pr: PolicyRun): Promise<SchedulerEvent | null> {
    const leased = await this.move(pr, { type: 'lease', until: new Date(this.deps.clock.now().getTime() + this.leaseMs) })
    return leased ? this.finishRelease(leased) : null
  }

  private async finishRelease(pr: PolicyRun): Promise<SchedulerEvent | null> {
    const policy = await this.deps.policies.get(pr.policyId)
    const community = await this.deps.communities.get(pr.communityId)
    if (!policy || !community) throw new Error(`policy ${pr.policyId} or its community is missing`)
    const loaded = pr.runId ? await this.deps.runs.get(pr.runId) : null
    if (!loaded) return this.hold(policy, pr, { code: 'run_missing', total: pr.total, limit: null }, null, {}, null, 'held')
    let run = loaded
    if (run.status === 'cancelled') {
      const cancelled = await this.move(pr, { type: 'cancelled' })
      if (!cancelled) return null
      await this.event(cancelled, 'policy_run.cancelled', null, { by: run.cancelledBy })
      return { kind: 'cancelled', policy, policyRun: cancelled, run }
    }
    if (run.status === 'pending_approval' || run.status === 'draft') {
      const stop = await this.autopilotStop(policy, community, pr)
      if (stop) return this.hold(policy, pr, stop, run, {}, null, 'held')
      const approved = await this.deps.payRuns.approve({ guildId: run.communityId, runId: run.id, actor: policy.autopilot?.enabledBy as string, actorCanApprove: true })
      if (!approved.ok) return this.hold(policy, pr, { code: approved.error.code, total: run.total, limit: null }, (await this.deps.runs.get(run.id)) ?? run, {}, null, 'held')
      run = approved.value
    }
    // Approved (by autopilot, or by a person who did not wait) or already in flight: pay, idempotently.
    // A paid or failed run is left as it is: a failure waits for a person's Retry.
    let outcome: ExecuteOutcome['status'] = run.status === 'paid' ? 'paid' : run.status === 'failed' ? 'failed' : 'pending'
    if (run.status === 'approved' || run.status === 'executing') {
      const executed = await this.deps.payRuns.execute({ guildId: run.communityId, runId: run.id })
      if (!executed.ok && executed.error.code !== 'concurrent_update') {
        const e = executed.error
        const limit = e.code === 'insufficient_limit' ? e.remaining : null
        return this.hold(policy, pr, { code: e.code, total: run.total, limit }, (await this.deps.runs.get(run.id)) ?? run, {}, null, 'held')
      }
      if (executed.ok) {
        run = executed.value.run
        outcome = executed.value.status
      }
    }
    const released = await this.move(pr, { type: 'released', by: run.approvedBy ?? policy.autopilot?.enabledBy ?? policy.createdBy })
    if (!released) return null
    await this.event(released, 'policy_run.released', null, { outcome, total: formatAmount(run.total), lines: run.lines.length })
    return { kind: 'released', policy, policyRun: released, run, outcome }
  }

  /**
   * Why autopilot must not approve this run now, if anything: the policy is not active, not on
   * autopilot, or changed since the run was made; or the approver who switched autopilot on no
   * longer holds the community's approver role (or the role itself changed).
   */
  private async autopilotStop(policy: Policy, community: Community, pr: PolicyRun): Promise<Hold | null> {
    const stop = (code: string): Hold => ({ code, total: pr.total, limit: null })
    if (policy.status !== 'active') return stop('policy_not_active')
    if (policy.mode !== 'autopilot' || !policy.autopilot) return stop('autopilot_off')
    if (policy.version !== pr.policyVersion) return stop('policy_changed')
    const { enabledBy, approverRoleId } = policy.autopilot
    if (community.approverRoleId !== approverRoleId) return stop('approver_changed')
    if (!this.deps.activity) return stop('discord_not_configured')
    const member = (await this.deps.activity.members(community.id, [enabledBy]))[enabledBy]
    if (!member?.roleIds.includes(approverRoleId)) return stop('approver_changed')
    return null
  }

  // ---- internals -------------------------------------------------------------------------

  private async hold(
    policy: Policy,
    pr: PolicyRun,
    hold: Hold,
    run: Run | null,
    extra: Partial<Snapshot> & { runId?: string | null },
    actor: string | null,
    kind: 'generated' | 'held',
  ): Promise<SchedulerEvent | null> {
    const held = await this.move(pr, { type: 'held', hold, ...extra })
    if (!held) return null
    await this.event(held, 'policy_run.held', actor, { code: hold.code, total: hold.total === null ? null : formatAmount(hold.total), limit: hold.limit === null ? null : formatAmount(hold.limit) })
    return { kind, policy, policyRun: held, run }
  }

  /** A compare-and-set move; null when another instance moved it first (it owns the rest). */
  private async move(pr: PolicyRun, event: PolicyRunEvent): Promise<PolicyRun | null> {
    const next = movePolicyRun(pr, event, this.deps.clock.now())
    if (!next.ok) return null
    return (await this.deps.policyRuns.update(next.value)) === 'updated' ? next.value : null
  }

  private event(pr: PolicyRun, type: 'policy_run.generated' | 'policy_run.held' | 'policy_run.empty' | 'policy_run.released' | 'policy_run.cancelled', actor: string | null, details: Record<string, string | number | boolean | null>) {
    return this.deps.audit.record({ communityId: pr.communityId, type, actor, policyId: pr.policyId, policyVersion: pr.policyVersion, policyRunId: pr.id, runId: pr.runId, details })
  }

  private async remaining(guildId: string) {
    const status = await this.deps.communityService.keyStatus({ guildId })
    return status.ok && status.value.key.status === 'active' && status.value.state.status === 'active' ? status.value.state.remaining : null
  }
}

/** Rebuilds what a run pays from the run itself (after a crash lost the computed snapshot). */
function fromRun(run: Run): Snapshot {
  return {
    ...NO_SNAPSHOT,
    lines: run.lines.map((l) => ({ discordUserId: l.payeeDiscordId, amount: l.amount, metrics: { messages: null, activeDays: null, replies: null }, capped: false })),
    total: run.total,
  }
}
