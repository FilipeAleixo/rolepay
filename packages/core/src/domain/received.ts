import type { Address } from './ids.js'
import { lineToken } from './reconcile.js'
import type { Run } from './run.js'

/** One line of a paid run, as the person it paid sees it: what arrived, in which token, from which run. */
export type ReceivedLine = {
  guildId: string
  runId: string
  line: number
  /** Bigint micro-units of `token` (for a swapped line, what was delivered). */
  amount: bigint
  token: Address
  txHash: string | null
  paidAt: Date
}

/** The lines of a paid run that paid `address` (compared in lowercase). Nothing for a run that is not paid. */
export function linesPaidTo(run: Run, address: string): ReceivedLine[] {
  const paidAt = run.paidAt
  if (run.status !== 'paid' || !paidAt) return []
  const to = address.toLowerCase()
  return run.lines
    .filter((l) => l.address.toLowerCase() === to)
    .map((l) => ({ guildId: run.communityId, runId: run.id, line: l.line, amount: l.amount, token: lineToken(run, l), txHash: run.paidTxHash, paidAt }))
}
