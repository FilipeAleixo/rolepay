import { type Community, type Rolepay, parseLooseAmount } from '@rolepay/core'
import type { GuildContext, MessageCommandHandler, ModalHandler, UserCommandHandler } from '../app/handlers.js'
import { type Outcome, ephemeralReply } from '../app/outcome.js'
import { answerForNewRun } from '../app/treasury.js'
import { type PayTarget, decodePayModalId } from '../components/customId.js'
import { explainError } from '../views/errors.js'
import { PAY_REFUSED, amountRefused, noteWithLink, payModal } from '../views/pay.js'
import { messageLink } from '../views/proposal.js'
import { runMessage } from '../views/run.js'
import { requireOperator } from './guards.js'

/** The message command's name, as registered (right-click a message > Apps > Pay the author). */
export const PAY_AUTHOR_COMMAND = 'Pay the author'
/** The user command's name, as registered (right-click a member > Apps > Pay with Rolepay). */
export const PAY_MEMBER_COMMAND = 'Pay with Rolepay'

const ACTION = 'Creating a pay run'

/**
 * Who may be paid this way, checked when the form opens and again when it is sent: not the caller
 * themselves when the server requires a separate approver (four eyes), and only a registered payee.
 */
async function refusal(rolepay: Rolepay, ctx: GuildContext, community: Community, userId: string): Promise<Outcome | null> {
  if (userId === ctx.caller.userId && community.requireSeparateApprover) return ephemeralReply(PAY_REFUSED.self)
  const payee = await rolepay.payees.get({ guildId: ctx.guildId, discordUserId: userId })
  return payee.ok ? null : ephemeralReply(PAY_REFUSED.unregistered(userId))
}

/**
 * Right-click a message > Apps > Pay the author: pay the person who wrote it. The same people who
 * may create runs (/rolepay new) get a form for the amount and a note; nothing is created before
 * it is sent. The message itself is not kept: only who wrote it and where, in the form's ID.
 */
export const payAuthorCommand: MessageCommandHandler = async ({ target, ctx }, { rolepay }) => {
  const guard = await requireOperator(ctx, rolepay, ACTION)
  if (!guard.ok) return guard.reply
  if (target.authorIsBot) return ephemeralReply(PAY_REFUSED.bot)
  const refused = await refusal(rolepay, ctx, guard.community, target.authorId)
  if (refused) return refused
  const link = messageLink(ctx.guildId, target.channelId, target.id)
  return { kind: 'modal', modal: payModal({ kind: 'author', userId: target.authorId, channelId: target.channelId, messageId: target.id }, { token: guard.community.payoutToken, link }) }
}

/** Right-click a member > Apps > Pay with Rolepay: the same form and the same rules, with no message to link. */
export const payMemberCommand: UserCommandHandler = async ({ target, ctx }, { rolepay }) => {
  const guard = await requireOperator(ctx, rolepay, ACTION)
  if (!guard.ok) return guard.reply
  if (target.isBot) return ephemeralReply(PAY_REFUSED.botMember)
  const refused = await refusal(rolepay, ctx, guard.community, target.userId)
  if (refused) return refused
  return { kind: 'modal', modal: payModal({ kind: 'member', userId: target.userId }, { token: guard.community.payoutToken }) }
}

/**
 * The form sent: a one-line run for that person, created and submitted like /rolepay new, and its
 * review posted publicly for the Treasurer to approve (approval unchanged; with a treasury channel,
 * there, as for /rolepay new). The link to the message
 * goes into the run's note. Every rule is checked again here, from this interaction.
 */
export const payModalSubmit: ModalHandler = async ({ id, fields, ctx }, deps) => {
  const { rolepay, config } = deps
  const target = decodePayModalId(id)
  if (!target) return ephemeralReply('Sorry, I do not know that form. It may be from an older version.')
  const guard = await requireOperator(ctx, rolepay, ACTION)
  if (!guard.ok) return guard.reply
  const community = guard.community
  const refused = await refusal(rolepay, ctx, community, target.userId)
  if (refused) return refused
  const typed = fields.amount ?? ''
  const amount = parseLooseAmount(typed)
  if (!amount.ok) return ephemeralReply(amountRefused(typed, amount.error))

  const caller = ctx.caller.userId
  const created = await rolepay.payRuns.create({ guildId: ctx.guildId, createdBy: caller, note: noteFor(target, fields.note ?? '', ctx.guildId), lines: [{ discordUserId: target.userId, amount: amount.value }] })
  if (!created.ok) return ephemeralReply(explainError(created.error, { token: community.payoutToken }))
  const submitted = await rolepay.payRuns.submit({ guildId: ctx.guildId, runId: created.value.id, actor: caller })
  if (!submitted.ok) return ephemeralReply(explainError(submitted.error))
  const view = (mirror: boolean) => runMessage(submitted.value, { network: config.network, approverRoleId: community.approverRoleId, mirror })
  const answer = await answerForNewRun(deps, { community, runId: submitted.value.id, view, channelId: ctx.channelId })
  return { kind: 'reply', ephemeral: answer.privately, message: answer.message }
}

/** What was typed; for an author, followed by the link to their message. */
const noteFor = (target: PayTarget, typed: string, guildId: string) =>
  target.kind === 'author' ? noteWithLink(typed, messageLink(guildId, target.channelId, target.messageId)) : typed.trim() || null
