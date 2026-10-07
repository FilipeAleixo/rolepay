import {
  AUDIT_EVENT_TYPES,
  type ActivityReader,
  type AuditEvent,
  type AuditEventType,
  type CompiledRule,
  MAX_LINES_PER_RUN,
  type Micros,
  type Names,
  type Policy,
  type PolicyCaps,
  type PolicyRun,
  type PolicyVersion,
  type Result,
  type Rolepay,
  type Schedule,
  TOKEN_SYMBOLS,
  WEEKDAYS,
  describeMatch,
  describeRule,
  err,
  formatAmount,
  ok,
} from '@rolepay/core'
import type {
  AuditEventView,
  AuditPort,
  PolicyActor,
  PolicyDetail,
  PolicyError,
  PolicyNearMiss,
  PolicyPort,
  PolicyPreview,
  PolicySchedule,
  PolicySummary,
  PolicyVersionView,
  RunOrigin,
} from '@rolepay/web'

/**
 * THE POLICY SEAM, wired: the dashboard's PolicyPort and AuditPort over core's PolicyService and
 * AuditService. Thin on purpose: core decides (permissions from the actor's roles, states,
 * versions, the veto race), this file only maps shapes and writes words. Everything a page shows
 * here is written by code from codes, counts, amounts and IDs; role and channel names come from
 * the bot's view of Discord (`names`), people are named by the dashboard itself.
 */

/** Where role and channel names come from: the bot's Discord view (the same ActivityReader core uses). */
export type NameSource = Pick<ActivityReader, 'guildNames'>

const pad = (n: number) => String(n).padStart(2, '0')
const utc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
const notRegistered = (n: number) => `${people(n)} matched but ${n === 1 ? 'is' : 'are'} not registered`

/** "1 minute", "90 minutes", "1 hour", "24 hours". */
const vetoWords = (minutes: number) => (minutes % 60 === 0 ? (minutes === 60 ? '1 hour' : `${minutes / 60} hours`) : minutes === 1 ? '1 minute' : `${minutes} minutes`)

export function toPortSchedule(s: Schedule): PolicySchedule {
  return s.kind === 'weekly' ? { kind: 'weekly', weekday: WEEKDAYS.indexOf(s.weekday), hour: s.hour, timezone: s.timezone } : { kind: 'monthly', day: s.day, hour: s.hour, timezone: s.timezone }
}

export function toCoreSchedule(s: PolicySchedule): Schedule {
  return s.kind === 'weekly'
    ? { kind: 'weekly', weekday: WEEKDAYS[s.weekday] ?? 'monday', hour: s.hour, timezone: s.timezone }
    : { kind: 'monthly', day: s.day, hour: s.hour, timezone: s.timezone }
}

/** The compiled rule as JSON: money (every bigint in it) as decimal text, dates as ISO strings. */
const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? formatAmount(x) : x)))

const symbolOf = async (rolepay: Rolepay, guildId: string) => {
  const c = await rolepay.communities.get(guildId)
  return c.ok ? (TOKEN_SYMBOLS[c.value.payoutToken.toLowerCase()] ?? TOKEN_SYMBOLS[c.value.payoutToken] ?? 'tokens') : 'tokens'
}

/** Names for the rule in words: roles and channels from Discord when it answers, IDs otherwise; money with the token. */
async function namesFor(rolepay: Rolepay, guildId: string, source: NameSource | undefined): Promise<Names & { money: (m: Micros) => string }> {
  const symbol = await symbolOf(rolepay, guildId)
  const roles = new Map<string, string>()
  const channels = new Map<string, string>()
  if (source) {
    try {
      const n = await source.guildNames(guildId)
      for (const r of n.roles) roles.set(r.id, r.name)
      for (const c of n.channels) channels.set(c.id, c.name)
    } catch {
      // Discord did not answer: the words name roles and channels by ID instead.
    }
  }
  return {
    money: (m: Micros) => `${formatAmount(m)} ${symbol}`,
    role: (id: string) => `@${roles.get(id) ?? `role ${id}`}`,
    channel: (id: string) => `#${channels.get(id) ?? id}`,
    user: (id: string) => `user ${id}`,
    guildId,
  }
}

const ruleWords = (compiled: CompiledRule, d: { schedule: Schedule; caps: PolicyCaps }, names: Names) => describeRule(compiled, { schedule: d.schedule, caps: d.caps, ...names }).join(' ')

