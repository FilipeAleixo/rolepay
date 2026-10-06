import type { Payee } from '@payrun/core'
import { ButtonStyle, ComponentType, type Message } from '../api.js'
import { NO_PINGS, relativeTime, shortAddress } from './format.js'

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
