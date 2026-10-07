import { z } from 'zod'
import type { CommandHandler } from '../app/handlers.js'
import { parseOptions, replyError } from '../app/handlers.js'
import { payeePreferMessage } from '../views/payee.js'

/** `default` (the server's payout token) or a token address; core checks the address against what the community can deliver. */
const Options = z.object({ token: z.union([z.literal('default'), z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'choose a stablecoin from the list')]) })

/**
 * /payee prefer token: the caller chooses the USD stablecoin they are paid in, for this server. Only
 * their own registration, from the signed interaction: it never changes where they are paid.
 */
export const payeePreferCommand: CommandHandler = async ({ options, ctx }, { rolepay }) => {
  const parsed = parseOptions(Options, options)
  if (!parsed.ok) return parsed.reply
  const token = parsed.value.token === 'default' ? null : parsed.value.token
  const set = await rolepay.payees.setPreferredToken({ guildId: ctx.guildId, discordUserId: ctx.caller.userId, token })
  if (!set.ok) return replyError(set.error)
  const community = await rolepay.communities.get(ctx.guildId)
  if (!community.ok) return replyError(community.error)
  return { kind: 'reply', ephemeral: true, message: payeePreferMessage({ payee: set.value, community: community.value }) }
}