function detailOf(p: Policy, nextRunAt: Date | null, names: Names): PolicyDetail {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    mode: p.mode,
    schedule: toPortSchedule(p.schedule),
    version: p.version,
    nextRunAt,
    matchesNow: null,
    instruction: p.instruction,
    ruleInWords: ruleWords(p.compiled, p, names),
    filter: jsonSafe(p.compiled),
    vetoWindowMinutes: p.vetoWindowMinutes,
    caps: p.caps,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    approvedBy: p.approvedBy,
    approvedAt: p.approvedAt,
    // In core an edit IS the policy until it is approved (the policy stops running meanwhile).
    pendingVersion: p.status === 'draft' ? p.version : null,
  }
}

/**
 * A version's place in the history: the latest approval (`approved`, also while an edit waits),
 * the edit waiting for approval (`pending`), an approval a later one replaced (`superseded`), or
 * dropped (`discarded`: discarded, or replaced by an edit before anyone approved it).
 */
function versionStatus(v: PolicyVersion, p: Policy, versions: readonly PolicyVersion[]): PolicyVersionView['status'] {
  if (v.discardedBy !== null) return 'discarded'
  if (v.version === p.version && p.status === 'draft') return 'pending'
  if (v.approvedBy === null) return 'discarded'
  const latest = Math.max(...versions.filter((x) => x.approvedBy !== null && x.discardedBy === null).map((x) => x.version))
  return v.version === latest ? 'approved' : 'superseded'
}

const COUNT_METRIC = { messagesIn: 'messages', activeDaysIn: 'activeDays', repliesIn: 'replies' } as const

const metricsOf = (m: Record<string, number | null>) => Object.fromEntries(Object.entries(m).filter((e): e is [string, number] => typeof e[1] === 'number'))

/** The cap that binds a capped line: the smallest of the rule's, the plan's and the policy's per-person caps. */
function bindingCap(p: Policy): Micros | null {
  const rule = p.compiled.plan.rule
  const caps = [rule.kind === 'perUnit' ? rule.cap : null, p.compiled.plan.perPersonCap, p.caps.perPerson].filter((c): c is Micros => c !== null)
  return caps.length ? caps.reduce((a, b) => (a < b ? a : b)) : null
}

/** Why the next run would be held (whole, never in part), from the preview's problems. */
function heldWords(problems: readonly string[], d: { total: Micros; remaining: Micros | null; caps: PolicyCaps }, money: (m: Micros) => string): string | null {
  const words = problems.flatMap((code) => {
    switch (code) {
      case 'too_many_lines':
        return [`More people match than one run can pay (${MAX_LINES_PER_RUN}): it would be held, not partly paid.`]
      case 'over_policy_cap':
        return d.caps.perRun === null ? [] : [`The run (${money(d.total)}) is over the policy's cap per run (${money(d.caps.perRun)}): it would be held, not partly paid.`]
      case 'no_active_key':
        return ['There is no active bot key: it would be held until a treasurer authorises one on the setup page.']
      case 'over_budget':
        return d.remaining === null ? [] : [`The run (${money(d.total)}) is more than the bot key has left (${money(d.remaining)}): it would be held, not partly paid.`]
      default:
        return []
    }
  })
  return words.length ? words.join(' ') : null
}

/** A preview that could not be worked out, in words. */
function previewError(e: { code: string; channelId?: string; reason?: string }): PolicyError {
  switch (e.code) {
    case 'policy_not_found':
      return { code: e.code, message: 'That policy no longer exists.' }
    case 'discord_not_configured':
      return { code: e.code, message: 'This server is not connected to Discord.' }
    case 'cannot_read':
      return { code: e.code, message: `Rolepay cannot read channel ${e.channelId ?? ''} (the bot needs View Channel and Read Message History there).` }
    default:
      return { code: e.code, message: 'The rule cannot be run as compiled: edit it and compile it again.' }
  }
}

const COULD_NOT_PROPOSE: Record<string, string> = {
  refused: 'the AI declined. Try rewording the instruction.',
  malformed: 'the AI answered in a form Rolepay could not use. Try again.',
  unavailable: 'the AI service is not reachable right now. Try again in a minute.',
  rejected: 'the AI service refused the request (the server log says why).',
  auth: 'the AI service refused the API key (ANTHROPIC_API_KEY).',
  daily_cap: 'this server has used its AI calls for today; try again after midnight UTC.',
}

/** States core names one by one; the dashboard words them as one: not possible in the current state. */
const STATE_CODES = new Set(['policy_not_draft', 'policy_not_active', 'policy_not_paused', 'policy_archived', 'not_scheduled'])

const actionError = (e: { code: string }): PolicyError => ({ code: STATE_CODES.has(e.code) ? 'illegal_state' : e.code })

