import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, it } from 'vitest'
import { authorizationMismatch, authorizeKeyCall, buildAuthorization, describeAuthorization, rotationCalls } from './keychain.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
const KEY = '0x1111111111111111111111111111111111111111'
const TRANSFER_WITH_MEMO = toFunctionSelector('transferWithMemo(address,uint256,bytes32)')
/** Decoded addresses come back checksummed. */
const T = getAddress(TOKEN)
const F = getAddress(FEE_TOKEN)

const decoded = (call: ReturnType<typeof authorizeKeyCall>) =>
  decodeFunctionData({ abi: Abis.accountKeychain, data: encodeFunctionData(call as never) })

describe('authorizeKeyCall: the root calls the Account Keychain directly, so one transaction signature is the only passkey prompt', () => {
  it('calls the current authorizeKey(keyId, signatureType, KeyRestrictions) on the keychain, never the legacy selector', () => {
    const call = authorizeKeyCall(KEY, { expiry: 1_900_000_000, limits: [{ token: TOKEN, limit: '5000000' }], scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }] })
    expect(call.address).toBe(Addresses.accountKeychain)
    expect(encodeFunctionData(call as never).slice(0, 10)).toBe(
      toFunctionSelector('authorizeKey(address,uint8,(uint64,bool,(address,uint256,uint64)[],bool,(address,(bytes4,address[])[])[]))'),
    )
  })

  it('encodes the limit, the period, the expiry and the scope it is given (the page builds them from the form)', () => {
    const call = authorizeKeyCall(KEY, {
      expiry: 1_900_000_000,
      limits: [{ token: TOKEN, limit: '5000000', period: 86_400 }],
      scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
    })
    expect(decoded(call).args).toEqual([
      KEY,
      0, // secp256k1: the bot's key
      {
        expiry: 1_900_000_000n,
        enforceLimits: true,
        limits: [{ token: T, amount: 5_000_000n, period: 86_400n }],
        allowAnyCalls: false,
        allowedCalls: [{ target: T, selectorRules: [{ selector: TRANSFER_WITH_MEMO, recipients: [] }] }],
      },
    ])
  })

  it('a one-time limit has period 0, and a fee budget is a second limit with the same period', () => {
    const once = decoded(authorizeKeyCall(KEY, { expiry: 1, limits: [{ token: TOKEN, limit: '7' }], scopes: [] })).args?.[2] as { limits: unknown }
    expect(once.limits).toEqual([{ token: T, amount: 7n, period: 0n }])
    const withFee = decoded(
      authorizeKeyCall(KEY, { expiry: 1, limits: [{ token: TOKEN, limit: '7', period: 60 }, { token: FEE_TOKEN, limit: '2', period: 60 }], scopes: [] }),
    ).args?.[2] as { limits: unknown }
    expect(withFee.limits).toEqual([
      { token: T, amount: 7n, period: 60n },
      { token: F, amount: 2n, period: 60n },
    ])
  })

  it('encodes a recipient allowlist, and groups selectors on the same contract into one call scope (authorizationMismatch refuses any the page did not build)', () => {
    const payee = '0x2222222222222222222222222222222222222222'
    const call = authorizeKeyCall(KEY, {
      expiry: 1,
      limits: [{ token: TOKEN, limit: '1' }],
      scopes: [
        { address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)', recipients: [payee] },
        { address: TOKEN, selector: '0xa9059cbb' },
      ],
    })
    expect((decoded(call).args?.[2] as { allowedCalls: unknown }).allowedCalls).toEqual([
      {
        target: T,
        selectorRules: [
          { selector: TRANSFER_WITH_MEMO, recipients: [payee] },
          { selector: '0xa9059cbb', recipients: [] },
        ],
      },
    ])
  })
})

describe('rotationCalls: replacing the bot key is ONE root transaction that revokes the old keys and authorises the new one', () => {
  const OLD = '0x3333333333333333333333333333333333333333'
  const OLDER = '0x5555555555555555555555555555555555555555'
  const auth = { expiry: 1_900_000_000, limits: [{ token: TOKEN, limit: '5000000', period: 86_400 }], scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }] }

  it('revokes every live old key first, then authorises the new key, all on the keychain', () => {
    const calls = rotationCalls(KEY, auth, [OLD, OLDER])
    expect(calls.map((c) => c.to)).toEqual([Addresses.accountKeychain, Addresses.accountKeychain, Addresses.accountKeychain])
    const decodedCalls = calls.map((c) => decodeFunctionData({ abi: Abis.accountKeychain, data: c.data }))
    expect(decodedCalls.map((d) => d.functionName)).toEqual(['revokeKey', 'revokeKey', 'authorizeKey'])
    expect(decodedCalls[0]?.args).toEqual([getAddress(OLD)])
    expect(decodedCalls[1]?.args).toEqual([getAddress(OLDER)])
    expect(decodedCalls[2]?.args?.[0]).toBe(KEY)
  })

  it('with nothing to revoke it is the authorisation alone', () => {
    const calls = rotationCalls(KEY, auth, [])
    expect(calls).toHaveLength(1)
    expect(decodeFunctionData({ abi: Abis.accountKeychain, data: calls[0]?.data as `0x${string}` }).functionName).toBe('authorizeKey')
  })
})

