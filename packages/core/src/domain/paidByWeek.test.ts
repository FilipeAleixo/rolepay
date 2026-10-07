import { describe, expect, it } from 'vitest'
import { type PaidRunFacts, paidByWeek, weekStartUtc } from './paidByWeek.js'
import type { RunStatus } from './run.js'

const TOKEN = '0x20c0000000000000000000000000000000000001'
const OTHER_TOKEN = '0x20c0000000000000000000000000000000000002'
// Tuesday 2026-10-06 12:00 UTC: the current week started on Monday 2026-10-05.
const NOW = new Date('2026-10-06T12:00:00Z')

let n = 0
const run = (paidAt: string | null, total: bigint, over: { status?: RunStatus; token?: string; id?: string } = {}): PaidRunFacts => ({
  id: over.id ?? `run_${++n}`,
  status: over.status ?? 'paid',
  token: (over.token ?? TOKEN) as PaidRunFacts['token'],
  total,
  paidAt: paidAt === null ? null : new Date(paidAt),
})

const opts = (policyRunIds: string[] = []) => ({ now: NOW, weeks: 12, token: TOKEN, policyRunIds: new Set(policyRunIds) })

describe('weekStartUtc: UTC weeks start on Monday at 00:00', () => {
  it('is the Monday of the week, for any day and time in it', () => {
    expect(weekStartUtc(new Date('2026-10-05T00:00:00.000Z'))).toEqual(new Date('2026-10-05T00:00:00Z'))
    expect(weekStartUtc(new Date('2026-10-06T12:00:00Z'))).toEqual(new Date('2026-10-05T00:00:00Z'))
    expect(weekStartUtc(new Date('2026-10-11T23:59:59.999Z'))).toEqual(new Date('2026-10-05T00:00:00Z'))
    // A Sunday belongs to the week that started six days before; a Monday starts a new one.
    expect(weekStartUtc(new Date('2026-10-04T23:59:59.999Z'))).toEqual(new Date('2026-09-28T00:00:00Z'))
    expect(weekStartUtc(new Date('2026-10-12T00:00:00.000Z'))).toEqual(new Date('2026-10-12T00:00:00Z'))
    // Across a month and a year.
    expect(weekStartUtc(new Date('2027-01-01T09:00:00Z'))).toEqual(new Date('2026-12-28T00:00:00Z'))
  })
})

describe('paidByWeek: what paid runs sent, per UTC week', () => {
  it('with no runs: twelve empty weeks, oldest first, Mondays one week apart, the last one this week and partial', () => {
    const r = paidByWeek([], opts())
    expect(r.weeks).toHaveLength(12)
    expect(r.weeks[0]?.start).toEqual(new Date('2026-07-20T00:00:00Z'))
    expect(r.weeks[11]?.start).toEqual(new Date('2026-10-05T00:00:00Z'))
    for (const [i, w] of r.weeks.entries()) {
      expect(w.start.getUTCDay()).toBe(1)
      expect(w.start.getTime() - (r.weeks[0]?.start.getTime() ?? 0)).toBe(i * 7 * 86_400_000)
      expect(w).toMatchObject({ policy: 0n, manual: 0n, runs: 0, partial: i === 11 })
    }
    expect(r).toMatchObject({ total: 0n, policy: 0n, manual: 0n, runs: 0, since: new Date('2026-07-20T00:00:00Z') })
  })

  it('sums the runs paid in one week, exactly, in micro-units, and leaves the other weeks empty', () => {
    const r = paidByWeek([run('2026-09-29T10:00:00Z', 12_500_000n), run('2026-10-02T18:30:00Z', 1n), run('2026-09-28T00:00:00Z', 50_000_000n)], opts())
    const week = r.weeks.find((w) => w.start.getTime() === Date.parse('2026-09-28T00:00:00Z'))
    expect(week).toEqual({ start: new Date('2026-09-28T00:00:00Z'), policy: 0n, manual: 62_500_001n, runs: 3, partial: false })
    expect(r.weeks.filter((w) => w !== week).every((w) => w.runs === 0 && w.policy === 0n && w.manual === 0n)).toBe(true)
    expect(r).toMatchObject({ total: 62_500_001n, manual: 62_500_001n, policy: 0n, runs: 3 })
  })

  it('splits each week into runs a policy made and runs made by hand', () => {
    const byPolicy = run('2026-10-05T18:00:00Z', 62_000_000n, { id: 'run_policy' })
    const byHand = run('2026-10-06T09:00:00Z', 10_000_000n, { id: 'run_hand' })
    const r = paidByWeek([byPolicy, byHand], opts(['run_policy', 'run_elsewhere']))
    expect(r.weeks[11]).toEqual({ start: new Date('2026-10-05T00:00:00Z'), policy: 62_000_000n, manual: 10_000_000n, runs: 2, partial: true })
    expect(r).toMatchObject({ total: 72_000_000n, policy: 62_000_000n, manual: 10_000_000n, runs: 2 })
  })

  it('counts paid runs only: drafts, runs waiting for approval, approved, paying, failed and cancelled runs are left out', () => {
    const others: RunStatus[] = ['draft', 'pending_approval', 'approved', 'executing', 'failed', 'cancelled']
    const r = paidByWeek([...others.map((status) => run(null, 5_000_000n, { status })), run('2026-10-05T09:00:00Z', 7_000_000n, { status: 'failed' }), run('2026-10-05T10:00:00Z', 3_000_000n)], opts())
    expect(r).toMatchObject({ total: 3_000_000n, runs: 1 })
  })

  it('puts a run paid at Monday 00:00 UTC in the new week and one paid a millisecond before in the week before', () => {
    const r = paidByWeek([run('2026-10-05T00:00:00.000Z', 2_000_000n), run('2026-10-04T23:59:59.999Z', 1_000_000n)], opts())
    expect(r.weeks[11]).toMatchObject({ manual: 2_000_000n, runs: 1, partial: true })
    expect(r.weeks[10]).toMatchObject({ start: new Date('2026-09-28T00:00:00Z'), manual: 1_000_000n, runs: 1, partial: false })
  })

  it('leaves out runs paid before the first week or after this one, and runs in another token', () => {
    const r = paidByWeek(
      [
        run('2026-07-19T23:59:59.999Z', 1_000_000n),
        run('2026-07-20T00:00:00.000Z', 2_000_000n),
        run('2026-10-12T00:00:00.000Z', 4_000_000n),
        run('2026-10-06T08:00:00Z', 8_000_000n, { token: OTHER_TOKEN }),
        run('2026-10-06T09:00:00Z', 16_000_000n, { token: TOKEN.toUpperCase().replace('0X', '0x') }),
      ],
      opts(),
    )
    expect(r.weeks[0]).toMatchObject({ manual: 2_000_000n, runs: 1 })
    expect(r.weeks[11]).toMatchObject({ manual: 16_000_000n, runs: 1 })
    expect(r).toMatchObject({ total: 18_000_000n, runs: 2 })
  })

  it('takes any number of weeks, the current one always last', () => {
    const r = paidByWeek([run('2026-10-06T09:00:00Z', 1_000_000n)], { ...opts(), weeks: 1 })
    expect(r.weeks).toEqual([{ start: new Date('2026-10-05T00:00:00Z'), policy: 0n, manual: 1_000_000n, runs: 1, partial: true }])
    expect(() => paidByWeek([], { ...opts(), weeks: 0 })).toThrow(RangeError)
  })
})
