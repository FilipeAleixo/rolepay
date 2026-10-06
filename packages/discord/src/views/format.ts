import { NETWORKS, type NetworkName, TOKEN_SYMBOLS, formatAmount } from '@payrun/core'

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export const tokenLabel = (token: string) => TOKEN_SYMBOLS[token.toLowerCase()] ?? shortAddress(token)

/** Money for people: bigint micro-units in, "1.5 AlphaUSD" out. */
export const money = (micros: bigint, token: string) => `${formatAmount(micros)} ${tokenLabel(token)}`

/** A count with its noun: "1 person", "3 people", "0 people". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const txUrl =(network: NetworkName, txHash: string) => `${NETWORKS[network].explorerUrl}/tx/${txHash}`
export const addressUrl = (network: NetworkName, address: string) => `${NETWORKS[network].explorerUrl}/address/${address}`

/** Discord renders `<t:unix:R>` as "in 5 minutes" / "2 hours ago" in the reader's locale. */
export const relativeTime = (at: Date | number) => `<t:${Math.floor((typeof at === 'number' ? at * 1000 : at.getTime()) / 1000)}:R>`

export const mention = (userId: string) => `<@${userId}>`
export const roleMention = (roleId: string) => `<@&${roleId}>`

/** Mentions in payrun's messages are for reading, never for pinging. */
export const NO_PINGS = { parse: [] as never[] }

export const COLORS = { pending: 0xf0b232, working: 0x5865f2, paid: 0x23a55a, failed: 0xda373c, muted: 0x80848e } as const

/**
 * Text a person typed (a run note), shown inside Discord markdown (embeds, DMs): every character
 * that could format it is escaped, so a note can never become a masked link, a bold claim, a
 * mention, a spoiler or a clickable URL delivered by the bot (L6).
 */
export const escapeMarkdown = (text: string) => text.replace(/[\\*_~`|>#[\]()<@:-]/g, '\\$&')
