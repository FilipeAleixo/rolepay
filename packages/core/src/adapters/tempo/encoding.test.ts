import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeEventTopics, getAddress, type Log, toFunctionSelector } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { STABLECOIN_DEX_ADDRESS, SWAP_EXACT_AMOUNT_OUT_SIGNATURE, TRANSFER_WITH_MEMO_SIGNATURE } from '../../constants/tempo.js'
import { describe, expect, it } from 'vitest'
import { encodeMemo } from '../../domain/memo.js'
import { buildBatchCalls, classifyChainError, errorSummary, memoTransfersFromLogs } from './encoding.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const FROM = '0x9999999999999999999999999999999999999999'
const A1 = '0x1111111111111111111111111111111111111111'
const A2 = '0x2222222222222222222222222222222222222222'

describe('buildBatchCalls', () => {
  it('builds one transferWithMemo call per line on the payout token', () => {
    const transfers = [
      { to: A1, amount: 1n, memo: encodeMemo('r1', 1) },
      { to: A2, amount: 2n, memo: encodeMemo('r1', 2) },
    ] as const
    const calls = buildBatchCalls(TOKEN, [...transfers])
    expect(calls).toHaveLength(2)
    calls.forEach((c, i) => {
      expect(c.to).toBe(TOKEN)
      const d = decodeFunctionData({ abi: Abis.tip20, data: c.data })
      expect(d.functionName).toBe('transferWithMemo')
      expect(d.args).toEqual([transfers[i]?.to, transfers[i]?.amount, transfers[i]?.memo])
    })
  })
})

describe('buildBatchCalls with lines paid in a preferred stablecoin', () => {
  const BETA = '0x20c0000000000000000000000000000000000002'
  const THETA = '0x20c0000000000000000000000000000000000003'
  const A3 = '0x3333333333333333333333333333333333333333'
  const transfers = [
    { to: A1, amount: 5_000_000n, memo: encodeMemo('r2', 1), swap: { token: BETA, maxIn: 5_050_000n } },
    { to: A2, amount: 2_000_000n, memo: encodeMemo('r2', 2) },
    { to: A3, amount: 1_000_000n, memo: encodeMemo('r2', 3), swap: { token: BETA, maxIn: 1_010_000n } },
    { to: A1, amount: 3_000_000n, memo: encodeMemo('r2', 4), swap: { token: THETA, maxIn: 3_030_000n } },
  ] as const

  it('the constants are the DEX viem knows and the exact-output swap it encodes', () => {
    expect(STABLECOIN_DEX_ADDRESS).toBe(Addresses.stablecoinDex.toLowerCase())
    const swap = Abis.stablecoinDex.find((x) => x.type === 'function' && x.name === 'swapExactAmountOut')
    expect(toFunctionSelector(SWAP_EXACT_AMOUNT_OUT_SIGNATURE)).toBe(toFunctionSelector(swap as never))
    expect(toFunctionSelector(TRANSFER_WITH_MEMO_SIGNATURE)).toBe('0x95777d59')
  })

  it('first one exact-output DEX swap per delivered token (the lines summed, at most their maxima summed), then one transferWithMemo per line in its own token, each with its memo', () => {
    const calls = buildBatchCalls(TOKEN, [...transfers])
    expect(calls).toHaveLength(2 + 4)
    const decode = (i: number, abi: typeof Abis.stablecoinDex | typeof Abis.tip20) => decodeFunctionData({ abi, data: calls[i]?.data as `0x${string}` })
    expect(calls[0]?.to).toBe(STABLECOIN_DEX_ADDRESS)
    expect(decode(0, Abis.stablecoinDex)).toEqual({ functionName: 'swapExactAmountOut', args: [getAddress(TOKEN), getAddress(BETA), 6_000_000n, 6_060_000n] })
    expect(calls[1]?.to).toBe(STABLECOIN_DEX_ADDRESS)
    expect(decode(1, Abis.stablecoinDex)).toEqual({ functionName: 'swapExactAmountOut', args: [getAddress(TOKEN), getAddress(THETA), 3_000_000n, 3_030_000n] })
    expect(calls.slice(2).map((c) => c.to)).toEqual([BETA, TOKEN, BETA, THETA])
    transfers.forEach((t, i) => {
      expect(decode(2 + i, Abis.tip20)).toEqual({ functionName: 'transferWithMemo', args: [t.to, t.amount, t.memo] })
    })
  })

  it('a run with no swapped line encodes exactly as before: no DEX call at all', () => {
    const plain = [{ to: A1 as `0x${string}`, amount: 1n, memo: encodeMemo('r3', 1) }]
    expect(buildBatchCalls(TOKEN, plain)).toEqual([
      { to: TOKEN, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [A1, 1n, encodeMemo('r3', 1)] }) },
    ])
    expect(buildBatchCalls(TOKEN, plain).some((c) => c.to === STABLECOIN_DEX_ADDRESS)).toBe(false)
  })
})

describe('memoTransfersFromLogs', () => {
  it('parses TransferWithMemo logs into lowercase-address MemoTransfers and ignores other logs', () => {
    const memo = encodeMemo('r1', 1)
    const topics = encodeEventTopics({ abi: Abis.tip20, eventName: 'TransferWithMemo', args: { from: FROM, to: A1, memo } })
    const log = {
      address: '0x20C0000000000000000000000000000000000001',
      topics,
      data: encodeAbiParameters([{ type: 'uint256' }], [1_500_000n]),
      blockNumber: 77n,
      transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: 0,
      blockHash: `0x${'cd'.repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    } as unknown as Log
    const other = { ...log, topics: [`0x${'11'.repeat(32)}`] } as unknown as Log
    expect(memoTransfersFromLogs([log, other])).toEqual([
      { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 77n, token: TOKEN, from: FROM, to: A1, amount: 1_500_000n, memo },
    ])
  })
})

describe('classifyChainError (definitive refusals vs ambiguous failures)', () => {
  it.each([
    ['Missing or invalid parameters | keychain validation failed: AccountKeychainError(KeyAlreadyRevoked)', 'key_revoked'],
    ['Revm error: keychain validation failed: AccountKeychainError(KeyExpired)', 'key_expired'],
    ['execution reverted: SpendingLimitExceeded()', 'spending_limit_exceeded'],
    ['CallNotAllowed', 'call_not_allowed'],
    ['AccountKeychainError(KeyNotFound)', 'key_not_authorized'],
    ['InsufficientBalance(1, 2)', 'insufficient_balance'],
    ['execution reverted: Stablecoin DEX error: MaxInputExceeded(MaxInputExceeded)', 'swap_failed'],
    ['Error: InsufficientLiquidity()', 'swap_failed'],
  ] as const)('%s -> %s', (text, reason) => {
    expect(classifyChainError(text)).toBe(reason)
  })

  it.each(['HTTP request failed. Status: 502', 'The request took too long to respond.', 'ExpiringNonceReplay', 'fetch failed'])(
    'treats %j as ambiguous (null): the tx may still land',
    (text) => {
      expect(classifyChainError(text)).toBeNull()
    },
  )
})

describe('errorSummary', () => {
  it('collects shortMessage and details down the cause chain', () => {
    const e = { shortMessage: 'Missing or invalid parameters', cause: { details: 'keychain validation failed: AccountKeychainError(KeyExpired)' } }
    expect(errorSummary(e)).toBe('Missing or invalid parameters | keychain validation failed: AccountKeychainError(KeyExpired)')
    expect(errorSummary(new Error('plain'))).toBe('plain')
  })
})
