import type { Hex } from './hex.js'
import type { Address } from './ids.js'
import type { Micros } from './money.js'
import type { Run, RunLine } from './run.js'

/** One `TransferWithMemo` event as read from the chain. */
export type MemoTransfer = {
  txHash: Hex
  blockNumber: bigint
  token: Address
  from: Address
  to: Address
  amount: Micros
  memo: Hex
}

export type MatchResult =
  | { kind: 'none' }
  | { kind: 'all_paid'; txHash: Hex; blockNumber: bigint }
  | { kind: 'partial'; paidLines: number[]; missingLines: number[] }
  | { kind: 'mismatch'; detail: string }

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The token a line is delivered in: the run's, or the stablecoin a swapped line buys. */
export const lineToken = (run: Pick<Run, 'token'>, line: Pick<RunLine, 'swap'>): Address => line.swap?.token ?? run.token

/** Every token the run's lines are delivered in, the run's token first: where its memo transfers are. */
export function runTokens(run: Pick<Run, 'token' | 'lines'>): Address[] {
  const tokens = [run.token]
  for (const l of run.lines) if (!tokens.some((t) => same(t, lineToken(run, l)))) tokens.push(lineToken(run, l))
  return tokens
}

/**
 * The chain is the source of truth for "was this run paid?". Memos are public, so
 * anyone can emit one: only transfers FROM the treasury in one of the run's tokens count.
 * Each line must be paid in its own token (a swapped line in the stablecoin it delivers):
 * its memo in another of the run's tokens is a mismatch, for a human to look at.
 */
export function matchTransfers(run: Run, treasury: Address, transfers: readonly MemoTransfer[]): MatchResult {
  const tokens = runTokens(run)
  const ours = transfers.filter((t) => same(t.from, treasury) && tokens.some((token) => same(t.token, token)))
  const byMemo = new Map<string, MemoTransfer[]>()
  for (const t of ours) {
    const key = t.memo.toLowerCase()
    byMemo.set(key, [...(byMemo.get(key) ?? []), t])
  }

  const paid: number[] = []
  const missing: number[] = []
  let latest: MemoTransfer | undefined
  for (const line of run.lines) {
    const hits = byMemo.get(line.memo.toLowerCase()) ?? []
    if (hits.length === 0) {
      missing.push(line.line)
      continue
    }
    if (hits.length > 1) return { kind: 'mismatch', detail: `line ${line.line} paid ${hits.length} times` }
    const hit = hits[0] as MemoTransfer
    if (!same(hit.token, lineToken(run, line))) return { kind: 'mismatch', detail: `line ${line.line} paid in ${hit.token}, expected ${lineToken(run, line)}` }
    if (!same(hit.to, line.address) || hit.amount !== line.amount)
      return { kind: 'mismatch', detail: `line ${line.line} paid ${hit.amount} to ${hit.to}, expected ${line.amount} to ${line.address}` }
    paid.push(line.line)
    if (!latest || hit.blockNumber > latest.blockNumber) latest = hit
  }

  if (paid.length === 0) return { kind: 'none' }
  if (missing.length > 0) return { kind: 'partial', paidLines: paid, missingLines: missing }
  const last = latest as MemoTransfer
  return { kind: 'all_paid', txHash: last.txHash, blockNumber: last.blockNumber }
}
