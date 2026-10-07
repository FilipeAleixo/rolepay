import { nextOccurrence } from '@rolepay/core'
import type { PolicyButtonHandler, VetoButtonHandler } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { policyBudgetLink, requirePolicyApprover } from '../commands/policy.js'
import { explainPolicyError } from '../views/errors.js'
import { policyBudgetOffer, policyDiscardedMessage, policyMessage } from '../views/policy.js'
import { runMessage } from '../views/run.js'

/**
 * Approve policy: the approver role, for the version the preview showed. The preview turns into the
 * active policy, and the approver alone is offered the policy's own budget (a private follow-up with
 * the treasury page link), unless it has one already.
 */
export const approvePolicyButton: PolicyButtonHandler = async ({ policyId, version, ctx }, deps) => {
  const { rolepay, clock } = deps
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const r = await rolepay.policies.approve({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyId, version })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
  const c = guard.community
  const message = policyMessage(r.value, { token: c.payoutToken, approverRoleId: c.approverRoleId, nextRunAt: nextOccurrence(r.value.schedule, clock.now()) })
  const budget = await rolepay.policyKeys.status({ guildId: ctx.guildId, policyId })
  const link = budget.ok && budget.value.signs === 'own' ? null : await policyBudgetLink(deps, c, ctx, policyId)
  return { kind: 'update', message, ...(link ? { followUp: policyBudgetOffer(r.value, link) } : {}) }
}

/** Discard: the author of the draft or an approver (core decides; an edit goes back to the approved version, paused). */
export const discardPolicyButton: PolicyButtonHandler = async ({ policyId, ctx }, { rolepay }) => {
  const r = await rolepay.policies.discard({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyId })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error))
  return { kind: 'update', message: policyDiscardedMessage(r.value, ctx.caller.userId) }
}

/** Veto an autopilot run during its window: the approver role. The run is cancelled; the message says who vetoed it. */
export const vetoButton: VetoButtonHandler = async ({ policyRunId, ctx }, { rolepay, config }) => {
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const r = await rolepay.policies.veto({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyRunId })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
  const { policyRun: pr, run } = r.value
  if (!run) return { kind: 'update', message: { content: `Vetoed by <@${ctx.caller.userId}>. Nothing was paid.`, components: [] } }
  const policy = await rolepay.policies.get({ guildId: ctx.guildId, policyId: pr.policyId })
  return {
    kind: 'update',
    message: runMessage(run, {
      network: config.network,
      approverRoleId: guard.community.approverRoleId,
      ...(policy.ok ? { policy: { name: policy.value.name, version: pr.policyVersion, periodStart: pr.periodStart, periodEnd: pr.periodEnd } } : {}),
      autopilot: { policyRunId: pr.id, executeAfter: pr.executeAfter ?? pr.updatedAt, vetoedBy: pr.vetoedBy },
    }),
  }
}
