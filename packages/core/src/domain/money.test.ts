import { describe, expect, it } from 'vitest'
import { formatAmount, parseAmount, sumAmounts } from './money.js'

describe('parseAmount (decimal string to bigint micro-units, 6 decimals)', () => {
  it.each([
    ['1', 1_000_000n],
    ['2.5', 2_500_000n],
    ['0.000001', 1n],
    ['1.000001', 1_000_001n],
    ['1234567.89', 1_234_567_890_000n],
    ['007.5', 7_500_000n],
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toEqual({ ok: true, value: expected })
  })

  it('rejects more than 6 decimals instead of rounding', () => {
    expect(parseAmount('1.0000001')).toEqual({ ok: false, error: { code: 'too_many_decimals' } })
  })

  it.each(['', ' ', 'abc', '-1', '+1', '1e6', ' 1', '1 ', '1,000', '.5', '1.', '1.2.3', '0x10', 'NaN', 'Infinity'])(
    'rejects malformed input %j',
    (input) => {
      expect(parseAmount(input)).toEqual({ ok: false, error: { code: 'malformed' } })
    },
  )

  it.each(['0', '0.0', '0.000000'])('rejects zero %s (a payout must move money)', (input) => {
    expect(parseAmount(input)).toEqual({ ok: false, error: { code: 'not_positive' } })
  })
})

describe('formatAmount (bigint micro-units to decimal string)', () => {
  it.each([
    [1_500_000n, '1.5'],
    [1n, '0.000001'],
    [1_000_000n, '1'],
    [0n, '0'],
    [1_234_567_890_000n, '1234567.89'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatAmount(input)).toBe(expected)
  })

  it('pads to 6 decimals in fixed mode (accounting exports)', () => {
    expect(formatAmount(1_500_000n, { fixed: true })).toBe('1.500000')
    expect(formatAmount(0n, { fixed: true })).toBe('0.000000')
  })

  it('round-trips with parseAmount', () => {
    for (const s of ['1', '2.5', '0.000001', '99999999.999999']) {
      const parsed = parseAmount(s)
      expect(parsed.ok && formatAmount(parsed.value)).toBe(s)
    }
  })

  it('refuses negative amounts', () => {
    expect(() => formatAmount(-1n)).toThrow(RangeError)
  })
})

describe('sumAmounts', () => {
  it('sums exactly with no float drift', () => {
    expect(sumAmounts([100_000n, 200_000n])).toBe(300_000n)
    expect(sumAmounts([])).toBe(0n)
  })
})
