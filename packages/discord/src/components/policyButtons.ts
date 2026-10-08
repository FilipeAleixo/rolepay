import { nextOccurrence } from '@rolepay/core'
import type { PolicyButtonHandler, VetoButtonHandler } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { mirrorOf, policyMirrorsOf } from '../app/treasury.js'
import { policyBudgetLink, requirePolicyApprover } from '../commands/policy.js'
import { explainPolicyError } from '../views/errors.js'
import { policyBudgetOffer, policyDiscardedMessage, policyMessage } from '../views/policy.js'
import { runMessage } from '../views/run.js'

/**
 * Approve policy: the approver role, for the version the preview showed. The preview turns into the
 * active policy, and the approver alone is offered the policy's own budget (a private follow-up with
 * the treasury page link), unless it has one already. With a treasury channel, the preview's copy
 * where it was written (and its message there, if this was pressed elsewhere) shows the approval too.
 */
export const approvePolicyButton: PolicyButtonHandler = async ({ policyId, version, messageId, ctx }, deps) => {
  const { rolepay, clock, notices } = deps
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const r = await rolepay.policies.approve({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyId, version })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
  const c = guard.community
  const policy = r.value
  const nextRunAt = nextOccurrence(policy.schedule, clock.now())
  const view = (mirror: boolean) => policyMessage(policy, { token: c.payoutToken, approverRoleId: c.approverRoleId, nextRunAt, mirror })
  return { kind: 'update', message: view(false), ...((await budgetOffer()) ?? {}), ...(await policyMirrorsOf(notices, { policyId, version, messageId, settled: false }, view)) }

  /** The offer is a courtesy: if the chain or the database does not answer, the approval stands and no offer is sent. */
  async function budgetOffer() {
    try {
      const budget = await rolepay.policyKeys.status({ guildId: ctx.guildId, policyId })
      const link = budget.ok && budget.value.signs === 'own' ? null : await policyBudgetLink(deps, c, ctx, policyId)
      return link ? { followUp: policyBudgetOffer(policy, link) } : null
    } catch (e) {
      deps.onError?.(e)
      return null
    }
  }
}

/**
 * Discard: the author of the draft or an approver (core decides; an edit goes back to the approved
 * version, paused). With a treasury channel, the preview's other messages say it was discarded too.
 */
export const discardPolicyButton: PolicyButtonHandler = async ({ policyId, version, messageId, ctx }, { rolepay, notices }) => {
  const r = await rolepay.policies.discard({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyId })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error))
  const message = policyDiscardedMessage(r.value, ctx.caller.userId)
  return { kind: 'update', message, ...(await policyMirrorsOf(notices, { policyId, version, messageId, settled: true }, () => message)) }
}

/** Veto an autopilot run during its window: the approver role. The run is cancelled; the message says who vetoed it. */
export const vetoButton: VetoButtonHandler = async ({ policyRunId, ctx }, { rolepay, config, notices }) => {
  const guard = await requirePolicyApprover(ctx, rolepay)
  if (!guard.ok) return guard.reply
  const r = await rolepay.policies.veto({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, policyRunId })
  if (!r.ok) return ephemeralReply(explainPolicyError(r.error, { community: guard.community }))
  const { policyRun: pr, run } = r.value
  if (!run) return { kind: 'update', message: { content: `Vetoed by <@${ctx.caller.userId}>. Nothing was paid.`, components: [] } }
  const policy = await rolepay.policies.get({ guildId: ctx.guildId, policyId: pr.policyId })
  const view = {
    network: config.network,
    approverRoleId: guard.community.approverRoleId,
    ...(policy.ok ? { policy: { name: policy.value.name, version: pr.policyVersion, periodStart: pr.periodStart, periodEnd: pr.periodEnd } } : {}),
    autopilot: { policyRunId: pr.id, executeAfter: pr.executeAfter ?? pr.updatedAt, vetoedBy: pr.vetoedBy },
  }
  // Pressed in the treasury channel: the run's copy in the policy's channel says it was vetoed too.
  return { kind: 'update', message: runMessage(run, view), ...(await mirrorOf(notices, run.id, runMessage(run, { ...view, mirror: true }))) }
}
