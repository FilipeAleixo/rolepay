import { TOKEN_DECIMALS } from '../constants/token.js'
import { type Result, err, ok } from './result.js'

/**
 * Money is a bigint count of micro-units (10^-6 of one token). Never a float.
 * Parsing is strict: no signs, exponents, separators, or silent rounding.
 */
export type Micros = bigint

export type ParseAmountError = { code: 'malformed' | 'too_many_decimals' | 'not_positive' }

const SCALE = 10n ** BigInt(TOKEN_DECIMALS)
const DECIMAL = /^(\d+)(?:\.(\d+))?$/

export function parseAmount(input: string): Result<Micros, ParseAmountError> {
  const m = DECIMAL.exec(input)
  if (!m) return err({ code: 'malformed' })
  const whole = m[1] as string
  const frac = m[2] ?? ''
  if (frac.length > TOKEN_DECIMALS) return err({ code: 'too_many_decimals' })
  const value = BigInt(whole) * SCALE + BigInt(frac.padEnd(TOKEN_DECIMALS, '0'))
  if (value === 0n) return err({ code: 'not_positive' })
  return ok(value)
}

export function formatAmount(micros: Micros, opts: { fixed?: boolean } = {}): string {
  if (micros < 0n) throw new RangeError('amounts are never negative')
  const whole = micros / SCALE
  const frac = (micros % SCALE).toString().padStart(TOKEN_DECIMALS, '0')
  if (opts.fixed) return `${whole}.${frac}`
  const trimmed = frac.replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : `${whole}`
}

/**
 * Money for people to read: formatAmount with the whole part grouped by commas ("999,995",
 * "1,234,567.89"), up to 6 decimals trimmed. Only for display (Discord embeds, the dashboard, the
 * web pages): parseAmount refuses it, so CSV, memos, JSON and anything machine-read use formatAmount.
 */
export function displayAmount(micros: Micros): string {
  const [whole, frac] = formatAmount(micros).split('.') as [string, string | undefined]
  const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',')
  return frac ? `${grouped}.${frac}` : grouped
}

export function sumAmounts(amounts: readonly Micros[]): Micros {
  return amounts.reduce((a, b) => a + b, 0n)
}
