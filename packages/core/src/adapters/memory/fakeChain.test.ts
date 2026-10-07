import { beforeEach, describe, expect, it } from 'vitest'
import { encodeMemo } from '../../domain/memo.js'
import { FakePayoutChain } from './fakeChain.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const OTHER = '0x20c0000000000000000000000000000000000002'
const TREASURY = '0x9999999999999999999999999999999999999999'
const A1 = '0x1111111111111111111111111111111111111111'
const A2 = '0x2222222222222222222222222222222222222222'

describe('FakePayoutChain (the chain double behind every service unit test)', () => {
  let chain: FakePayoutChain
  let key: { address: `0x${string}`; secret: string }
  const root = () => chain.rootSigner(TREASURY)
  const transfers = [
    { to: A1, amount: 1_000_000n, memo: encodeMemo('run_f', 1) },
    { to: A2, amount: 2_000_000n, memo: encodeMemo('run_f', 2) },
  ] as const
  const sign = (over: Partial<Parameters<FakePayoutChain['signBatch']>[0]> = {}) =>
    chain.signBatch({
      account: TREASURY,
      accessKeySecret: key.secret,
      token: TOKEN,
      transfers: [...transfers],
      validBefore: chain.time + 120,
      fee: { mode: 'sponsor' },
      ...over,
    })

  beforeEach(async () => {
    chain = new FakePayoutChain({ startTime: 1_700_000_000 })
    chain.fund(TOKEN, TREASURY, 100_000_000n)
    key = await chain.newAccessKey()
  })

  async function authorize(limit = 10_000_000n, recipients?: `0x${string}`[]) {
    const r = await chain.authorizeKey({
      root: root(),
      accessKey: key.address,
      authorization: {
        expiry: chain.time + 3600,
        limits: [{ token: TOKEN, limit }],
        scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)', ...(recipients ? { recipients } : {}) }],
      },
    })
    expect(r.ok).toBe(true)
  }

  it('reports an unknown key as not_authorized, then active with its limit', async () => {
    const before = await chain.keyState({ account: TREASURY, accessKey: key.address, token: TOKEN, feeToken: null })
    expect(before.status).toBe('not_authorized')
    await authorize()
    const after = await chain.keyState({ account: TREASURY, accessKey: key.address, token: TOKEN, feeToken: null })
    expect(after).toMatchObject({ status: 'active', remaining: 10_000_000n, chainTime: chain.time })
  })

  it('signs without moving money, then a broadcast lands the whole batch atomically', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error(signed.error.detail)
    expect(chain.balance(TOKEN, A1)).toBe(0n)
    const out = await chain.broadcast(signed.value.rawTx)
    expect(out).toMatchObject({ kind: 'confirmed', txHash: signed.value.txHash })
    expect(chain.balance(TOKEN, A1)).toBe(1_000_000n)
    expect(chain.balance(TOKEN, A2)).toBe(2_000_000n)
    expect(chain.balance(TOKEN, TREASURY)).toBe(97_000_000n)
    const state = await chain.keyState({ account: TREASURY, accessKey: key.address, token: TOKEN, feeToken: null })
    expect(state.remaining).toBe(7_000_000n)
  })

  it('is idempotent: re-broadcasting the same raw tx never pays twice', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    await chain.broadcast(signed.value.rawTx)
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'confirmed', txHash: signed.value.txHash })
    expect(chain.balance(TOKEN, A1)).toBe(1_000_000n)
    expect(chain.landedTxCount).toBe(1)
  })

  it('finds memo transfers by memo, sender and token, and looks txs up by hash', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    await chain.broadcast(signed.value.rawTx)
    const found = await chain.findMemoTransfers({ token: TOKEN, from: TREASURY, memos: [transfers[1].memo], fromBlock: 0n })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ to: A2, amount: 2_000_000n, txHash: signed.value.txHash })
    expect(await chain.findMemoTransfers({ token: OTHER, from: TREASURY, memos: [transfers[1].memo], fromBlock: 0n })).toEqual([])
    expect(await chain.lookupTx(signed.value.txHash)).toMatchObject({ kind: 'confirmed' })
    expect(await chain.lookupTx(`0x${'00'.repeat(32)}`)).toEqual({ kind: 'not_found' })
  })

  it('refuses to sign over the remaining limit, for revoked keys, outside the allowlist, and without funds', async () => {
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'key_not_authorized' } })
    await authorize(2_000_000n)
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'spending_limit_exceeded' } })
    await chain.revokeKey({ root: root(), accessKey: key.address })
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'key_revoked' } })

    key = await chain.newAccessKey()
    await authorize(10_000_000n, [A1])
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'call_not_allowed' } })

    key = await chain.newAccessKey()
    await authorize(1_000_000_000n)
    const big = [{ to: A1 as `0x${string}`, amount: 500_000_000n, memo: encodeMemo('run_g', 1) }]
    expect(await sign({ transfers: big })).toMatchObject({ ok: false, error: { reason: 'insufficient_balance' } })
  })

  it('rejects a broadcast after validBefore: an expired tx can never land', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    chain.advance(121)
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'rejected' })
    expect(chain.balance(TOKEN, A1)).toBe(0n)
  })

  it('fault: lands the tx but loses the response (the crash-recovery case)', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    chain.faults.nextBroadcast = 'land_then_lose_response'
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'unknown' })
    expect(chain.balance(TOKEN, A1)).toBe(1_000_000n)
  })

  it('fault: drops the tx (never lands) and answers ambiguously', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    chain.faults.nextBroadcast = 'drop'
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'unknown' })
    expect(chain.balance(TOKEN, A1)).toBe(0n)
    expect(chain.landedTxCount).toBe(0)
  })

  it('fault: answers "rejected" but keeps the tx pending (a misread node error); mine() lands it before its deadline, never after', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    chain.faults.nextBroadcast = 'reject_but_keep_pending'
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'rejected' })
    expect(chain.landedTxCount).toBe(0)
    await chain.mine()
    expect(chain.landedTxCount).toBe(1)
    expect(chain.balance(TOKEN, A1)).toBe(1_000_000n)
    await chain.mine()
    expect(chain.landedTxCount).toBe(1)

    const late = await sign({ transfers: [{ to: A1, amount: 1n, memo: encodeMemo('run_g', 1) }] })
    if (!late.ok) throw new Error()
    chain.faults.nextBroadcast = 'reject_but_keep_pending'
    await chain.broadcast(late.value.rawTx)
    chain.advance(200)
    await chain.mine()
    expect(chain.landedTxCount).toBe(1)
  })

  it('searches memo transfers up to toBlock when given', async () => {
    await authorize()
    const signed = await sign()
    if (!signed.ok) throw new Error()
    const before = chain.blockNumber
    await chain.broadcast(signed.value.rawTx)
    const memos = transfers.map((t) => t.memo)
    expect(await chain.findMemoTransfers({ token: TOKEN, from: TREASURY, memos, fromBlock: 0n, toBlock: before })).toEqual([])
    expect(await chain.findMemoTransfers({ token: TOKEN, from: TREASURY, memos, fromBlock: 0n, toBlock: chain.blockNumber })).toHaveLength(2)
  })

  it('advances time and blocks', () => {
    const { time, blockNumber } = chain
    chain.advance(30)
    expect(chain.time).toBe(time + 30)
    expect(chain.blockNumber).toBeGreaterThan(blockNumber)
  })
})