/** A refusal while compiling (create, or an edit with a new instruction): the form shows the message. */
function compileError(e: { code: string; reason?: string; problem?: string }): PolicyError {
  const failed = (why: string) => ({ code: 'could_not_compile', message: `The rule could not be compiled from that instruction: ${why}` })
  switch (e.code) {
    case 'could_not_propose':
      return failed(COULD_NOT_PROPOSE[e.reason ?? ''] ?? 'the AI answered in a form Rolepay could not use. Try again.')
    case 'criteria_unclear':
      return failed(e.problem?.trim() || 'it does not say who to pay.')
    case 'criteria_invalid':
      return failed('the filter the AI wrote does not work. Try rewording it.')
    case 'cannot_read':
      return failed('Rolepay could not read Discord just now. Try again.')
    case 'ai_not_configured':
      return failed('AI is not set up on this Rolepay server (no Anthropic API key).')
    case 'ai_disabled':
      return failed('AI proposals are off in this community. A treasurer turns them on with /rolepay setup ai_proposals:true.')
    case 'invalid_input':
      return { code: e.code, message: 'Some of the values were not valid.' }
    default:
      return actionError(e)
  }
}

const done = (r: Result<unknown, { code: string }>): Result<void, PolicyError> => (r.ok ? ok(undefined) : err(actionError(r.error)))
const caller = (guildId: string, actor: PolicyActor) => ({ guildId, actor: actor.id, actorRoleIds: actor.roleIds })

function originOf(policy: Policy, pr: PolicyRun): RunOrigin {
  return {
    policyId: policy.id,
    policyRunId: pr.id,
    policyName: policy.name,
    version: pr.policyVersion,
    period: `${utc(pr.periodStart)} to ${utc(pr.periodEnd)}`,
    mode: pr.mode,
    scheduledFor: pr.periodEnd,
    executesAt: pr.executeAfter,
    vetoedBy: pr.vetoedBy,
    vetoedAt: pr.vetoedAt,
    executedAt: pr.releasedAt,
    vetoable: pr.status === 'scheduled',
  }
}

