import { z } from 'zod'

/**
 * When a standing policy runs: weekly (a weekday and an hour) or monthly (a day and an hour), in
 * the community's IANA timezone (UTC by default). Daily (an hour) exists for the testnet demo
 * only: the policy and scheduler services refuse it unless the demo controls are on
 * (ROLEPAY_DEMO_CONTROLS, which config allows only on Moderato). Local times are turned into instants with the
 * runtime's timezone database (Intl), so daylight saving is handled: an hour that does not exist
 * (the spring gap) runs when the gap ends, and an hour that happens twice runs the first time.
 * Each run covers one period: from the previous occurrence to this one.
 */
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export function isTimezone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const TimezoneSchema = z.string().min(1).max(64).refine(isTimezone, 'not a timezone (use an IANA name such as Europe/Lisbon, or UTC)')
const Hour = z.number().int().min(0).max(23)

export const ScheduleSchema = z.discriminatedUnion('kind', [
  /** The testnet demo only (see above): the shape is the same everywhere, the services gate it. */
  z.object({ kind: z.literal('daily'), hour: Hour, timezone: TimezoneSchema.default('UTC') }),
  z.object({ kind: z.literal('weekly'), weekday: z.enum(WEEKDAYS), hour: Hour, timezone: TimezoneSchema.default('UTC') }),
  /** Days past the end of a shorter month run on its last day. */
  z.object({ kind: z.literal('monthly'), day: z.number().int().min(1).max(31), hour: Hour, timezone: TimezoneSchema.default('UTC') }),
])
export type Schedule = z.infer<typeof ScheduleSchema>

/**
 * Daily runs exist for the testnet demo (a judge paid by the next run with nobody online), never in
 * production: allowed only with the demo controls on, which config allows only on Moderato.
 */
export const scheduleAllowed = (s: Pick<Schedule, 'kind'>, opts: { demoControls: boolean }) => s.kind !== 'daily' || opts.demoControls

/**
 * Whether a period where nobody matched goes unannounced. A daily policy's empty days would be a
 * line in the channel every day (the judge demo waits most days for someone new), so only the
 * audit log records them; a weekly or monthly policy says so in one line.
 */
export const quietWhenEmpty = (s: Pick<Schedule, 'kind'>) => s.kind === 'daily'

/** A calendar date in the schedule's timezone. Month is 1-12. */
type LocalDate = { y: number; m: number; d: number }

const DAY_MS = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(tz, f)
  }
  return f
}

/** The wall clock in `tz` at instant `t`. */
function wall(t: Date, tz: string) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(t).map((p) => [p.type, p.value]))
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, min: Number(parts.minute), s: Number(parts.second) }
}

/** How far `tz` is ahead of UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  const w = wall(new Date(ms), tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000
}

/** The instant the wall clock in `tz` reads `date` at `hour`:00. Gap: when it ends. Overlap: the first time. */
function atLocal(date: LocalDate, hour: number, tz: string): Date {
  const guess = Date.UTC(date.y, date.m - 1, date.d, hour)
  const candidates = [...new Set([guess - offsetAt(guess, tz), guess - offsetAt(guess - offsetAt(guess, tz), tz)])].sort((a, b) => a - b)
  const exact = candidates.find((c) => {
    const w = wall(new Date(c), tz)
    return w.y === date.y && w.m === date.m && w.d === date.d && w.h === hour
  })
  return new Date(exact ?? (candidates.at(-1) as number))
}

const fromUtc = (ms: number): LocalDate => {
  const x = new Date(ms)
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }
}
const addDays = (date: LocalDate, n: number) => fromUtc(Date.UTC(date.y, date.m - 1, date.d) + n * DAY_MS)
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const weekdayOf = (date: LocalDate) => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay()

/** The occurrence's date `n` periods after (or before, n < 0) the one on `date`. */
function step(s: Schedule, date: LocalDate, n: number): LocalDate {
  if (s.kind === 'daily') return addDays(date, n)
  if (s.kind === 'weekly') return addDays(date, 7 * n)
  const index = date.y * 12 + (date.m - 1) + n
  const y = Math.floor(index / 12)
  const m = (index % 12) + 1
  return { y, m, d: Math.min(s.day, daysIn(y, m)) }
}

/** The date of the latest occurrence at or before `t`. */
function anchor(s: Schedule, t: Date): LocalDate {
  const w = wall(t, s.timezone)
  const today = { y: w.y, m: w.m, d: w.d }
  const date =
    s.kind === 'daily'
      ? today
      : s.kind === 'weekly'
        ? addDays(today, -((weekdayOf(today) - WEEKDAYS.indexOf(s.weekday) + 7) % 7))
        : { y: w.y, m: w.m, d: Math.min(s.day, daysIn(w.y, w.m)) }
  return atLocal(date, s.hour, s.timezone) > t ? step(s, date, -1) : date
}

/** The latest occurrence at or before `t`. */
export function occurrenceAtOrBefore(s: Schedule, t: Date): Date {
  return atLocal(anchor(s, t), s.hour, s.timezone)
}

/** The first occurrence strictly after `t`. */
export function nextOccurrence(s: Schedule, t: Date): Date {
  return atLocal(step(s, anchor(s, t), 1), s.hour, s.timezone)
}

/** The period a run at `occurrence` covers: from the occurrence before it, up to it. */
export function periodEnding(s: Schedule, occurrence: Date): { start: Date; end: Date } {
  return { start: atLocal(step(s, anchor(s, occurrence), -1), s.hour, s.timezone), end: occurrence }
}

/** One run per policy per period: the period's end as an ISO instant names it. */
export const periodKey = (occurrence: Date) => occurrence.toISOString()

const capital = (w: string) => w[0]?.toUpperCase() + w.slice(1)
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'daily') return `every day at ${hh(s.hour)} (${s.timezone})`
  if (s.kind === 'weekly') return `every ${capital(s.weekday)} at ${hh(s.hour)} (${s.timezone})`
  const short = s.day > 28 ? ' (the last day in shorter months)' : ''
  return `every month on day ${s.day}${short} at ${hh(s.hour)} (${s.timezone})`
}
