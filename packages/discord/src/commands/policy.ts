import { type Community, POLICY_LIMITS, PROPOSAL_LIMITS, type Rolepay, type Schedule, WEEKDAYS, canPropose, isTimezone, parseAmount, quietWhenEmpty } from '@rolepay/core'
import { z } from 'zod'
import { demoControlsOn } from '../app/deps.js'
import { type AutocompleteHandler, type CommandHandler, type GuildContext, parseOptions, replyError } from '../app/handlers.js'
import { type DeferredResult, type Outcome, ephemeralReply } from '../app/outcome.js'
import { canOperate, holdsApproverRole } from '../app/permissions.js'
import { explainPolicyError } from '../views/errors.js'
import { roleMention } from '../views/format.js'
import { policyChangedMessage, policyListMessage, policyMessage } from '../views/policy.js'
import { requireProposer } from './guards.js'

const amount = z
  .string()
  .trim()
  .refine((s) => parseAmount(s).ok, 'write an amount such as 500 or 12.5')
  .transform((s) => {
    const r = parseAmount(s)
    return r.ok ? r.value : 0n
  })

const NewOptions = z.object({
  instruction: z.string().trim().min(1).max(PROPOSAL_LIMITS.maxInstructionLength),
  schedule: z.enum(['daily', 'weekly', 'monthly']),
  hour: z.number().int().min(0).max(23),
  weekday: z.enum(WEEKDAYS).optional(),
  day: z.number().int().min(1).max(31).optional(),
  timezone: z.string().trim().max(64).optional(),
  name: z.string().trim().min(1).max(POLICY_LIMITS.maxNameLength).optional(),
  max_per_run: amount.optional(),
  max_per_person: amount.optional(),
})
const PolicyOption = z.object({ policy: z.string().trim().min(1).max(40) })
const ModeOptions = PolicyOption.extend({
  mode: z.enum(['propose', 'autopilot']),
  veto_hours: z.number().int().min(1).max(POLICY_LIMITS.maxVetoMinutes / 60).optional(),
  veto_minutes: z.number().int().min(1).max(POLICY_LIMITS.maxVetoMinutes).optional(),
})

const DEMO_ONLY = (what: string) => `${what} is a demo control (ROLEPAY_DEMO_CONTROLS=true on Moderato); it is off on this server.`

/** Who may read policies here: admins and treasurers (as for runs), and the proposer role (it writes them). */
async function requireReader(ctx: GuildContext, rolepay: Rolepay): Promise<{ ok: true; community: Community } | { ok: false; reply: Outcome }> {
  const community = await rolepay.communities.get(ctx.guildId)
  if (!community.ok) return { ok: false, reply: replyError(community.error) }
  if (!canOperate(ctx.caller, community.value) && !canPropose(community.value, ctx.caller.roles)) {
    return { ok: false, reply: ephemeralReply('Reading policies needs Manage Server, the approver role or the proposer role.') }
  }
  return { ok: true, community: community.value }
}

/** The approver role, from the roles Discord signed into this interaction (core checks again). */
export async function requirePolicyApprover(ctx: GuildContext, rolepay: Rolepay): Promise<{ ok: true; community: Community } | { ok: false; reply: Outcome }> {
  const community = await rolepay.communities.get(ctx.guildId)
  if (!community.ok) return { ok: false, reply: replyError(community.error) }
  const c = community.value
  if (!c.approverRoleId) return { ok: false, reply: ephemeralReply('No approver role is set, so nobody can govern policies yet. An admin runs `/rolepay setup approver_role:@Treasurer`.') }
  if (!holdsApproverRole(ctx.caller, c)) return { ok: false, reply: ephemeralReply(`Only members with ${roleMention(c.approverRoleId)} can approve, pause, resume, switch modes or veto policies.`) }
  return { ok: true, community: c }
}

const actorOf = (ctx: GuildContext) => ({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles })
const view = (c: Community) => ({ token: c.payoutToken, approverRoleId: c.approverRoleId })

