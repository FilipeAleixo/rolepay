import type { Community } from '@payrun/core'
import { type ButtonHandler, type GuildContext, replyError } from '../app/handlers.js'
import { type Outcome, ephemeralReply } from '../app/outcome.js'
import { canManageGuild, holdsApproverRole } from '../app/permissions.js'
import type { ExecutionJob } from '../ports.js'
import { roleMention } from '../views/format.js'
import { runMessage } from '../views/run.js'

const executeJob = (ctx: GuildContext, runId: string): ExecutionJob => ({
  kind: 'execute_run',
  guildId: ctx.guildId,
  runId,
  reply: { applicationId: ctx.applicationId, token: ctx.token },
  channelId: ctx.channelId,
})

/** The Treasurer check, from the roles Discord signed into the interaction. */
function refuseUnlessApprover(ctx: GuildContext, community: Community): Outcome | null {
  if (!community.approverRoleId) {
    return ephemeralReply('No approver role is set, so nobody can approve yet. An admin runs `/payrun setup approver_role:@Treasurer`.')
  }
  if (!holdsApproverRole(ctx.caller, community)) return ephemeralReply(`Only members with ${roleMention(community.approverRoleId)} can approve or retry pay runs.`)
  return null
}

/**
 * Approve: the approver role only. Approves in core (asserting the role check passed),
 * queues the payment and immediately turns the review into "paying" with no buttons, so
 * nobody can click twice. The queued job edits this message with the result.
 */
export const approveButton: ButtonHandler = async ({ runId, ctx }, { payrun, queue, config }) => {
  const community = await payrun.communities.get(ctx.guildId)
  if (!community.ok) return replyError(community.error)
  const refused = refuseUnlessApprover(ctx, community.value)
  if (refused) return refused
  const approved = await payrun.payRuns.approve({ guildId: ctx.guildId, runId, actor: ctx.caller.userId, actorCanApprove: true })
  if (!approved.ok) return replyError(approved.error)
  await queue.enqueue(executeJob(ctx, runId))
  return { kind: 'update', message: runMessage(approved.value, { network: config.network }) }
}

/** Cancel: the run's creator, an admin or an approver, while the run has not started paying. */
export const cancelButton: ButtonHandler = async ({ runId, ctx }, { payrun, config }) => {
  const community = await payrun.communities.get(ctx.guildId)
  if (!community.ok) return replyError(community.error)
  const run = await payrun.payRuns.get({ guildId: ctx.guildId, runId })
  if (!run.ok) return replyError(run.error)
  const allowed = run.value.createdBy === ctx.caller.userId || canManageGuild(ctx.caller) || holdsApproverRole(ctx.caller, community.value)
  if (!allowed) return ephemeralReply('Only the person who created this run, an admin or an approver can cancel it.')
  const cancelled = await payrun.payRuns.cancel({ guildId: ctx.guildId, runId, actor: ctx.caller.userId })
  if (!cancelled.ok) return replyError(cancelled.error)
  return { kind: 'update', message: runMessage(cancelled.value, { network: config.network }) }
}

/**
 * Retry: the approver role only, for an approved run that has not been paid (a pre-flight
 * failure, or a restart lost the job) or a failure core marks retryable. Core re-checks
 * the chain for this run's memos before any new attempt.
 */
export const retryButton: ButtonHandler = async ({ runId, ctx }, { payrun, queue, config }) => {
  const community = await payrun.communities.get(ctx.guildId)
  if (!community.ok) return replyError(community.error)
  const refused = refuseUnlessApprover(ctx, community.value)
  if (refused) return refused
  const run = await payrun.payRuns.get({ guildId: ctx.guildId, runId })
  if (!run.ok) return replyError(run.error)
  const r = run.value
  if (r.status === 'paid') return ephemeralReply('This run is already paid.')
  const retryable = r.status === 'approved' || r.status === 'executing' || (r.status === 'failed' && r.failure?.retryable)
  if (!retryable) return replyError(r.status === 'failed' ? { code: 'not_retryable' } : { code: 'illegal_state', status: r.status })
  await queue.enqueue(executeJob(ctx, runId))
  return { kind: 'update', message: runMessage(r, { network: config.network, paying: true }) }
}
