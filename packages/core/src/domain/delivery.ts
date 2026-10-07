import { z } from 'zod'
import { PREFERRED_TOKENS } from '../constants/tempo.js'
import type { Community } from './community.js'
import { type Address, AddressSchema } from './ids.js'
import type { Micros } from './money.js'
import { type Result, err, ok } from './result.js'

/**
 * Paying each person in the stablecoin they prefer. A community pays in its payout token; when it
 * turns preferred tokens on, a line for someone who chose another USD stablecoin is delivered in
 * that token instead: the batch buys exactly the line's amount of it on Tempo's stablecoin DEX
 * (exact output, spending at most `maxIn` of the payout token), then sends it with the same
 * `transferWithMemo` and the same memo as any line. One transaction, all or nothing.
 */

/** A line delivered in another token: bought on the DEX in the same batch, spending at most `maxIn` of the run's token. */
export const LineSwapSchema = z.object({ token: AddressSchema, maxIn: z.bigint().positive() })
export type LineSwap = z.infer<typeof LineSwapSchema>

const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase()

/**
 * The stablecoins this community may deliver instead of its payout token: the network's allowlist
 * without the payout token, and without the fee token (an access key carries one spending limit per
 * token, and the fee token's is the fee budget).
 */
export function swapTokensFor(c: Pick<Community, 'network' | 'payoutToken' | 'feeToken'>): Address[] {
  return PREFERRED_TOKENS[c.network].filter((t) => !same(t, c.payoutToken) && !same(t, c.feeToken))
}

/**
 * Whether the community pays in preferred stablecoins while its key (`null`: no active key) was
 * authorised without the swap scope for every swap token: runs with swaps are then held
 * (`swap_not_authorized`) until the treasurer authorises a new key on the setup page.
 */
export function keyLacksSwapScope(c: Pick<Community, 'network' | 'payoutToken' | 'feeToken' | 'preferredTokens'>, key: { swapTokens?: Address[] | undefined } | null): boolean {
  if (!c.preferredTokens) return false
  const granted = key?.swapTokens ?? []
  return swapTokensFor(c).some((t) => !granted.some((g) => same(g, t)))
}

/** What a payee may choose from: the payout token (the default, "no preference") and the swap tokens. */
export function preferenceChoices(c: Pick<Community, 'network' | 'payoutToken' | 'feeToken'>): Address[] {
  return [c.payoutToken, ...swapTokensFor(c)]
}

/** The most of the payout token a swapped line may spend: its amount plus `capBps` basis points, rounded down, so never past the cap. */
export function maxSwapInput(amount: Micros, capBps: number): Micros {
  return amount + (amount * BigInt(capBps)) / 10_000n
}

/**
 * How a line pays this payee: null pays in the payout token (preferred tokens off, the default; no
 * preference; the payout token itself; or a preference that is no longer a swap token), otherwise
 * the swap that delivers their preference.
 */
export function lineSwapFor(
  c: Pick<Community, 'network' | 'payoutToken' | 'feeToken' | 'preferredTokens'>,
  payee: { preferredToken: Address | null },
  amount: Micros,
  capBps: number,
): LineSwap | null {
  const wanted = payee.preferredToken
  if (!c.preferredTokens || wanted === null) return null
  const token = swapTokensFor(c).find((t) => same(t, wanted))
  return token ? { token, maxIn: maxSwapInput(amount, capBps) } : null
}

/** One DEX swap of a batch: every line paid in `token`, bought together (one swap per token keeps the batch's gas near a plain run's). */
export type SwapLeg = { token: Address; amountOut: Micros; maxIn: Micros }

type Line = { amount: Micros; swap?: LineSwap | undefined }

/** The swaps a batch makes: per delivered token, the lines' amounts and maxima summed, in the order of the first line that needs it. */
export function swapLegs(lines: readonly Line[]): SwapLeg[] {
  const legs = new Map<string, SwapLeg>()
  for (const l of lines) {
    if (!l.swap) continue
    const key = l.swap.token.toLowerCase()
    const leg = legs.get(key) ?? { token: l.swap.token, amountOut: 0n, maxIn: 0n }
    legs.set(key, { ...leg, amountOut: leg.amountOut + l.amount, maxIn: leg.maxIn + l.swap.maxIn })
  }
  return [...legs.values()]
}

/**
 * At most what a run spends of its payout token: each line's amount, a swapped line at its maximum
 * input. The pre-flight checks this against the key's remaining limit; the chain charges a swap at
 * what it actually took (never more than its maximum, or the batch reverts).
 */
export function payoutSpendCap(lines: readonly Line[]): Micros {
  return lines.reduce((sum, l) => sum + (l.swap ? l.swap.maxIn : l.amount), 0n)
}

/** What the DEX would charge for one leg right now (a read-only quote), or why it cannot. */
export type SwapQuote = { kind: 'quoted'; amountIn: Micros } | { kind: 'no_route'; detail: string }

export type SwapCheckError =
  /** The bot key was authorised without these tokens: the chain would refuse the batch with CallNotAllowed. */
  | { code: 'swap_not_authorized'; tokens: Address[] }
  /** The DEX has no route to this token right now (no pair, or not enough liquidity). */
  | { code: 'swap_no_route'; token: Address }
  /** Buying it now costs more than the slippage cap allows. */
  | { code: 'swap_over_cap'; token: Address; quoted: Micros; max: Micros }
  /** The key's limit in this token is lower than what the run delivers in it. */
  | { code: 'swap_limit_low'; token: Address; remaining: Micros; needed: Micros }

/** Whether the key may deliver every token the run swaps into (`authorized` is the key policy's `swapTokens`). */
export function checkSwapScope(legs: readonly SwapLeg[], authorized: readonly Address[] | undefined): Result<void, SwapCheckError> {
  const missing = legs.map((l) => l.token).filter((t) => !(authorized ?? []).some((a) => same(a, t)))
  return missing.length ? err({ code: 'swap_not_authorized', tokens: missing }) : ok(undefined)
}

/**
 * The pre-flight for a run's swaps, on what the chain said just before signing: a quote for each
 * leg (in order) and the key's remaining limit in each leg's token. Any problem holds the run
 * whole, before anything is signed; the chain enforces each leg's maximum anyway.
 */
export function checkSwapQuotes(legs: readonly SwapLeg[], quotes: readonly SwapQuote[], remaining: readonly Micros[]): Result<void, SwapCheckError> {
  for (const [i, leg] of legs.entries()) {
    const quote = quotes[i]
    if (!quote || quote.kind === 'no_route') return err({ code: 'swap_no_route', token: leg.token })
    if (quote.amountIn > leg.maxIn) return err({ code: 'swap_over_cap', token: leg.token, quoted: quote.amountIn, max: leg.maxIn })
    const left = remaining[i] ?? 0n
    if (left < leg.amountOut) return err({ code: 'swap_limit_low', token: leg.token, remaining: left, needed: leg.amountOut })
  }
  return ok(undefined)
}
