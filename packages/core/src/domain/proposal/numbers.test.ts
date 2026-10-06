import { describe, expect, it } from 'vitest'
import { amountsIn, parseLooseAmount } from './numbers.js'

describe('amountsIn (the amounts a text states, as micro-units)', () => {
  it('finds plain, decimal, thousands-separated and dollar amounts', () => {
    expect(amountsIn('50 each, the indexer one 200')).toEqual([50_000_000n, 200_000_000n])
    expect(amountsIn('pay 12.50 to @U2, $300 to @U3 and 10,000 to nobody')).toEqual([12_500_000n, 300_000_000n, 10_000_000_000n])
  })

  it('ignores tokens and parts of words (U2, M1, 1st), IDs and zero', () => {
    expect(amountsIn('@U2 and @U13 from M1 came 1st, id 200000000000000001, 0 each')).toEqual([])
  })

  it('keeps a full stop or a list comma after a number, and reads "12,50" as no amount rather than guessing', () => {
    expect(amountsIn('pay 40.')).toEqual([40_000_000n])
    expect(amountsIn('10, 20 and 30')).toEqual([10_000_000n, 20_000_000n, 30_000_000n])
    expect(amountsIn('12,50')).toEqual([])
  })
})

describe('amountsIn: numbers that are not amounts (counts, dates, years, references)', () => {
  it('skips counts with their unit, ranks and references', () => {
    expect(amountsIn('pay 20 to every Mod with 10 replies, 3 messages a day for 7 days, top 3, issue #4521, 2nd place, 10% more')).toEqual([20_000_000n])
  })

  it('skips dates and years next to a month', () => {
    expect(amountsIn('October 2026 bounties since 2026-10-01 and 6/9: 50 each')).toEqual([50_000_000n])
    expect(amountsIn('since 1 October, 5 each')).toEqual([5_000_000n])
  })

  it('keeps amounts next to money words and the demo phrasing', () => {
    expect(amountsIn('50 each, the indexer one 200, note: October bounties')).toEqual([50_000_000n, 200_000_000n])
    expect(amountsIn('split 300 between the winners, 25 AlphaUSD for docs, 1,000 USD pool')).toEqual([300_000_000n, 25_000_000n, 1_000_000_000n])
  })
})

describe('parseLooseAmount (an amount the model wrote)', () => {
  it.each([
    ['50', 50_000_000n],
    [' 50 ', 50_000_000n],
    ['$50', 50_000_000n],
    ['10,000', 10_000_000_000n],
    ['12.50', 12_500_000n],
  ])('reads %j', (input, expected) => {
    expect(parseLooseAmount(input)).toEqual({ ok: true, value: expected })
  })

  it.each(['fifty', '1e3', '-5', '5,00', '0', '', '1.0000001'])('refuses %j', (input) => {
    expect(parseLooseAmount(input).ok).toBe(false)
  })
})