/** The dashboard's PolicyPort over `rolepay.policies`. */
export function policyPortFromCore(rolepay: Rolepay, opts: { names?: NameSource } = {}): PolicyPort {
  const policies = rolepay.policies
  const names = (guildId: string) => namesFor(rolepay, guildId, opts.names)

  return {
    async list({ guildId }): Promise<PolicySummary[]> {
      return (await policies.list({ guildId })).map(({ policy: p, nextRunAt }) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        mode: p.mode,
        schedule: toPortSchedule(p.schedule),
        version: p.version,
        nextRunAt,
        // Knowing it means reading Discord: the policy's own page works it out.
        matchesNow: null,
      }))
    },

    async get(ref) {
      const d = await policies.detail({ ...ref, runs: 1 })
      if (!d.ok) return err({ code: d.error.code })
      return ok(detailOf(d.value.policy, d.value.nextRunAt, await names(ref.guildId)))
    },

    async preview(ref) {
      const [found, r] = await Promise.all([policies.get(ref), policies.preview(ref)])
      if (!found.ok) return err({ code: 'policy_not_found' })
      if (!r.ok) return err(previewError(r.error as { code: string }))
      const p = found.value
      const v = r.value
      const n = await names(ref.guildId)
      const criteria = p.compiled.criteria
      const cap = bindingCap(p)
      const nearMisses: PolicyNearMiss[] = v.nearMisses.map((m) => ({
        userId: m.userId,
        metrics: { [COUNT_METRIC[m.condition as keyof typeof COUNT_METRIC] ?? m.condition]: m.count },
        missing: `${m.min - m.count} short of the minimum: ${describeMatch(criteria, [{ condition: m.condition as keyof typeof COUNT_METRIC, count: m.count, min: m.min }], n)}`,
      }))
      const preview: PolicyPreview = {
        asOf: v.window.end,
        window: { since: v.window.start, until: v.window.end },
        matches: v.matches.map((m) => ({
          userId: m.discordUserId,
          metrics: metricsOf(m.metrics),
          reasons: [...m.reasons.map((reason) => describeMatch(criteria, [reason], n)), ...(m.capped && cap !== null ? [`capped at ${n.money(cap)}`] : [])],
          amount: m.amount,
          registered: m.registered,
        })),
        nearMisses,
        nextRunAt: v.nextRunAt,
        total: v.total,
        remainingBudget: v.remaining,
        held: heldWords(v.problems, { total: v.total, remaining: v.remaining, caps: p.caps }, n.money),
      }
      return ok(preview)
    },

    async versions(ref) {
      const d = await policies.detail({ ...ref, runs: 1 })
      if (!d.ok) return []
      const n = await names(ref.guildId)
      const p = d.value.policy
      return d.value.versions.map((v) => ({
        version: v.version,
        instruction: v.instruction,
        ruleInWords: ruleWords(v.compiled, v, n),
        filter: jsonSafe(v.compiled),
        createdBy: v.authoredBy,
        createdAt: v.authoredAt,
        approvedBy: v.approvedBy,
        approvedAt: v.approvedAt,
        status: versionStatus(v, p, d.value.versions),
      }))
    },

    async upcoming({ guildId, limit }) {
      return (await policies.nextRuns({ guildId, limit })).map((r) => ({ policyId: r.policyId, policyName: r.name, at: r.at, mode: r.mode }))
    },

    async runOrigins({ guildId, runIds }) {
      const out: Record<string, RunOrigin> = {}
      for (const runId of new Set(runIds)) {
        const found = await policies.runFor({ guildId, runId })
        if (found) out[runId] = originOf(found.policy, found.policyRun)
      }
      return out
    },

    async create({ guildId, actor, draft }) {
      const r = await policies.create({ ...caller(guildId, actor), name: draft.name, instruction: draft.instruction, schedule: toCoreSchedule(draft.schedule), channelId: null })
      return r.ok ? ok({ policyId: r.value.id }) : err(compileError(r.error as { code: string }))
    },

    async edit({ guildId, policyId, actor, draft }) {
      const current = await policies.get({ guildId, policyId })
      if (!current.ok) return err({ code: 'policy_not_found' })
      // Only a new instruction is compiled again (one model call); a new name or schedule is not.
      const instruction = draft.instruction.trim() === current.value.instruction.trim() ? {} : { instruction: draft.instruction }
      const r = await policies.edit({ ...caller(guildId, actor), policyId, name: draft.name, schedule: toCoreSchedule(draft.schedule), ...instruction })
      return r.ok ? ok({ version: r.value.version }) : err(compileError(r.error as { code: string }))
    },

    async approve({ guildId, policyId, actor, version }) {
      return done(await policies.approve({ ...caller(guildId, actor), policyId, version }))
    },

    async discard({ guildId, policyId, actor, version }) {
      // Core drops the version waiting now; the page names the one it showed, so check they match.
      const current = await policies.get({ guildId, policyId })
      if (current.ok && current.value.version !== version) return err({ code: current.value.status === 'draft' ? 'version_mismatch' : 'illegal_state' })
      return done(await policies.discard({ ...caller(guildId, actor), policyId }))
    },

    async pause({ guildId, policyId, actor }) {
      return done(await policies.pause({ ...caller(guildId, actor), policyId }))
    },

    async resume({ guildId, policyId, actor }) {
      return done(await policies.resume({ ...caller(guildId, actor), policyId }))
    },

    async archive({ guildId, policyId, actor }) {
      return done(await policies.archive({ ...caller(guildId, actor), policyId }))
    },

    async setMode({ guildId, policyId, actor, mode, vetoWindowMinutes }) {
      return done(await policies.setMode({ ...caller(guildId, actor), policyId, mode, vetoWindowMinutes }))
    },

    async veto({ guildId, runId, actor }) {
      const found = await policies.runFor({ guildId, runId })
      if (!found) return err({ code: 'policy_run_not_found' })
      return done(await policies.veto({ ...caller(guildId, actor), policyRunId: found.policyRun.id }))
    },
  }
}

// ---- the audit stream --------------------------------------------------------------------

const HOLD_WORDS: Record<string, string> = {
  over_budget: 'more than the bot key has left',
  over_policy_cap: "over the policy's cap per run",
  too_many_lines: 'more people than one run can pay',
  no_active_key: 'no active bot key',
  key_revoked: 'the bot key was revoked',
  key_expired: 'the bot key has expired',
  insufficient_limit: 'more than the bot key has left',
  policy_not_active: 'the policy is not active',
  autopilot_off: 'autopilot was switched off',
  policy_changed: 'the policy changed since the run was made',
  approver_changed: 'the treasurer who switched on autopilot no longer holds the approver role',
  creator_cannot_approve: 'a second person must approve it',
  cannot_read: 'Discord could not be read',
}

const OUTCOME_WORDS: Record<string, string> = { paid: 'paid', pending: 'payment in progress', failed: 'the payment failed' }

