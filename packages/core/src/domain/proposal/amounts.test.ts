import { describe, expect, it } from 'vitest'
import { type AmountPlan, applyAmountPlan, splitPool } from './amounts.js'

const A = '200000000000000001'
const B = '200000000000000002'
const C = '200000000000000003'
const usd = (n: number) => BigInt(n) * 1_000_000n
const metrics = (messages: number | null, activeDays: number | null = null, replies: number | null = null) => ({ messages, activeDays, replies })
const plan = (rule: AmountPlan['rule'], over: Partial<AmountPlan> = {}): AmountPlan => ({ rule, overrides: [], perPersonCap: null, ...over })
const amounts = (r: ReturnType<typeof applyAmountPlan>) => (r.ok ? Object.fromEntries(r.value.map((x) => [x.userId, x.amount])) : r.error)

describe('splitPool (deterministic rounding: the total is always exact)', () => {
  it('splits by weight, flooring each share to the micro-unit', () => {
    expect(splitPool(usd(100), [{ userId: A, weight: 3n }, { userId: B, weight: 1n }])).toEqual([
      { userId: A, amount: usd(75) },
      { userId: B, amount: usd(25) },
    ])
  })

  it('gives the leftover micro-units one each to the largest remainders, ties by Discord user ID ascending', () => {
    // 1 micro-unit over 3 equal people: 0 each plus a remainder of 1/3 each; the lowest ID gets it.
    expect(splitPool(1n, [{ userId: C, weight: 1n }, { userId: A, weight: 1n }, { userId: B, weight: 1n }])).toEqual([
      { userId: C, amount: 0n },
      { userId: A, amount: 1n },
      { userId: B, amount: 0n },
    ])
    // 100 over 3 equal people: 33.333333 each, 1 micro-unit left, to A (lowest ID).
    const split = splitPool(usd(100), [{ userId: B, weight: 1n }, { userId: A, weight: 1n }, { userId: C, weight: 1n }])
    expect(split).toEqual([
      { userId: B, amount: 33_333_333n },
      { userId: A, amount: 33_333_334n },
      { userId: C, amount: 33_333_333n },
    ])
    expect(split.reduce((s, x) => s + x.amount, 0n)).toBe(usd(100))
  })

  it('a larger remainder wins over a lower ID', () => {
    // 10 micro-units by weights 1 and 2: 3.33 and 6.66; B has the larger remainder (2/3 > 1/3).
    expect(splitPool(10n, [{ userId: A, weight: 1n }, { userId: B, weight: 2n }])).toEqual([
      { userId: A, amount: 3n },
      { userId: B, amount: 7n },
    ])
  })

  it('people with no weight get nothing, and with no weight at all nobody does', () => {
    expect(splitPool(usd(10), [{ userId: A, weight: 0n }, { userId: B, weight: 5n }])).toEqual([
      { userId: A, amount: 0n },
      { userId: B, amount: usd(10) },
    ])
    expect(splitPool(usd(10), [{ userId: A, weight: 0n }])).toEqual([{ userId: A, amount: 0n }])
  })

  it('is exact for any total and weights (property check)', () => {
    for (let total = 1n; total < 400n; total += 37n) {
      const people = [7n, 0n, 13n, 1n, 1n].map((weight, i) => ({ userId: `20000000000000000${i}`, weight }))
      expect(splitPool(total, people).reduce((s, x) => s + x.amount, 0n)).toBe(total)
    }
  })
})

describe('applyAmountPlan', () => {
  const people = [
    { userId: A, metrics: metrics(34, 9, 12) },
    { userId: B, metrics: metrics(10, 2, 0) },
  ]

  it('flat: everyone gets the amount', () => {
    expect(amounts(applyAmountPlan(plan({ kind: 'flat', amount: usd(20) }), people))).toEqual({ [A]: usd(20), [B]: usd(20) })
  })

  it('perUnit: amount times the metric, capped per person by the rule', () => {
    expect(amounts(applyAmountPlan(plan({ kind: 'perUnit', amount: usd(1), per: 'messages', cap: null }), people))).toEqual({ [A]: usd(34), [B]: usd(10) })
    const capped = applyAmountPlan(plan({ kind: 'perUnit', amount: usd(1), per: 'messages', cap: usd(25) }), people)
    expect(amounts(capped)).toEqual({ [A]: usd(25), [B]: usd(10) })
    expect(capped.ok && capped.value.map((x) => x.capped)).toEqual([true, false])
    // Zero units: zero amount, left for the caller to drop.
    expect(amounts(applyAmountPlan(plan({ kind: 'perUnit', amount: usd(2), per: 'replies', cap: null }), people))).toEqual({ [A]: usd(24), [B]: 0n })
  })

  it('pool: split by the metric or equally', () => {
    expect(amounts(applyAmountPlan(plan({ kind: 'pool', total: usd(88), splitBy: 'activeDays' }), people))).toEqual({ [A]: usd(72), [B]: usd(16) })
    expect(amounts(applyAmountPlan(plan({ kind: 'pool', total: usd(50), splitBy: 'equal' }), people))).toEqual({ [A]: usd(25), [B]: usd(25) })
  })

  it('overrides replace the computed amount; in a pool they come out of the total first', () => {
    const flat = plan({ kind: 'flat', amount: usd(50) }, { overrides: [{ discordUserId: B, amount: usd(200) }] })
    expect(amounts(applyAmountPlan(flat, people))).toEqual({ [A]: usd(50), [B]: usd(200) })
    const pool = plan({ kind: 'pool', total: usd(100), splitBy: 'equal' }, { overrides: [{ discordUserId: B, amount: usd(40) }] })
    expect(amounts(applyAmountPlan(pool, [...people, { userId: C, metrics: metrics(1) }]))).toEqual({ [A]: usd(30), [B]: usd(40), [C]: usd(30) })
  })

  it('overrides for people who did not match pay nobody (the filter decides who is paid)', () => {
    const r = applyAmountPlan(plan({ kind: 'flat', amount: usd(5) }, { overrides: [{ discordUserId: C, amount: usd(999) }] }), people)
    expect(amounts(r)).toEqual({ [A]: usd(5), [B]: usd(5) })
  })

  it('refuses overrides larger than the pool', () => {
    const r = applyAmountPlan(plan({ kind: 'pool', total: usd(10), splitBy: 'equal' }, { overrides: [{ discordUserId: A, amount: usd(11) }] }), people)
    expect(r).toEqual({ ok: false, error: { code: 'overrides_exceed_pool' } })
  })

  it('the per-person cap limits computed amounts, not explicit overrides', () => {
    const r = applyAmountPlan(plan({ kind: 'perUnit', amount: usd(1), per: 'messages', cap: null }, { perPersonCap: usd(15), overrides: [{ discordUserId: B, amount: usd(30) }] }), people)
    expect(amounts(r)).toEqual({ [A]: usd(15), [B]: usd(30) })
    expect(r.ok && r.value.map((x) => ({ capped: x.capped, override: x.override }))).toEqual([
      { capped: true, override: false },
      { capped: false, override: true },
    ])
  })

  it('a rule on a metric nobody was counted on is refused, not treated as zero', () => {
    const r = applyAmountPlan(plan({ kind: 'perUnit', amount: usd(1), per: 'replies', cap: null }), [{ userId: A, metrics: metrics(3) }])
    expect(r).toEqual({ ok: false, error: { code: 'metric_missing', metric: 'replies' } })
  })
})
