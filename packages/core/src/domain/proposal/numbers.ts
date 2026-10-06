import { type Micros, type ParseAmountError, parseAmount } from '../money.js'
import type { Result } from '../result.js'

/**
 * A number written as digits: "50", "12.50", "10,000" (a comma only as a thousands separator),
 * optionally after "$". Not part of a word or token ("U2", "M1", "1st"), and not a long digit
 * run (a Discord ID is not an amount). "12,50" is ambiguous (a decimal comma, or a list?) and
 * states no amount: a line that needs it is held for the treasurer instead of guessed.
 */
const AMOUNT = /(?<![\w.]|\d,)\$?(\d{1,3}(?:,\d{3})+|\d{1,15})(\.\d+)?(?!\w|[.,]\d)/g

/** Every amount a text states, in order, as micro-units. Zero and unreadable numbers are skipped. */
export function amountsIn(text: string): Micros[] {
  const out: Micros[] = []
  for (const m of text.matchAll(AMOUNT)) {
    const parsed = parseAmount(`${(m[1] as string).replaceAll(',', '')}${m[2] ?? ''}`)
    if (parsed.ok) out.push(parsed.value)
  }
  return out
}

/** An amount the model wrote: digits with an optional "$", spaces around and thousands separators. */
export function parseLooseAmount(input: string): Result<Micros, ParseAmountError> {
  const s = input.trim().replace(/^\$/, '')
  return parseAmount(/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s) ? s.replaceAll(',', '') : s)
}
