import { type ProposalButtonHandler, replyError } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { requireProposer } from '../commands/guards.js'
import { explainProposalError } from '../views/errors.js'
import { editModal, proposalCreatedMessage, proposalDiscardedMessage } from '../views/proposal.js'
import { runMessage } from '../views/run.js'

/**
 * Create pay run: the normal create and submit in core (claimed once per proposal). The proposal
 * turns into "created" for the caller, and the run's review is posted in the channel with Approve
 * and Cancel, exactly like one from /payrun new: the approval path is unchanged.
 */
export const createProposalRunButton: ProposalButtonHandler = async ({ proposalId, ctx }, { payrun, config }) => {
  const guard = await requireProposer(ctx, payrun, { ai: false })
  if (!guard.ok) return guard.reply
  const community = guard.community
  const created = await payrun.proposals.createRun({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, proposalId })
  if (!created.ok) return ephemeralReply(explainProposalError(created.error, { community, token: community.payoutToken }))
  return {
    kind: 'update',
    message: proposalCreatedMessage(created.value.proposal, created.value.run, { approverRoleId: community.approverRoleId }),
    followUp: runMessage(created.value.run, { network: config.network, approverRoleId: community.approverRoleId }),
  }
}

/** Edit: the lines as text in a modal (`@user=amount`), prefilled; held people as comments. */
export const editProposalButton: ProposalButtonHandler = async ({ proposalId, ctx }, { payrun }) => {
  const guard = await requireProposer(ctx, payrun, { ai: false })
  if (!guard.ok) return guard.reply
  const p = await payrun.proposals.get({ guildId: ctx.guildId, proposalId })
  if (!p.ok) return replyError(p.error)
  if (p.value.status !== 'open') return ephemeralReply(explainProposalError({ code: 'proposal_closed', status: p.value.status }))
  return { kind: 'modal', modal: editModal(p.value) }
}

export const discardProposalButton: ProposalButtonHandler = async ({ proposalId, ctx }, { payrun }) => {
  const guard = await requireProposer(ctx, payrun, { ai: false })
  if (!guard.ok) return guard.reply
  const discarded = await payrun.proposals.discard({ guildId: ctx.guildId, actor: ctx.caller.userId, actorRoleIds: ctx.caller.roles, proposalId })
  if (!discarded.ok) return ephemeralReply(explainProposalError(discarded.error, { community: guard.community }))
  return { kind: 'update', message: proposalDiscardedMessage(discarded.value) }
}