/**
 * /rolepay policy new: the AI compiles the instruction once (criteria mode), and the preview is
 * posted publicly in the channel (where the policy's runs will be posted too), so a treasurer can
 * approve it: the rule in plain words, who it applies to right now, the next run against the budget.
 */
export const policyNewCommand: CommandHandler = async ({ options, ctx }, { rolepay, config }) => {
  const guard = await requireProposer(ctx, rolepay, { ai: true })
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(NewOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  // Daily runs are a demo control (the judge demo); core refuses them without the controls too.
  if (o.schedule === 'daily' && !demoControlsOn(config)) return ephemeralReply(DEMO_ONLY('A daily `schedule`'))
  if (o.schedule === 'weekly' && !o.weekday) return ephemeralReply('A weekly policy needs a `weekday`.')
  if (o.schedule === 'monthly' && !o.day) return ephemeralReply('A monthly policy needs a `day` of the month (1 to 31).')
  const timezone = o.timezone || 'UTC'
  if (!isTimezone(timezone)) return ephemeralReply('That `timezone` is not one Rolepay knows: use an IANA name such as Europe/Lisbon, or UTC.')
  const schedule: Schedule =
    o.schedule === 'daily'
      ? { kind: 'daily', hour: o.hour, timezone }
      : o.schedule === 'weekly'
        ? { kind: 'weekly', weekday: o.weekday as (typeof WEEKDAYS)[number], hour: o.hour, timezone }
        : { kind: 'monthly', day: o.day as number, hour: o.hour, timezone }
  const community = guard.community
  return {
    kind: 'defer',
    ephemeral: false,
    work: async (): Promise<DeferredResult> => {
      const created = await rolepay.policies.create({
        ...actorOf(ctx),
        instruction: o.instruction,
        schedule,
        caps: { perRun: o.max_per_run ?? null, perPerson: o.max_per_person ?? null },
        channelId: ctx.channelId,
        ...(o.name ? { name: o.name } : {}),
      })
      if (!created.ok) return { ok: false, message: { content: explainPolicyError(created.error, { community, token: community.payoutToken }) } }
      const preview = await rolepay.policies.preview({ guildId: ctx.guildId, policyId: created.value.id })
      return {
        ok: true,
        message: policyMessage(created.value, { ...view(community), ...(preview.ok ? { preview: preview.value } : { previewProblem: explainPolicyError(preview.error, { community }) }) }),
      }
    },
  }
}

export const policyListCommand: CommandHandler = async ({ ctx }, { rolepay }) => {
  const guard = await requireReader(ctx, rolepay)
  if (!guard.ok) return guard.reply
  return { kind: 'reply', ephemeral: true, message: policyListMessage(await rolepay.policies.list({ guildId: ctx.guildId })) }
}

/** One policy, with who it applies to right now (deferred: it reads Discord and the chain). Only for the caller. */
export const policyShowCommand: CommandHandler = async ({ options, ctx }, { rolepay }) => {
  const guard = await requireReader(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(PolicyOption, options)
  if (!parsed.ok) return parsed.reply
  const community = guard.community
  return {
    kind: 'defer',
    ephemeral: true,
    work: async (): Promise<DeferredResult> => {
      const detail = await rolepay.policies.detail({ guildId: ctx.guildId, policyId: parsed.value.policy })
      if (!detail.ok) return { ok: false, message: { content: explainPolicyError(detail.error) } }
      const p = detail.value.policy
      if (p.status === 'archived') return { ok: true, message: policyMessage(p, view(community)) }
      const preview = await rolepay.policies.preview({ guildId: ctx.guildId, policyId: p.id })
      return {
        ok: true,
        message: policyMessage(p, { ...view(community), nextRunAt: detail.value.nextRunAt, ...(preview.ok ? { preview: preview.value } : { previewProblem: explainPolicyError(preview.error, { community }) }) }),
      }
    },
  }
}

const governance =
  (change: 'paused' | 'resumed'): CommandHandler =>
  async ({ options, ctx }, { rolepay }) => {
    const guard = await requirePolicyApprover(ctx, rolepay)
    if (!guard.ok) return guard.reply
    const parsed = parseOptions(PolicyOption, options)
    if (!parsed.ok) return parsed.reply
    const input = { ...actorOf(ctx), policyId: parsed.value.policy }
    const r = change === 'paused' ? await rolepay.policies.pause(input) : await rolepay.policies.resume(input)
    if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
    return { kind: 'reply', ephemeral: false, message: policyChangedMessage(r.value, change, ctx.caller.userId, view(guard.community)) }
  }

/** Pause and resume: the approver role, answered publicly so the channel sees the change. */
export const policyPauseCommand = governance('paused')
export const policyResumeCommand = governance('resumed')

/** Propose or autopilot, and the veto window: the approver role, answered publicly. */
export const policyModeCommand: CommandHandler = async ({ options, ctx }, { rolepay, config }) => {
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(ModeOptions, options)
  if (!parsed.ok) return parsed.reply
  const o = parsed.value
  if (o.veto_minutes !== undefined && !demoControlsOn(config)) return ephemeralReply(DEMO_ONLY('`veto_minutes`'))
  const minutes = o.veto_minutes ?? (o.veto_hours === undefined ? undefined : o.veto_hours * 60)
  const r = await rolepay.policies.setMode({ ...actorOf(ctx), policyId: o.policy, mode: o.mode, ...(minutes === undefined ? {} : { vetoWindowMinutes: minutes }) })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
  return { kind: 'reply', ephemeral: false, message: policyChangedMessage(r.value, 'mode', ctx.caller.userId, view(guard.community)) }
}

/**
 * Demo control (ROLEPAY_DEMO_CONTROLS on Moderato): make the policy's next run now ("time skips to
 * Monday"), and post it in the policy's channel like the scheduler would. The approver role only;
 * the scheduled tick later finds the period made.
 */
export const policyRunNowCommand: CommandHandler = async ({ options, ctx }, { rolepay, config, announcer }) => {
  if (!demoControlsOn(config)) return ephemeralReply(DEMO_ONLY('`/rolepay policy run_now`'))
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const parsed = parseOptions(PolicyOption, options)
  if (!parsed.ok) return parsed.reply
  return {
    kind: 'defer',
    ephemeral: true,
    work: async (): Promise<DeferredResult> => {
      const r = await rolepay.scheduler.runNow({ ...actorOf(ctx), policyId: parsed.value.policy })
      if (!r.ok) return { ok: false, message: { content: explainPolicyError(r.error, { community: guard.community }) } }
      await announcer?.announce([r.value])
      const { policy, policyRun } = r.value
      if (policyRun.status === 'empty') {
        const quiet = quietWhenEmpty(policy.schedule)
        const said = quiet ? ' Nothing was posted: a daily policy stays quiet on empty days (the audit log records them).' : policy.channelId ? ` A line in <#${policy.channelId}> says so.` : ''
        return { ok: true, message: { content: `Nobody matched for the next period, so no run was made.${said}` } }
      }
      const where = policy.channelId ? ` and posted it in <#${policy.channelId}>` : ' (this policy posts nowhere in Discord; the dashboard shows it)'
      return { ok: true, message: { content: `Made the next run of this policy now${where}.` } }
    },
  }
}

/** Autocomplete for `policy`: the server's policies by name, for people who may read them. */
export const policyChoices: AutocompleteHandler = async ({ options, ctx, focused }, { rolepay }) => {
  const guard = await requireReader(ctx, rolepay)
  if (!guard.ok || focused !== 'policy') return { kind: 'choices', choices: [] }
  const typed = String(options.policy ?? '').toLowerCase()
  const choices = (await rolepay.policies.list({ guildId: ctx.guildId }))
    .filter(({ policy: p }) => p.status !== 'archived' && (p.name.toLowerCase().includes(typed) || p.id.toLowerCase().includes(typed)))
    .slice(0, 25)
    .map(({ policy: p }) => ({ name: `${p.name} (${p.status})`.slice(0, 100), value: p.id }))
  return { kind: 'choices', choices }
}

