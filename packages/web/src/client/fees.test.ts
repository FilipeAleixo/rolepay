import { describe, expect, it } from 'vitest'
import { FEE_RESERVE, treasuryFeeToken } from './fees.js'

const PAYOUT = '0x20c000000000000000000000b9537d11c60e8b50' // USDC.e
const FEE = '0x20c0000000000000000000000000000000000000' // pathUSD

describe("treasuryFeeToken (who pays the passkey's own transactions when there is no sponsor)", () => {
  it('the fee token, while it has enough for a fee', () => {
    expect(treasuryFeeToken({ feeToken: FEE, payoutToken: PAYOUT, balances: { fee: 2_000_000n, payout: 50_000_000n } })).toBe(FEE)
    expect(treasuryFeeToken({ feeToken: FEE, payoutToken: PAYOUT, balances: { fee: FEE_RESERVE, payout: 0n } })).toBe(FEE)
  })

  it('the payout token once the fee token has run out, so the treasurer can always revoke the bot key', () => {
    expect(treasuryFeeToken({ feeToken: FEE, payoutToken: PAYOUT, balances: { fee: FEE_RESERVE - 1n, payout: 50_000_000n } })).toBe(PAYOUT)
    expect(treasuryFeeToken({ feeToken: FEE, payoutToken: PAYOUT, balances: { fee: 0n, payout: FEE_RESERVE } })).toBe(PAYOUT)
  })

  it('the fee token when neither has enough (the transaction then fails and the page asks to fund it)', () => {
    expect(treasuryFeeToken({ feeToken: FEE, payoutToken: PAYOUT, balances: { fee: 0n, payout: 0n } })).toBe(FEE)
  })

  it('a sponsored community (no fee token) pays in the payout token', () => {
    expect(treasuryFeeToken({ feeToken: null, payoutToken: PAYOUT, balances: { fee: null, payout: 1n } })).toBe(PAYOUT)
  })

  it('keeps a reserve of 0.1: a passkey transaction on Tempo costs about a cent', () => {
    expect(FEE_RESERVE).toBe(100_000n)
  })
})
