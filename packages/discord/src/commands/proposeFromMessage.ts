import type { MessageCommandHandler } from '../app/handlers.js'
import { ephemeralReply } from '../app/outcome.js'
import { instructionModal } from '../views/proposal.js'
import { requireProposer } from './guards.js'

/** The message command's name, as registered (Apps > Propose pay run). */
export const PROPOSE_MESSAGE_COMMAND = 'Propose pay run'

/**
 * Right-click a message > Apps > Propose pay run: asks for the instruction in a modal. The message
 * arrives with this interaction, text included, so this path needs no Message Content intent. It
 * is kept until the modal is submitted (Discord does not send it again), at most 15 minutes.
 */
export const proposeFromMessageCommand: MessageCommandHandler = async ({ target, ctx }, { rolepay, pendingSources }) => {
  const guard = await requireProposer(ctx, rolepay, { ai: true })
  if (!guard.ok) return guard.reply
  if (!target.content.trim()) return ephemeralReply('That message has no text to read (only an image or an embed). Pick the message that names the people.')
  await pendingSources.put({ userId: ctx.caller.userId, messageId: target.id }, target)
  return { kind: 'modal', modal: instructionModal(target.id) }
}
