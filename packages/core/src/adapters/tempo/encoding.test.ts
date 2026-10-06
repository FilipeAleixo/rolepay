import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Log } from 'viem'
import { Abis } from 'viem/tempo'
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
