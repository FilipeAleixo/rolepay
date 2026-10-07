import type { Community, Payee } from '@rolepay/core'
import { ButtonStyle, ComponentType, type Message } from '../api.js'
import { NO_PINGS, relativeTime, shortAddress, tokenLabel } from './format.js'

/** The ephemeral reply to /payee link: the caller's one-time registration link. */
export function payeeLinkMessage(input: { url: string; expiresAt: Date; current: Payee | null }): Message {
  const lines = [
    'Here is your one-time link to register the account you get paid at:',
    input.url,
    `It works once and expires ${relativeTime(input.expiresAt)}. Do not share it: whoever opens it first decides where your pay goes.`,
  ]
  if (input.current) lines.push(`You are registered at ${shortAddress(input.current.address)} now. Using this link replaces that address.`)
  return {
    content: lines.join('\n'),
    components: /^https?:\/\//.test(input.url)
      ? [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Register', url: input.url }] }]
      : [],
    allowed_mentions: NO_PINGS,
  }
}

/** The ephemeral reply to /payee prefer: what they will be paid in, and how, in this server. */
export function payeePreferMessage(input: { payee: Payee; community: Pick<Community, 'payoutToken' | 'preferredTokens'> }): Message {
  const payout = tokenLabel(input.community.payoutToken)
  const chosen = input.payee.preferredToken
  let content: string
  if (chosen === null) content = `You will be paid in ${payout}, the token this server pays in.`
  else if (input.community.preferredTokens)
    content = `You will be paid in ${tokenLabel(chosen)}. Each run swaps ${payout} into it on Tempo's stablecoin exchange, in the same transaction that pays you, for at most a set amount over your pay (the run waits if it cannot).`
  else content = `Saved: ${tokenLabel(chosen)}. This server pays everyone in ${payout} for now; you get ${tokenLabel(chosen)} once a treasurer turns on preferred stablecoins.`
  return { content, allowed_mentions: NO_PINGS }
}
