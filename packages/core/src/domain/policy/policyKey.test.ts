import { describe, expect, it } from 'vitest'
import type { KeyState } from '../community.js'
import { type PolicyKey, PolicyKeySchema, policyKeyContext, policyKeyDefaults, policyKeyError, policySigner, toPolicyKeyView } from './policyKey.js'

const T0 = new Date('2026-10-07T12:00:00Z')
const key = (over: Partial<PolicyKey> = {}): PolicyKey => ({
  address: '0x5555555555555555555555555555555555555551',
  communityId: '1094309218049937418',
  policyId: 'pol_000001',
  sealedSecret: 'sealed:x',
  status: 'pending_authorization',
  policy: { token: '0x20c0000000000000000000000000000000000001', limit: 30_000_000n, periodSeconds: 604_800, expiresAt: 1_800_000_000, recipients: null, feeToken: null, feeBudget: null },
  createdAt: T0,
  authorizedAt: null,
  revokedAt: null,
  ...over,
})

describe('a policy key', () => {
  it('is a bot key bound to one policy, and its view carries no secret', () => {
    expect(PolicyKeySchema.parse(key())).toEqual(key())
    expect(() => PolicyKeySchema.parse({ ...key(), policyId: 'not a policy id!' })).toThrow()
    expect(toPolicyKeyView(key())).not.toHaveProperty('sealedSecret')
    expect(toPolicyKeyView(key())).toMatchObject({ address: key().address, policyId: 'pol_000001' })
  })

  it('is sealed for its community, policy and key: another policy (or the bot key) cannot open it', () => {
    const ctx = policyKeyContext('1094309218049937418', 'pol_000001', '0xABCDEF0000000000000000000000000000000001')
    expect(ctx).toBe('policy-key:1094309218049937418:pol_000001:0xabcdef0000000000000000000000000000000001')
    expect(policyKeyContext('1094309218049937418', 'pol_000002', '0xabcdef0000000000000000000000000000000001')).not.toBe(ctx)
    expect(ctx.startsWith('bot-key:')).toBe(false)
  })
})

describe('which key signs a policy run (policySigner)', () => {
  it('a policy with no key of its own, or one never authorised, pays from the bot key as before', () => {
    expect(policySigner([])).toEqual({ kind: 'bot' })
    expect(policySigner([key()])).toEqual({ kind: 'bot' })
    expect(policySigner([key({ status: 'superseded', sealedSecret: null })])).toEqual({ kind: 'bot' })
  })

  it('once its own key is active, that key signs (a newer key waiting for the passkey never hides it)', () => {
    const active = key({ status: 'active', authorizedAt: T0 })
    const pending = key({ address: '0x5555555555555555555555555555555555555552', createdAt: new Date(T0.getTime() + 1000) })
    expect(policySigner([pending, active])).toEqual({ kind: 'own', key: active })
  })

  it('a revoked own key is never replaced by the bot key: the policy is stopped until a new key is authorised', () => {
    const revoked = key({ status: 'revoked', authorizedAt: T0, revokedAt: T0, sealedSecret: null })
    expect(policySigner([revoked])).toEqual({ kind: 'retired', key: revoked })
    // A new key waiting for the passkey does not bring the bot key back either.
    expect(policySigner([key({ address: '0x5555555555555555555555555555555555555553' }), revoked])).toEqual({ kind: 'retired', key: revoked })
  })
})

describe('the budget a policy key starts from (policyKeyDefaults)', () => {
  const caps = (perRun: bigint | null) => ({ perRun, perPerson: null })
  it("the limit is the policy's cap per run, the period one run of its schedule", () => {
    expect(policyKeyDefaults({ caps: caps(30_000_000n), schedule: { kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC' } })).toEqual({ limit: 30_000_000n, periodSeconds: 7 * 86_400 })
    expect(policyKeyDefaults({ caps: caps(null), schedule: { kind: 'daily', hour: 18, timezone: 'UTC' } })).toEqual({ limit: null, periodSeconds: 86_400 })
  })

  it('a monthly policy resets every 28 days, so no period ever holds two of its runs', () => {
    expect(policyKeyDefaults({ caps: caps(null), schedule: { kind: 'monthly', day: 1, hour: 9, timezone: 'UTC' } }).periodSeconds).toBe(28 * 86_400)
  })
})

describe('a key check on the policy key (policyKeyError)', () => {
  const state = (over: Partial<KeyState> = {}): KeyState => ({ status: 'active', expiry: 1_800_000_000, remaining: 10_000_000n, periodEnd: 1_700_100_000, chainTime: 1_700_000_000, feeBudgetRemaining: null, ...over })
  it('names the policy key, so nobody is told to fix the bot key', () => {
    expect(policyKeyError({ code: 'insufficient_limit', remaining: 10_000_000n, needed: 40_000_000n, periodEnd: state().periodEnd })).toEqual({
      code: 'insufficient_limit',
      remaining: 10_000_000n,
      needed: 40_000_000n,
      periodEnd: 1_700_100_000,
      key: 'policy',
    })
    expect(policyKeyError({ code: 'key_revoked' })).toEqual({ code: 'key_revoked', key: 'policy' })
  })
})