describe('the setup page signs what the treasurer entered, never numbers the server chose', () => {
  const NOW = 1_800_000_000
  const DAY = 86_400
  const page = { payoutToken: TOKEN, feeToken: null }
  const form = { limit: '25.5', periodDays: '7', validityDays: '14' }
  const built = () => {
    const b = buildAuthorization(form, page, NOW)
    if (!b.ok) throw new Error(b.error)
    return b.value
  }

  it('builds the authorisation in the browser: the limit, the period, the expiry, and transferWithMemo on the payout token only', () => {
    expect(built()).toEqual({
      expiry: NOW + 14 * DAY,
      limits: [{ token: TOKEN, limit: '25500000', period: 7 * DAY }],
      scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
    })
  })

  it('a period of 0 days is one limit for the life of the key; fee budget mode adds the fee limit with the same period', () => {
    expect(buildAuthorization({ ...form, periodDays: '0' }, page, NOW)).toMatchObject({ ok: true, value: { limits: [{ token: TOKEN, limit: '25500000' }] } })
    const withFee = buildAuthorization({ ...form, feeBudget: '2' }, { payoutToken: TOKEN, feeToken: FEE_TOKEN }, NOW)
    expect(withFee).toMatchObject({ ok: true, value: { limits: [{ token: TOKEN, limit: '25500000', period: 7 * DAY }, { token: FEE_TOKEN, limit: '2000000', period: 7 * DAY }] } })
  })

  it('refuses input that is not a plain amount or a whole number of days, with no floats involved', () => {
    for (const limit of ['', '0', '-1', '1e3', '1.1234567', '1,5', '0x10', ' 5']) expect(buildAuthorization({ ...form, limit }, page, NOW)).toMatchObject({ ok: false })
    for (const periodDays of ['-1', '1.5', '367', 'x']) expect(buildAuthorization({ ...form, periodDays }, page, NOW)).toMatchObject({ ok: false })
    for (const validityDays of ['0', '367', '2.5']) expect(buildAuthorization({ ...form, validityDays }, page, NOW)).toMatchObject({ ok: false })
    expect(buildAuthorization(form, { payoutToken: TOKEN, feeToken: FEE_TOKEN }, NOW)).toMatchObject({ ok: false }) // fee budget missing
    expect(buildAuthorization({ ...form, limit: '0.000001' }, page, NOW)).toMatchObject({ ok: true, value: { limits: [{ limit: '1' }] } })
  })

  it('accepts the server answer only when it is exactly what the browser built', () => {
    expect(authorizationMismatch(built(), structuredClone(built()))).toBeNull()
    // Same values, different letter case in addresses: still the same authorisation.
    const upper = { ...built(), scopes: [{ address: TOKEN.toUpperCase().replace('0X', '0x'), selector: 'transferWithMemo(address,uint256,bytes32)' }] }
    expect(authorizationMismatch(built(), upper)).toBeNull()
  })

  it('refuses a tampered server answer: a bigger limit, a shorter period, a later expiry, an extra call, another target, another token', () => {
    const b = built()
    const tampered = [
      { ...b, limits: [{ ...b.limits[0], limit: (2n ** 255n).toString() }] },
      { ...b, limits: [{ ...b.limits[0], period: 0 }] },
      { ...b, limits: [{ token: TOKEN, limit: '25500000' }] },
      { ...b, expiry: b.expiry + 365 * DAY },
      { ...b, scopes: [...b.scopes, { address: TOKEN, selector: '0xa9059cbb' }] },
      { ...b, scopes: [{ address: FEE_TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }] },
      { ...b, scopes: [{ ...b.scopes[0], recipients: ['0x2222222222222222222222222222222222222222'] }] },
      { ...b, limits: [...b.limits, { token: FEE_TOKEN, limit: '1' }] },
    ]
    for (const t of tampered) expect(authorizationMismatch(b, t as never)).toEqual(expect.any(String))
  })

  it('describes exactly what is signed, in plain words', () => {
    const text = describeAuthorization(built(), { label: (t) => (t === TOKEN ? 'AlphaUSD' : t), date: (s) => `<${s}>` })
    expect(text).toBe(`Up to 25.5 AlphaUSD every 7 days. Only transferWithMemo on AlphaUSD (${TOKEN}), to anyone. Expires <${NOW + 14 * DAY}>.`)
    const once = buildAuthorization({ ...form, periodDays: '0', feeBudget: '1' }, { payoutToken: TOKEN, feeToken: FEE_TOKEN }, NOW)
    if (!once.ok) throw new Error()
    expect(describeAuthorization(once.value, { label: (t) => (t === TOKEN ? 'AlphaUSD' : 'pathUSD'), date: () => 'then' })).toBe(
      `Up to 25.5 AlphaUSD in total, plus up to 1 pathUSD in total for fees. Only transferWithMemo on AlphaUSD (${TOKEN}), to anyone. Expires then.`,
    )
  })
})

