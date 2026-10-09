import { NETWORKS, type NetworkName, TOKEN_SYMBOLS, displayAmount } from '@rolepay/core'

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export const tokenLabel = (token: string) => TOKEN_SYMBOLS[token.toLowerCase()] ?? shortAddress(token)

/** Money for people: bigint micro-units in, "1.5 AlphaUSD" or "999,995 AlphaUSD" out (display only, never parsed back). */
export const money = (micros: bigint, token: string) => `${displayAmount(micros)} ${tokenLabel(token)}`

/** A count with its noun: "1 person", "3 people", "0 people". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const txUrl =(network: NetworkName, txHash: string) => `${NETWORKS[network].explorerUrl}/tx/${txHash}`
export const addressUrl = (network: NetworkName, address: string) => `${NETWORKS[network].explorerUrl}/address/${address}`

/** Discord renders `<t:unix:R>` as "in 5 minutes" / "2 hours ago" in the reader's locale. */
export const relativeTime = (at: Date | number) => `<t:${Math.floor((typeof at === 'number' ? at * 1000 : at.getTime()) / 1000)}:R>`

export const mention = (userId: string) => `<@${userId}>`
export const roleMention = (roleId: string) => `<@&${roleId}>`

/** Mentions in Rolepay's messages are for reading, never for pinging. */
export const NO_PINGS = { parse: [] as never[] }

export const COLORS = { pending: 0xf0b232, working: 0x5865f2, paid: 0x23a55a, failed: 0xda373c, muted: 0x80848e } as const

/**
 * Text a person typed (a run note), shown inside Discord markdown (embeds, DMs): every character
 * that could format it is escaped, so a note can never become a masked link, a bold claim, a
 * mention, a spoiler or a clickable URL delivered by the bot.
 */
export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|>#[\]()<@:-]/g, '\\$&')

/**
 * The AI's words (reasons, notes, assumptions), escaped like a note except for whole mentions of
 * a person, a role or a channel. Core put those there in place of the model's tokens, and lets
 * through only the request's own (`detokenize`); they read as names, and with `NO_PINGS` (and
 * inside an embed) they ping nobody. Anything else, a partial mention or `@everyone`, is escaped.
 */
export const escapeAiText = (text: string) =>
  text
    .split(/(<(?:@&?|#)\d{17,20}>)/)
    .map((part, i) => (i % 2 ? part : escapeMarkdown(part)))
    .join('')

/**
 * An instruction a person typed, escaped like a note except for whole mentions: Discord writes a
 * channel, role or person picked from its list as `<#id>`, `<@&id>` or `<@id>`, which escaped would
 * show as raw IDs. They read as names, and with `NO_PINGS` (and inside an embed) they ping nobody.
 */
export const escapeInstruction = escapeAiText
