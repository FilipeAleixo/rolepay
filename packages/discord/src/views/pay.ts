import { MAX_NOTE_LENGTH, type ParseAmountError } from '@rolepay/core'
import { ComponentType, type Modal, TextInputStyle } from '../api.js'
import { type PayTarget, encodePayModalId } from '../components/customId.js'
import { mention, tokenLabel } from './format.js'

/**
 * A direct payment to one person (Apps > Pay the author on a message, Apps > Pay with Rolepay on a
 * member): a form for the amount and a note, then a one-line run that goes to the Treasurer like any
 * other. The link to a message is kept in the run's note (the run has no other place for it), so the
 * form's note leaves room for it.
 */

/** What the note becomes on the run: what was typed, then the link to the message it pays for. */
export const noteWithLink = (typed: string, link: string, max = MAX_NOTE_LENGTH) => {
  const room = max - ` (${link})`.length
  const note = typed.trim().slice(0, room).trim()
  return note ? `${note} (${link})` : link
}

/** `link`: the message an author is paid for (Pay the author); none for a member. */
export function payModal(target: PayTarget, ctx: { token: string; link?: string }): Modal {
  const link = ctx.link
  return {
    custom_id: encodePayModalId(target),
    title: link ? 'Pay the author of this message' : 'Pay this member',
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.TextInput, custom_id: 'amount', label: `Amount in ${tokenLabel(ctx.token)}`.slice(0, 45), style: TextInputStyle.Short, min_length: 1, max_length: 30, required: true, placeholder: 'For example 25 or 12.50' },
        ],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: 'note',
            label: 'Note (on the receipt and in the CSV)',
            style: TextInputStyle.Short,
            max_length: link ? MAX_NOTE_LENGTH - ` (${link})`.length : MAX_NOTE_LENGTH,
            required: false,
            ...(link ? { value: 'For this message' } : { placeholder: 'What this payment is for' }),
          },
        ],
      },
    ],
  }
}

export const PAY_REFUSED = {
  bot: 'That message was written by a bot or a webhook, and Rolepay pays people. Pick a message a member wrote.',
  botMember: 'That is a bot, and Rolepay pays people. Pick a member.',
  self: 'This server requires a separate approver (`separate_approver`), so you cannot create a run that pays you. Ask another member with Manage Server or the approver role to pay you.',
  unregistered: (userId: string) =>
    `${mention(userId)} is not a registered payee yet, so Rolepay cannot pay them. They run \`/payee link\` first to register the account they are paid at, then you can pay them.`,
} as const

/** An amount typed in the form that is not one, in plain words. */
export function amountRefused(typed: string, error: ParseAmountError): string {
  const t = typed.trim()
  if (!t) return 'Say how much to pay, for example 25 or 12.50.'
  if (error.code === 'not_positive') return 'The amount must be more than 0.'
  if (error.code === 'too_many_decimals') return `"${t.slice(0, 40)}" has more than 6 decimals.`
  return `"${t.slice(0, 40)}" is not an amount. Write digits and a dot, for example 25 or 12.50.`
}
