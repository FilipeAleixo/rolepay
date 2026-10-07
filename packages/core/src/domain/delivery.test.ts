import { describe, expect, it } from 'vitest'
import { MAINNET_TOKENS, PREFERRED_TOKENS, TESTNET_TOKENS } from '../constants/tempo.js'
import type { Community } from './community.js'
import {
  type SwapLeg,
  checkSwapQuotes,
  checkSwapScope,
  keyLacksSwapScope,
  lineSwapFor,
  maxSwapInput,
  payoutSpendCap,
  preferenceChoices,
  swapLegs,
  swapTokensFor,
} from './delivery.js'

const { alpha_usd: ALPHA, beta_usd: BETA, theta_usd: THETA, path_usd: PATH } = TESTNET_TOKENS
const T0 = new Date('2026-10-07T12:00:00Z')
const community = (over: Partial<Community> = {}): Community => ({
  id: '1094309218049937418',
  name: 'g',
  network: 'moderato',
  treasuryAddress: '0x9999999999999999999999999999999999999999',
  payoutToken: ALPHA,
  feeMode: 'sponsor',
  feeToken: null,
  approverRoleId: null,
  requireSeparateApprover: false,
  aiProposals: false,
  proposerRoleId: null,
  preferredTokens: true,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

describe('the preferred-token allowlist (a fixed list per network)', () => {
  it('is AlphaUSD, BetaUSD and ThetaUSD on Moderato, and USDC.e, OUSD and USDT0 on mainnet; never pathUSD, the fee token', () => {
    expect(PREFERRED_TOKENS.moderato).toEqual([ALPHA, BETA, THETA])
    expect(PREFERRED_TOKENS.mainnet).toEqual([MAINNET_TOKENS.usdc_e, MAINNET_TOKENS.ousd, MAINNET_TOKENS.usdt0])
    for (const list of Object.values(PREFERRED_TOKENS)) expect(list).not.toContain(PATH)
  })

  it('swap tokens are the allowlist without the payout token and without the fee token (a key has one limit per token)', () => {
    expect(swapTokensFor(community())).toEqual([BETA, THETA])
    expect(swapTokensFor(community({ payoutToken: BETA }))).toEqual([ALPHA, THETA])
    expect(swapTokensFor(community({ feeMode: 'fee_budget', feeToken: THETA }))).toEqual([BETA])
    expect(swapTokensFor(community({ payoutToken: PATH }))).toEqual([ALPHA, BETA, THETA])
  })

  it('a payee chooses from the payout token (the default) and the swap tokens', () => {
    expect(preferenceChoices(community())).toEqual([ALPHA, BETA, THETA])
    expect(preferenceChoices(community({ feeMode: 'fee_budget', feeToken: THETA }))).toEqual([ALPHA, BETA])
  })
})

describe('keyLacksSwapScope: whether runs with swaps would be held until the treasurer authorises a new key', () => {
  it('only with preferred tokens on, and a key (or none) that cannot deliver every swap token', () => {
    expect(keyLacksSwapScope(community({ preferredTokens: false }), null)).toBe(false)
    expect(keyLacksSwapScope(community(), null)).toBe(true)
    expect(keyLacksSwapScope(community(), { swapTokens: undefined })).toBe(true)
    expect(keyLacksSwapScope(community(), { swapTokens: [BETA] })).toBe(true)
    expect(keyLacksSwapScope(community(), { swapTokens: [BETA, THETA] })).toBe(false)
  })
})

describe('maxSwapInput: the most of the payout token one line may spend', () => {
  it('is the amount plus the cap in basis points, rounded down so it never exceeds the cap', () => {
    expect(maxSwapInput(5_000_000n, 100)).toBe(5_050_000n)
    expect(maxSwapInput(1_234_567n, 100)).toBe(1_246_912n) // 12,345.67 micro-units over, rounded down
    expect(maxSwapInput(99n, 100)).toBe(99n) // under a cent's worth of cap: no room at all
    expect(maxSwapInput(5_000_000n, 0)).toBe(5_000_000n)
  })
})

describe('lineSwapFor: how a line pays this payee', () => {
  const prefers = (preferredToken: `0x${string}` | null) => ({ preferredToken })

  it('swaps into the preference when the community has preferred tokens on', () => {
    expect(lineSwapFor(community(), prefers(BETA), 5_000_000n, 100)).toEqual({ token: BETA, maxIn: 5_050_000n })
  })

  it('pays in the payout token with preferred tokens off (the default): everything as before', () => {
    expect(lineSwapFor(community({ preferredTokens: false }), prefers(BETA), 5_000_000n, 100)).toBeNull()
  })

  it('pays in the payout token for no preference, a preference for the payout token itself, or one that is no longer a swap token', () => {
    expect(lineSwapFor(community(), prefers(null), 5_000_000n, 100)).toBeNull()
    expect(lineSwapFor(community(), prefers(ALPHA), 5_000_000n, 100)).toBeNull()
    expect(lineSwapFor(community({ feeMode: 'fee_budget', feeToken: BETA }), prefers(BETA), 5_000_000n, 100)).toBeNull()
    expect(lineSwapFor(community(), prefers(PATH), 5_000_000n, 100)).toBeNull()
  })
})

describe('swapLegs: one swap per delivered token', () => {
  const lines = [
    { amount: 5_000_000n, swap: { token: BETA, maxIn: 5_050_000n } },
    { amount: 2_000_000n },
    { amount: 3_000_000n, swap: { token: THETA, maxIn: 3_030_000n } },
    { amount: 1_000_000n, swap: { token: BETA, maxIn: 1_010_000n } },
  ]

  it('sums the amounts and the maxima of the lines paid in each token, in the order of the first such line', () => {
    expect(swapLegs(lines)).toEqual([
      { token: BETA, amountOut: 6_000_000n, maxIn: 6_060_000n },
      { token: THETA, amountOut: 3_000_000n, maxIn: 3_030_000n },
    ])
    expect(swapLegs([{ amount: 1n }])).toEqual([])
  })

  it('the payout spend cap is every amount, a swapped line counted at its maximum input', () => {
    expect(payoutSpendCap(lines)).toBe(5_050_000n + 2_000_000n + 3_030_000n + 1_010_000n)
    expect(payoutSpendCap([{ amount: 2_000_000n }, { amount: 1n }])).toBe(2_000_001n)
  })
})

describe('checkSwapScope and checkSwapQuotes: the run is held whole, with the reason, before anything is signed', () => {
  const legs: SwapLeg[] = [
    { token: BETA, amountOut: 6_000_000n, maxIn: 6_060_000n },
    { token: THETA, amountOut: 3_000_000n, maxIn: 3_030_000n },
  ]

  it('refuses tokens the key was not authorised to deliver (it would be refused on chain with CallNotAllowed)', () => {
    expect(checkSwapScope(legs, [BETA, THETA])).toEqual({ ok: true, value: undefined })
    expect(checkSwapScope([], undefined)).toEqual({ ok: true, value: undefined })
    expect(checkSwapScope(legs, undefined)).toEqual({ ok: false, error: { code: 'swap_not_authorized', tokens: [BETA, THETA] } })
    expect(checkSwapScope(legs, [BETA])).toEqual({ ok: false, error: { code: 'swap_not_authorized', tokens: [THETA] } })
  })

  const quoted = (amountIn: bigint) => ({ kind: 'quoted' as const, amountIn })

  it('passes quotes within each maximum and preferred-token limits that cover the deliveries', () => {
    expect(checkSwapQuotes(legs, [quoted(5_990_000n), quoted(3_030_000n)], [6_000_000n, 10_000_000n])).toEqual({ ok: true, value: undefined })
  })

  it('holds the run when the DEX cannot route a token (no pair, or not enough liquidity)', () => {
    expect(checkSwapQuotes(legs, [quoted(1n), { kind: 'no_route', detail: 'InsufficientLiquidity' }], [10n ** 12n, 10n ** 12n])).toEqual({
      ok: false,
      error: { code: 'swap_no_route', token: THETA },
    })
  })

  it('holds the run when a quote is over the slippage cap, with the numbers', () => {
    expect(checkSwapQuotes(legs, [quoted(6_060_001n), quoted(1n)], [10n ** 12n, 10n ** 12n])).toEqual({
      ok: false,
      error: { code: 'swap_over_cap', token: BETA, quoted: 6_060_001n, max: 6_060_000n },
    })
  })

  it("holds the run when the key's limit in a preferred token is lower than what the run delivers in it", () => {
    expect(checkSwapQuotes(legs, [quoted(1n), quoted(1n)], [6_000_000n, 2_999_999n])).toEqual({
      ok: false,
      error: { code: 'swap_limit_low', token: THETA, remaining: 2_999_999n, needed: 3_000_000n },
    })
  })
})