/** One audit event in plain words. Details are codes, amounts, counts and IDs: no one's words reach here. */
export function auditSummary(e: AuditEvent, symbol: string): string {
  const d = e.details
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : Number(d[k] ?? 0))
  const amount = (k: string) => (typeof d[k] === 'string' ? `${d[k]} ${symbol}` : `? ${symbol}`)
  const version = e.policyVersion ?? '?'
  switch (e.type satisfies AuditEventType) {
    case 'policy.created':
      return `Wrote the policy as a draft (version ${version}).`
    case 'policy.compiled':
      return `Compiled the instruction once into a rule${d.amountsInInstruction === false ? '; it uses an amount the instruction does not state, so it cannot be approved' : ''}.`
    case 'policy.edited':
      return `Edited it: version ${version} waits for approval${d.recompiled ? ' (compiled again from a new instruction)' : ''}${d.autopilotOff ? '; autopilot is off' : ''}.`
    case 'policy.approved':
      return `Approved version ${version}.`
    case 'policy.discarded':
      return `Discarded version ${num('discarded')}${d.restored ? `; back to version ${num('restored')}, paused` : '; the policy is archived'}.`
    case 'policy.paused':
      return 'Paused it: no runs until it is resumed.'
    case 'policy.resumed':
      return 'Resumed it.'
    case 'policy.archived':
      return 'Archived it: it will not run again.'
    case 'policy.mode_changed':
      return d.to === 'autopilot' ? `Switched on autopilot: each run pays after a veto window of ${vetoWords(num('vetoWindowMinutes'))} unless vetoed.` : 'Switched to propose: each run waits for approval.'
    case 'policy_run.generated': {
      const unregistered = num('unregistered')
      const when = typeof d.executeAfter === 'string' ? `, pays at ${utc(new Date(d.executeAfter))} unless vetoed` : ', waiting for approval'
      return `Made the period's run: ${amount('total')} for ${people(num('lines'))}${when}${unregistered ? `; ${notRegistered(unregistered)}` : ''}.`
    }
    case 'policy_run.held':
      return `Held the run whole: ${HOLD_WORDS[String(d.code)] ?? String(d.code)}${typeof d.total === 'string' ? ` (${amount('total')}${typeof d.limit === 'string' ? ` against ${amount('limit')}` : ''})` : ''}.`
    case 'policy_run.empty':
      return `Nobody to pay this period${num('unregistered') ? `; ${notRegistered(num('unregistered'))}` : ''}.`
    case 'policy_run.vetoed':
      return `Vetoed the run of ${amount('total')} for ${people(num('lines'))}: nothing is paid.`
    case 'policy_run.released':
      return `Released the run after its veto window: ${OUTCOME_WORDS[String(d.outcome)] ?? String(d.outcome)}.`
    case 'policy_run.cancelled':
      return 'The run was cancelled during its veto window.'
    case 'run.created':
      return `Created a run of ${amount('total')} for ${people(num('lines'))}.`
    case 'run.submitted':
      return 'Submitted the run for approval.'
    case 'run.approved':
      return `Approved the run of ${amount('total')}.`
    case 'run.cancelled':
      return 'Cancelled the run.'
    case 'run.executing':
      return `Started paying (attempt ${num('attempt')}).`
    case 'run.paid':
      return `Paid ${amount('total')} to ${people(num('lines'))}.`
    case 'run.failed':
      return `The payment failed (${String(d.reason)})${d.retryable ? '; it can be retried' : ''}.`
  }
}

/** The dashboard's AuditPort over `rolepay.audit`. */
export function auditPortFromCore(rolepay: Rolepay): AuditPort {
  const types: readonly string[] = AUDIT_EVENT_TYPES
  return {
    eventTypes: AUDIT_EVENT_TYPES,
    async events(q): Promise<AuditEventView[]> {
      // The cursor is the stream's sequence number; anything else, and any unknown type, matches nothing.
      if (q.beforeId !== undefined && !/^[1-9]\d{0,14}$/.test(q.beforeId)) return []
      if (q.type !== undefined && !types.includes(q.type)) return []
      const r = await rolepay.audit.list({
        guildId: q.guildId,
        types: q.type ? [q.type as AuditEventType] : [],
        actor: q.actorId ?? null,
        policyId: q.policyId ?? null,
        before: q.beforeId ? Number(q.beforeId) : null,
        limit: Math.min(500, Math.max(1, q.limit)),
      })
      if (!r.ok) return []
      const symbol = await symbolOf(rolepay, q.guildId)
      return r.value.events.map((e) => ({ id: String(e.seq), at: e.at, type: e.type, actorId: e.actor, policyId: e.policyId, runId: e.runId, summary: auditSummary(e, symbol) }))
    },
  }
}