describe('FakePayoutChain: swaps on the stablecoin DEX (lines paid in a preferred stablecoin)', () => {
  const BETA = OTHER
  const DEX = '0xdec0000000000000000000000000000000000000'
  const THETA = '0x20c0000000000000000000000000000000000003'
  let chain: FakePayoutChain
  let key: { address: `0x${string}`; secret: string }
  const lines = [
    { to: A1 as `0x${string}`, amount: 5_000_000n, memo: encodeMemo('run_s', 1), swap: { token: BETA as `0x${string}`, maxIn: 5_050_000n } },
    { to: A2 as `0x${string}`, amount: 2_000_000n, memo: encodeMemo('run_s', 2) },
  ]
  const sign = (transfers = lines) =>
    chain.signBatch({ account: TREASURY, accessKeySecret: key.secret, token: TOKEN, transfers, validBefore: chain.time + 120, fee: { mode: 'sponsor' } })
  const remaining = async (token: string) => (await chain.keyState({ account: TREASURY, accessKey: key.address, token: token as `0x${string}`, feeToken: null })).remaining

  async function authorize(scopes: { address: string; selector: string }[], limits = [TOKEN, BETA]) {
    const r = await chain.authorizeKey({
      root: chain.rootSigner(TREASURY),
      accessKey: key.address,
      authorization: { expiry: chain.time + 3600, limits: limits.map((token) => ({ token: token as `0x${string}`, limit: 10_000_000n })), scopes: scopes as never },
    })
    expect(r.ok).toBe(true)
  }
  const ALL = [
    { address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' },
    { address: DEX, selector: 'swapExactAmountOut(address,address,uint128,uint128)' },
    { address: BETA, selector: 'transferWithMemo(address,uint256,bytes32)' },
  ]

  beforeEach(async () => {
    chain = new FakePayoutChain({ startTime: 1_700_000_000 })
    chain.fund(TOKEN, TREASURY, 100_000_000n)
    chain.setSwapRoute(TOKEN, BETA, { inPerOutBps: 9_960, liquidity: 50_000_000n })
    key = await chain.newAccessKey()
  })

  it("quotes exact output at the route's rate, rounded up; no_route without a pair or past its liquidity", async () => {
    expect(await chain.quoteSwap({ tokenIn: TOKEN, tokenOut: BETA, amountOut: 5_000_000n })).toEqual({ kind: 'quoted', amountIn: 4_980_000n })
    expect(await chain.quoteSwap({ tokenIn: TOKEN, tokenOut: BETA, amountOut: 3n })).toEqual({ kind: 'quoted', amountIn: 3n })
    expect(await chain.quoteSwap({ tokenIn: TOKEN, tokenOut: THETA, amountOut: 1n })).toMatchObject({ kind: 'no_route' })
    expect(await chain.quoteSwap({ tokenIn: TOKEN, tokenOut: BETA, amountOut: 50_000_001n })).toMatchObject({ kind: 'no_route' })
  })

  it('lands the swap and the transfers atomically: each payee gets their token with its memo, the treasury pays the quote, each limit is charged what moved', async () => {
    await authorize(ALL)
    const signed = await sign()
    if (!signed.ok) throw new Error(signed.error.detail)
    const out = await chain.broadcast(signed.value.rawTx)
    expect(out).toMatchObject({ kind: 'confirmed' })
    expect(chain.balance(BETA, A1)).toBe(5_000_000n)
    expect(chain.balance(TOKEN, A2)).toBe(2_000_000n)
    expect(chain.balance(TOKEN, TREASURY)).toBe(100_000_000n - 2_000_000n - 4_980_000n)
    expect(chain.balance(BETA, TREASURY)).toBe(0n)
    expect(await remaining(TOKEN)).toBe(10_000_000n - 2_000_000n - 4_980_000n)
    expect(await remaining(BETA)).toBe(5_000_000n)
    const found = await chain.findMemoTransfers({ token: BETA, from: TREASURY, memos: [lines[0]?.memo as `0x${string}`], fromBlock: 0n })
    expect(found).toEqual([expect.objectContaining({ token: BETA, to: A1, amount: 5_000_000n })])
  })

  it('refuses a key without the DEX swap or the preferred token\'s transferWithMemo, a swap over its maximum, and a route without liquidity', async () => {
    await authorize(ALL.filter((s) => s.address !== DEX))
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'call_not_allowed' } })
    key = await chain.newAccessKey()
    await authorize(ALL.filter((s) => s.address !== BETA))
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'call_not_allowed' } })

    key = await chain.newAccessKey()
    await authorize(ALL)
    const tight = [{ ...lines[0], swap: { token: BETA as `0x${string}`, maxIn: 4_979_999n } }] as typeof lines
    expect(await sign(tight)).toMatchObject({ ok: false, error: { reason: 'swap_failed' } })
    chain.setSwapRoute(TOKEN, BETA, null)
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'swap_failed' } })
  })

  it("a price that moves past the maximum after signing reverts the whole batch: nobody is paid, no limit is charged", async () => {
    await authorize(ALL)
    const signed = await sign()
    if (!signed.ok) throw new Error(signed.error.detail)
    chain.setSwapRoute(TOKEN, BETA, { inPerOutBps: 10_200, liquidity: 50_000_000n })
    expect(await chain.broadcast(signed.value.rawTx)).toMatchObject({ kind: 'reverted' })
    expect(chain.balance(BETA, A1)).toBe(0n)
    expect(chain.balance(TOKEN, A2)).toBe(0n)
    expect(await remaining(TOKEN)).toBe(10_000_000n)
  })

  it("charges a swap's input to the input token's limit, and a preferred token's deliveries to its own: either one short refuses the batch", async () => {
    await authorize(ALL, [TOKEN])
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'spending_limit_exceeded' } })
    key = await chain.newAccessKey()
    await authorize(ALL, [BETA])
    expect(await sign()).toMatchObject({ ok: false, error: { reason: 'spending_limit_exceeded' } })
  })
})
