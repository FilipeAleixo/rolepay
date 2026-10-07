import type { CommandHandler } from '../app/handlers.js'
import { replyError } from '../app/handlers.js'
import { payeeLinkMessage } from '../views/payee.js'

/** /payee link: anyone in the server gets their own one-time claim link, ephemerally. */
export const payeeLinkCommand: CommandHandler = async ({ ctx }, { rolepay, config }) => {
  const link = await rolepay.payees.issueLink({ guildId: ctx.guildId, discordUserId: ctx.caller.userId })
  if (!link.ok) return replyError(link.error)
  const current = await rolepay.payees.get({ guildId: ctx.guildId, discordUserId: ctx.caller.userId })
  const url = `${config.claimBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(link.value.token)}`
  return { kind: 'reply', ephemeral: true, message: payeeLinkMessage({ url, expiresAt: link.value.expiresAt, current: current.ok ? current.value : null }) }
}
