import { type Hex, type Log, encodeFunctionData, parseEventLogs } from 'viem'
import { Abis } from 'viem/tempo'
import type { Address } from '../../domain/ids.js'
import type { MemoTransfer } from '../../domain/reconcile.js'
import type { BatchTransfer, ChainRejectReason } from '../../ports/payoutChain.js'

export type Call = { to: Address; data: Hex }

/** One `transferWithMemo` call per line (ported from the spike's batch builder). */
export function buildBatchCalls(token: Address, transfers: BatchTransfer[]): Call[] {
  return transfers.map((t) => ({
    to: token,
    data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [t.to, t.amount, t.memo] }),
  }))
}

const lc = <T extends string>(s: T) => s.toLowerCase() as T

export function memoTransfersFromLogs(logs: readonly Log[]): MemoTransfer[] {
  return parseEventLogs({ abi: Abis.tip20, eventName: 'TransferWithMemo', logs: logs as Log[] }).map((l) => ({
    txHash: lc(l.transactionHash as Hex),
    blockNumber: l.blockNumber as bigint,
    token: lc(l.address),
    from: lc(l.args.from),
    to: lc(l.args.to),
    amount: l.args.amount,
    memo: lc(l.args.memo),
  }))
}

/**
 * Maps a node/sponsor error to a definitive refusal, or null when ambiguous (network,
 * timeouts, replays): ambiguous means the tx may still land before its validBefore.
 * Revoked and expired keys surface as "Missing or invalid parameters" with the real
 * cause only in `details` (seen on Moderato), so match on the whole summary.
 */
export function classifyChainError(text: string): ChainRejectReason | null {
  if (/KeyAlreadyRevoked/i.test(text)) return 'key_revoked'
  if (/KeyExpired/i.test(text)) return 'key_expired'
  if (/KeyNotFound/i.test(text)) return 'key_not_authorized'
  if (/SpendingLimitExceeded/i.test(text)) return 'spending_limit_exceeded'
  if (/CallNotAllowed/i.test(text)) return 'call_not_allowed'
  if (/InsufficientBalance|insufficient (funds|balance)/i.test(text)) return 'insufficient_balance'
  return null
}

/** The most informative message from a viem error chain (ported from the spike). */
export function errorSummary(error: unknown): string {
  const e = error as { shortMessage?: string; details?: string; message?: string; cause?: unknown }
  const parts = [e.shortMessage, e.details].filter((p): p is string => Boolean(p))
  let cause = e.cause as typeof e | undefined
  for (let i = 0; cause && i < 4; i++) {
    if (cause.shortMessage && !parts.includes(cause.shortMessage)) parts.push(cause.shortMessage)
    if (cause.details && !parts.includes(cause.details)) parts.push(cause.details)
    cause = cause.cause as typeof e | undefined
  }
  return (parts.length ? parts.join(' | ') : (e.message ?? String(error))).slice(0, 600)
}
