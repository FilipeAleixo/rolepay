import { type Micros, type ParseAmountError, parseAmount } from '../money.js'
import type { Result } from '../result.js'

/**
 * A number written as digits: "50", "12.50", "10,000" (a comma only as a thousands separator),
 * optionally after "$". Not part of a word or token ("U2", "M1", "1st"), and not a long digit
 * run (a Discord ID is not an amount). "12,50" is ambiguous (a decimal comma, or a list?) and
 * states no amount: a line that needs it is held for the treasurer instead of guessed.
 */
const AMOUNT = /(?<![\w.]|\d,)\$?(\d{1,3}(?:,\d{3})+|\d{1,15})(\.\d+)?(?!\w|[.,]\d)/g

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'
/** A count with its unit ("10 replies", "7 days"), a percentage: a number, but not an amount. */
const COUNT_AFTER = /^\s*(?:replies|reply|messages?|days?|times?|hours?|weeks?|months?|years?|minutes?|people|persons?|members?|posts?|reactions?|answers?|questions?|threads?|issues?|prs?|commits?|bugs?|tickets?|points?|places?|percent)\b|^\s*%/i
/** Part of a date ("2026-10-01", "6/9"), or a day or year next to a month ("1 October", "October 2026"). */
const DATE_AFTER = new RegExp(`^(?:[-/]\\d|\\s*${MONTH}\\b)`, 'i')
const DATE_BEFORE = new RegExp(`(?:\\d[-/]|\\b${MONTH}\\s*)$`, 'i')
/** A rank or a reference: "top 3", "last 7", "#4521". */
const RANK_BEFORE = /(?:\b(?:top|first|last|past|next|issue|pr|no\.?)\s+|#)$/i

/**
 * Every amount a text states, in order, as micro-units. Numbers that are counts, dates, years
 * next to a month, ranks or references are not amounts ("10 replies", "2026-10-01", "October
 * 2026", "top 3", "#4521"), so a line cannot borrow them; zero and unreadable numbers are skipped.
 * When in doubt a number is left out: the line is then held for the treasurer, never paid on a guess.
 */
export function amountsIn(text: string): Micros[] {
  const out: Micros[] = []
  for (const m of text.matchAll(AMOUNT)) {
    const before = text.slice(0, m.index)
    const after = text.slice((m.index ?? 0) + m[0].length)
    if (COUNT_AFTER.test(after) || DATE_AFTER.test(after) || DATE_BEFORE.test(before) || RANK_BEFORE.test(before)) continue
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
