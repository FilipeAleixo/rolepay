import type { Address } from './ids.js'
import { DiscordUsernameSchema } from './payee.js'
import { type Result, err, ok } from './result.js'

/**
 * "Use a wallet I already have": a payee registers an address they already control on Tempo by
 * signing this message with it (personal_sign, EIP-191). The server issues the nonce, bound to one
 * claim link and used once; the message binds the site (origin), the chain, the community, the
 * Discord member and the address, so a signature made for one of them is worthless for any other.
 * The address registered is the one recovered from the signature, never one a page sends.
 *
 * Pure: building, parsing and checking the text. Recovering the signer is a port (`MessageSignatures`).
 */
export type WalletClaim = {
  /** The site the page was served from, e.g. https://web.rolepay.app (its host leads the message). */
  origin: string
  communityName: string
  address: Address
  chainId: number
  discordUserId: string
  /** null for a link that kept no username: the message names the Discord ID alone. */
  discordUsername: string | null
  /** Server-issued, single use, bound to the claim link. */
  nonce: string
  issuedAt: Date
}

export type WalletClaimError =
  | { code: 'malformed_message' }
  | { code: 'wrong_origin' }
  | { code: 'wrong_chain'; expected: number; got: number }
  | { code: 'message_mismatch'; field: 'community' | 'discord_user' }

/** How long a claim nonce can be signed with, from when the server issued it. */
export const WALLET_NONCE_TTL_SECONDS = 600
/** No real message is near this long (the community name is at most 100 characters). */
export const MAX_WALLET_CLAIM_MESSAGE_LENGTH = 1000

const FOOTER = 'Signing proves this address is yours. It costs nothing and moves no money.'

/** A name as the message writes it: control and line-separator characters become spaces, so a name cannot add lines. */
const asText = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim()

export function walletClaimMessage(c: WalletClaim): string {
  const who = c.discordUsername ? `${c.discordUsername} (${c.discordUserId})` : c.discordUserId
  return [
    `Rolepay on ${new URL(c.origin).host}: pay me in ${asText(c.communityName)} at ${c.address} on Tempo (chain ${c.chainId}).`,
    '',
    `Discord user: ${who}`,
    `Origin: ${c.origin}`,
    `Claim nonce: ${c.nonce}`,
    `Issued at: ${c.issuedAt.toISOString()}`,
    '',
    FOOTER,
  ].join('\n')
}

const SENTENCE = /^Rolepay on \S+?: pay me in (.+) at (0x[0-9a-f]{40}) on Tempo \(chain ([1-9]\d{0,9})\)\.$/
const USER = /^Discord user: (?:([a-z0-9_.]{2,32}) \((\d{17,20})\)|(\d{17,20}))$/
const ORIGIN = /^Origin: (https?:\/\/[^\s/]+)$/
const NONCE = /^Claim nonce: ([A-Za-z0-9_-]{1,128})$/
const ISSUED = /^Issued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/

/**
 * The claim a message states, if it is exactly a message `walletClaimMessage` builds: every line in
 * place, nothing added, the same spacing and case. Anything else is `malformed_message`.
 */
export function parseWalletClaimMessage(text: string): Result<WalletClaim, { code: 'malformed_message' }> {
  const malformed = err({ code: 'malformed_message' as const })
  if (text.length > MAX_WALLET_CLAIM_MESSAGE_LENGTH) return malformed
  const lines = text.split('\n')
  if (lines.length !== 8) return malformed
  const [sentence, , user, origin, nonce, issued] = lines as [string, string, string, string, string, string, string, string]
  const s = SENTENCE.exec(sentence)
  const u = USER.exec(user)
  const o = ORIGIN.exec(origin)
  const n = NONCE.exec(nonce)
  const i = ISSUED.exec(issued)
  if (!s || !u || !o || !n || !i) return malformed
  if (!URL.canParse(o[1] as string) || new URL(o[1] as string).origin !== o[1]) return malformed
  const issuedAt = new Date(i[1] as string)
  if (Number.isNaN(issuedAt.getTime())) return malformed
  const username = u[1] ?? null
  if (username !== null && !DiscordUsernameSchema.safeParse(username).success) return malformed
  const claim: WalletClaim = {
    origin: o[1] as string,
    communityName: s[1] as string,
    address: s[2] as Address,
    chainId: Number(s[3]),
    discordUserId: (u[2] ?? u[3]) as string,
    discordUsername: username,
    nonce: n[1] as string,
    issuedAt,
  }
  // Rebuilt, it must be the same text: the host is the origin's, nothing is spaced or cased differently.
  return walletClaimMessage(claim) === text ? ok(claim) : malformed
}

/** The parts of a claim the server knows itself: its own origin and chain, and the link's community and member. */
export type ExpectedWalletClaim = { origin: string; chainId: number; communityName: string; discordUserId: string; discordUsername: string | null }

export function checkWalletClaim(c: WalletClaim, expected: ExpectedWalletClaim): Result<void, WalletClaimError> {
  if (c.origin !== expected.origin) return err({ code: 'wrong_origin' })
  if (c.chainId !== expected.chainId) return err({ code: 'wrong_chain', expected: expected.chainId, got: c.chainId })
  if (c.communityName !== asText(expected.communityName)) return err({ code: 'message_mismatch', field: 'community' })
  if (c.discordUserId !== expected.discordUserId || c.discordUsername !== expected.discordUsername) return err({ code: 'message_mismatch', field: 'discord_user' })
  return ok(undefined)
}

export const walletNonceExpired = (issuedAt: Date, now: Date) => now.getTime() >= issuedAt.getTime() + WALLET_NONCE_TTL_SECONDS * 1000
