import type { Micros } from './money.js'
import type { Run } from './run.js'

/**
 * What paid runs sent, per UTC week (Monday 00:00 to Monday 00:00), split into runs a standing
 * policy made and runs made by hand. Pure: the service reads the runs and which of them a policy
 * made, this sums them. Money stays bigint micro-units of the payout token.
 */

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** Monday 00:00 UTC of the week `d` falls in. */
export function weekStartUtc(d: Date): Date {
  const sinceMonday = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday))
}

/** Monday 00:00 UTC of the first of `weeks` weeks that end with the week `now` falls in. */
export function firstWeekStart(now: Date, weeks: number): Date {
  if (!Number.isInteger(weeks) || weeks < 1) throw new RangeError('weeks must be a whole number of at least 1')
  return new Date(weekStartUtc(now).getTime() - (weeks - 1) * WEEK_MS)
}

/** What the sum needs from a run. */
export type PaidRunFacts = Pick<Run, 'id' | 'status' | 'token' | 'total' | 'paidAt'>

export type PaidWeek = {
  /** Monday 00:00 UTC. */
  start: Date
  /** Sent by runs a policy made. */
  policy: Micros
  /** Sent by runs made by hand (`/rolepay new`, an AI proposal a person turned into a run). */
  manual: Micros
  /** How many paid runs. */
  runs: number
  /** The week in progress: what it shows is so far, not the whole week. */
  partial: boolean
}

export type PaidByWeek = {
  /** Oldest first; the last one is the current week. */
  weeks: PaidWeek[]
  /** Monday 00:00 UTC of the first week. */
  since: Date
  total: Micros
  policy: Micros
  manual: Micros
  runs: number
}

/**
 * Sums paid runs into `weeks` UTC weeks ending with the current one (the week `now` falls in),
 * by when they were paid. Only `paid` runs in `token` count: a draft, a run waiting for approval,
 * one being paid, a failed or a cancelled run sent nothing (or nothing the chain has confirmed).
 * `policyRunIds` names the runs a policy made; every other run was made by hand. A week with no
 * paid run stays empty.
 */
export function paidByWeek(runs: readonly PaidRunFacts[], opts: { now: Date; weeks: number; token: string; policyRunIds: ReadonlySet<string> }): PaidByWeek {
  const since = firstWeekStart(opts.now, opts.weeks).getTime()
  const weeks: PaidWeek[] = Array.from({ length: opts.weeks }, (_, i) => ({ start: new Date(since + i * WEEK_MS), policy: 0n, manual: 0n, runs: 0, partial: i === opts.weeks - 1 }))
  const token = opts.token.toLowerCase()
  const out: PaidByWeek = { weeks, since: new Date(since), total: 0n, policy: 0n, manual: 0n, runs: 0 }
  for (const r of runs) {
    if (r.status !== 'paid' || r.paidAt === null || r.token.toLowerCase() !== token) continue
    const week = weeks[Math.floor((r.paidAt.getTime() - since) / WEEK_MS)]
    if (!week) continue
    const kind = opts.policyRunIds.has(r.id) ? 'policy' : 'manual'
    week[kind] += r.total
    week.runs++
    out[kind] += r.total
    out.total += r.total
    out.runs++
  }
  return out
}