describe('with preferred stablecoins on, the page adds the swap scope itself, in the order core builds it', () => {
  const NOW = 1_800_000_000
  const DAY = 86_400
  const BETA = '0x20c0000000000000000000000000000000000002'
  const THETA = '0x20c0000000000000000000000000000000000003'
  const DEX = '0xdec0000000000000000000000000000000000000'
  const form = { limit: '25', periodDays: '7', validityDays: '14', feeBudget: '1' }
  const page = { payoutToken: TOKEN, feeToken: FEE_TOKEN, swapTokens: [BETA, THETA] }
  const built = () => {
    const b = buildAuthorization(form, page, NOW)
    if (!b.ok) throw new Error(b.error)
    return b.value
  }

  it('limits: the payout token, the fee budget, then each preferred token at the payout limit; calls: transferWithMemo on the payout token, the exact-output swap, transferWithMemo on each preferred token', () => {
    expect(built()).toEqual({
      expiry: NOW + 14 * DAY,
      limits: [
        { token: TOKEN, limit: '25000000', period: 7 * DAY },
        { token: FEE_TOKEN, limit: '1000000', period: 7 * DAY },
        { token: BETA, limit: '25000000', period: 7 * DAY },
        { token: THETA, limit: '25000000', period: 7 * DAY },
      ],
      scopes: [
        { address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' },
        { address: DEX, selector: 'swapExactAmountOut(address,address,uint128,uint128)' },
        { address: BETA, selector: 'transferWithMemo(address,uint256,bytes32)' },
        { address: THETA, selector: 'transferWithMemo(address,uint256,bytes32)' },
      ],
    })
    expect(buildAuthorization(form, { ...page, swapTokens: null }, NOW)).toEqual(buildAuthorization(form, { payoutToken: TOKEN, feeToken: FEE_TOKEN }, NOW))
    expect(buildAuthorization(form, { ...page, swapTokens: [] }, NOW)).toEqual(buildAuthorization(form, { payoutToken: TOKEN, feeToken: FEE_TOKEN }, NOW))
  })

  it('refuses a server answer that widens it: a bigger preferred-token limit, another DEX call, any call on the DEX', () => {
    const b = built()
    const tampered = [
      { ...b, limits: b.limits.map((l) => (l.token === BETA ? { ...l, limit: '99000000' } : l)) },
      { ...b, scopes: [...b.scopes, { address: DEX, selector: 'swapExactAmountIn(address,address,uint128,uint128)' }] },
      { ...b, scopes: b.scopes.map((s) => (s.address === DEX ? { address: DEX, selector: 'withdraw(address,uint128)' } : s)) },
    ]
    for (const t of tampered) expect(authorizationMismatch(b, t as never)).toEqual(expect.any(String))
  })

  it('describes the swap scope in plain words', () => {
    const labels: Record<string, string> = { [TOKEN]: 'AlphaUSD', [FEE_TOKEN]: 'pathUSD', [BETA]: 'BetaUSD', [THETA]: 'ThetaUSD', [DEX]: 'the stablecoin exchange' }
    expect(describeAuthorization(built(), { label: (t) => labels[t] ?? t, date: () => 'then' })).toBe(
      `Up to 25 AlphaUSD every 7 days, plus up to 1 pathUSD every 7 days for fees, plus up to 25 BetaUSD and up to 25 ThetaUSD every 7 days to pay people who chose them. ` +
        `Only transferWithMemo on AlphaUSD (${TOKEN}), to anyone. Only swapExactAmountOut on the stablecoin exchange (${DEX}), buying exactly what a run pays out. ` +
        `Only transferWithMemo on BetaUSD (${BETA}), to anyone. Only transferWithMemo on ThetaUSD (${THETA}), to anyone. Expires then.`,
    )
  })
})
