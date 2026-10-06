import { describe, expect, it } from 'vitest'
import { TRANSFER_WITH_MEMO_SIGNATURE } from '../constants/tempo.js'
import { type KeyPolicy, type KeyState, canPropose, checkKeyForRun, keyAuthorization } from './community.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
const R1 = '0x1111111111111111111111111111111111111111'

const policy: KeyPolicy = {
  token: TOKEN,
  limit: 10_000_000n,
  periodSeconds: 2_592_000,
  expiresAt: 1_800_000_000,
  recipients: null,
  feeToken: null,
  feeBudget: null,
}

describe('canPropose (who may ask the AI for a pay run proposal)', () => {
  const APPROVER = '400000000000000001'
  const PROPOSERS = '400000000000000003'
  const c = { approverRoleId: APPROVER, proposerRoleId: null as string | null }

  it('the approver role may; someone without it may not', () => {
    expect(canPropose(c, [APPROVER])).toBe(true)
    expect(canPropose(c, [])).toBe(false)
    expect(canPropose(c, [PROPOSERS])).toBe(false)
  })

  it('the optional proposer role may too', () => {
    expect(canPropose({ ...c, proposerRoleId: PROPOSERS }, [PROPOSERS])).toBe(true)
  })

  it('nobody may in a community with no approver role (its runs could never be approved)', () => {
    expect(canPropose({ approverRoleId: null, proposerRoleId: PROPOSERS }, [PROPOSERS])).toBe(false)
  })
})

describe('keyAuthorization (what the root key signs)', () => {
  it('scopes the bot to transferWithMemo on the payout token, any recipient when there is no allowlist', () => {
    expect(keyAuthorization(policy)).toEqual({
      expiry: 1_800_000_000,
      limits: [{ token: TOKEN, limit: 10_000_000n, period: 2_592_000 }],
      scopes: [{ address: TOKEN, selector: TRANSFER_WITH_MEMO_SIGNATURE }],
    })
  })

  it('adds the recipient allowlist to the scope when one is set (optional capability)', () => {
    expect(keyAuthorization({ ...policy, recipients: [R1] }).scopes).toEqual([
      { address: TOKEN, selector: TRANSFER_WITH_MEMO_SIGNATURE, recipients: [R1] },
    ])
  })

  it('adds a separate fee-budget limit so fees never eat the payout limit', () => {
    expect(keyAuthorization({ ...policy, feeToken: FEE_TOKEN, feeBudget: 500_000n }).limits).toEqual([
      { token: TOKEN, limit: 10_000_000n, period: 2_592_000 },
      { token: FEE_TOKEN, limit: 500_000n, period: 2_592_000 },
    ])
  })

  it('omits period for a one-time limit', () => {
    expect(keyAuthorization({ ...policy, periodSeconds: null }).limits).toEqual([{ token: TOKEN, limit: 10_000_000n }])
  })
})

describe('checkKeyForRun (fail fast before signing; revoked keys otherwise fail slowly and vaguely)', () => {
  const active: KeyState = {
    status: 'active',
    expiry: 1_800_000_000,
    remaining: 10_000_000n,
    periodEnd: null,
    chainTime: 1_700_000_000,
    feeBudgetRemaining: null,
  }
  const run = { total: 3_000_000n, needsFeeBudget: false }

  it('passes an active key with enough limit and time left', () => {
    expect(checkKeyForRun(active, run)).toEqual({ ok: true, value: undefined })
  })

  it.each([
    ['not_authorized', 'key_not_authorized'],
    ['revoked', 'key_revoked'],
    ['expired', 'key_expired'],
  ] as const)('maps key status %s to %s', (status, code) => {
    expect(checkKeyForRun({ ...active, status }, run)).toMatchObject({ ok: false, error: { code } })
  })

  it('refuses a key that expires inside the submission window', () => {
    const r = checkKeyForRun({ ...active, expiry: active.chainTime + 60 }, run)
    expect(r).toMatchObject({ ok: false, error: { code: 'key_expires_too_soon' } })
  })

  it('refuses a run larger than the remaining limit and says by how much', () => {
    expect(checkKeyForRun({ ...active, remaining: 2_000_000n }, run)).toEqual({
      ok: false,
      error: { code: 'insufficient_limit', remaining: 2_000_000n, needed: 3_000_000n, periodEnd: null },
    })
  })

  it('accepts a run exactly equal to the remaining limit', () => {
    expect(checkKeyForRun({ ...active, remaining: 3_000_000n }, run).ok).toBe(true)
  })

  it('refuses when the fee budget is needed and exhausted', () => {
    const r = checkKeyForRun({ ...active, feeBudgetRemaining: 0n }, { ...run, needsFeeBudget: true })
    expect(r).toMatchObject({ ok: false, error: { code: 'fee_budget_exhausted' } })
  })
})
