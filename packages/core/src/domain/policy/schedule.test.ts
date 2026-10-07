import { describe, expect, it } from 'vitest'
import { type Schedule, ScheduleSchema, describeSchedule, isTimezone, nextOccurrence, occurrenceAtOrBefore, periodEnding, periodKey } from './schedule.js'

const weekly = (over: Partial<Extract<Schedule, { kind: 'weekly' }>> = {}): Schedule => ({ kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC', ...over })
const monthly = (over: Partial<Extract<Schedule, { kind: 'monthly' }>> = {}): Schedule => ({ kind: 'monthly', day: 1, hour: 9, timezone: 'UTC', ...over })
const d = (iso: string) => new Date(iso)

describe('schedule: the shape', () => {
  it('accepts weekly (weekday and hour) and monthly (day and hour) in an IANA timezone, UTC by default', () => {
    expect(ScheduleSchema.parse({ kind: 'weekly', weekday: 'monday', hour: 18 })).toEqual(weekly())
    expect(ScheduleSchema.parse({ kind: 'monthly', day: 31, hour: 0, timezone: 'Europe/Lisbon' })).toEqual(monthly({ day: 31, hour: 0, timezone: 'Europe/Lisbon' }))
  })

  it('refuses an unknown timezone, an hour past 23 and a day past 31', () => {
    expect(ScheduleSchema.safeParse({ kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(ScheduleSchema.safeParse({ kind: 'weekly', weekday: 'monday', hour: 24 }).success).toBe(false)
    expect(ScheduleSchema.safeParse({ kind: 'monthly', day: 32, hour: 9 }).success).toBe(false)
    expect(ScheduleSchema.safeParse({ kind: 'monthly', day: 0, hour: 9 }).success).toBe(false)
    expect(isTimezone('America/New_York')).toBe(true)
    expect(isTimezone('')).toBe(false)
  })

  it('says itself in plain words', () => {
    expect(describeSchedule(weekly())).toBe('every Monday at 18:00 (UTC)')
    expect(describeSchedule(monthly({ day: 31, timezone: 'Europe/Lisbon' }))).toBe('every month on day 31 (the last day in shorter months) at 09:00 (Europe/Lisbon)')
    expect(describeSchedule(monthly({ day: 15 }))).toBe('every month on day 15 at 09:00 (UTC)')
  })
})

describe('schedule: weekly in UTC', () => {
  // 2026-10-12 is a Monday.
  it('the occurrence at or before a moment, and the next one strictly after it', () => {
    const s = weekly()
    expect(occurrenceAtOrBefore(s, d('2026-10-14T10:00:00Z'))).toEqual(d('2026-10-12T18:00:00Z'))
    expect(nextOccurrence(s, d('2026-10-14T10:00:00Z'))).toEqual(d('2026-10-19T18:00:00Z'))
    // Earlier on the Monday itself: the previous Monday, and today's is next.
    expect(occurrenceAtOrBefore(s, d('2026-10-12T17:59:59Z'))).toEqual(d('2026-10-05T18:00:00Z'))
    expect(nextOccurrence(s, d('2026-10-12T17:59:59Z'))).toEqual(d('2026-10-12T18:00:00Z'))
    // Exactly on it: that one is "at or before", the next is a week later.
    expect(occurrenceAtOrBefore(s, d('2026-10-12T18:00:00Z'))).toEqual(d('2026-10-12T18:00:00Z'))
    expect(nextOccurrence(s, d('2026-10-12T18:00:00Z'))).toEqual(d('2026-10-19T18:00:00Z'))
  })

  it('a Sunday evening is followed by Monday, not by the Monday after', () => {
    expect(nextOccurrence(weekly(), d('2026-10-11T23:00:00Z'))).toEqual(d('2026-10-12T18:00:00Z'))
  })

  it('a period runs from the previous occurrence to this one, keyed by its end', () => {
    expect(periodEnding(weekly(), d('2026-10-12T18:00:00Z'))).toEqual({ start: d('2026-10-05T18:00:00Z'), end: d('2026-10-12T18:00:00Z') })
    expect(periodKey(d('2026-10-12T18:00:00Z'))).toBe('2026-10-12T18:00:00.000Z')
  })
})

describe('schedule: timezones and daylight saving', () => {
  it('Monday 18:00 in Lisbon is 17:00 UTC in summer time and 18:00 UTC in winter', () => {
    const s = weekly({ timezone: 'Europe/Lisbon' })
    expect(nextOccurrence(s, d('2026-10-14T00:00:00Z'))).toEqual(d('2026-10-19T17:00:00Z'))
    // Clocks go back on 25 October 2026: the period spanning it is a week and an hour long.
    expect(nextOccurrence(s, d('2026-10-20T00:00:00Z'))).toEqual(d('2026-10-26T18:00:00Z'))
    expect(periodEnding(s, d('2026-10-26T18:00:00Z'))).toEqual({ start: d('2026-10-19T17:00:00Z'), end: d('2026-10-26T18:00:00Z') })
  })

  it('a local time that does not exist (the spring gap) runs when the gap ends', () => {
    // New York skips 02:00-03:00 on Sunday 8 March 2026.
    const s = weekly({ weekday: 'sunday', hour: 2, timezone: 'America/New_York' })
    expect(nextOccurrence(s, d('2026-03-05T00:00:00Z'))).toEqual(d('2026-03-08T07:00:00Z')) // 03:00 EDT
    expect(nextOccurrence(s, d('2026-03-08T07:00:00Z'))).toEqual(d('2026-03-15T06:00:00Z')) // 02:00 EDT
  })

  it('a local time that happens twice (the autumn overlap) runs once, the first time', () => {
    // New York repeats 01:00-02:00 on Sunday 1 November 2026.
    const s = weekly({ weekday: 'sunday', hour: 1, timezone: 'America/New_York' })
    const first = nextOccurrence(s, d('2026-10-30T00:00:00Z'))
    expect(first).toEqual(d('2026-11-01T05:00:00Z')) // 01:00 EDT
    expect(nextOccurrence(s, first)).toEqual(d('2026-11-08T06:00:00Z')) // 01:00 EST, a week and an hour later
  })

  it('east of UTC the local day can be the day before in UTC', () => {
    const s = weekly({ weekday: 'monday', hour: 3, timezone: 'Asia/Tokyo' })
    expect(nextOccurrence(s, d('2026-10-14T00:00:00Z'))).toEqual(d('2026-10-18T18:00:00Z')) // Monday 03:00 JST = Sunday 18:00 UTC
  })
})

describe('schedule: monthly', () => {
  it('runs on its day, and on the last day of months too short for it', () => {
    const s = monthly({ day: 31, hour: 9 })
    expect(nextOccurrence(s, d('2026-10-31T09:00:00Z'))).toEqual(d('2026-11-30T09:00:00Z'))
    expect(nextOccurrence(s, d('2027-01-31T09:00:00Z'))).toEqual(d('2027-02-28T09:00:00Z'))
    expect(nextOccurrence(s, d('2028-01-31T09:00:00Z'))).toEqual(d('2028-02-29T09:00:00Z'))
    expect(occurrenceAtOrBefore(s, d('2026-11-15T00:00:00Z'))).toEqual(d('2026-10-31T09:00:00Z'))
    expect(periodEnding(s, d('2026-11-30T09:00:00Z'))).toEqual({ start: d('2026-10-31T09:00:00Z'), end: d('2026-11-30T09:00:00Z') })
  })

  it('crosses the year', () => {
    const s = monthly({ day: 1, hour: 0, timezone: 'Europe/Lisbon' })
    expect(nextOccurrence(s, d('2026-12-15T00:00:00Z'))).toEqual(d('2027-01-01T00:00:00Z'))
    expect(occurrenceAtOrBefore(s, d('2026-12-31T23:59:59Z'))).toEqual(d('2026-12-01T00:00:00Z'))
  })
})

describe('schedule: daily (the testnet demo controls only; the services refuse it elsewhere)', () => {
  const daily = (over: Partial<Extract<Schedule, { kind: 'daily' }>> = {}): Schedule => ({ kind: 'daily', hour: 18, timezone: 'UTC', ...over })

  it('is an hour in an IANA timezone, UTC by default, and says itself in plain words', () => {
    expect(ScheduleSchema.parse({ kind: 'daily', hour: 18 })).toEqual(daily())
    expect(ScheduleSchema.safeParse({ kind: 'daily', hour: 24 }).success).toBe(false)
    expect(ScheduleSchema.safeParse({ kind: 'daily', hour: 18, timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(describeSchedule(daily())).toBe('every day at 18:00 (UTC)')
    expect(describeSchedule(daily({ hour: 9, timezone: 'Europe/Lisbon' }))).toBe('every day at 09:00 (Europe/Lisbon)')
  })

  it('the occurrence at or before a moment is today at the hour once it has passed, else yesterday; the next is strictly after', () => {
    const s = daily()
    expect(occurrenceAtOrBefore(s, d('2026-10-14T10:00:00Z'))).toEqual(d('2026-10-13T18:00:00Z'))
    expect(nextOccurrence(s, d('2026-10-14T10:00:00Z'))).toEqual(d('2026-10-14T18:00:00Z'))
    expect(occurrenceAtOrBefore(s, d('2026-10-14T18:00:00Z'))).toEqual(d('2026-10-14T18:00:00Z'))
    expect(nextOccurrence(s, d('2026-10-14T18:00:00Z'))).toEqual(d('2026-10-15T18:00:00Z'))
    expect(occurrenceAtOrBefore(s, d('2026-10-14T17:59:59Z'))).toEqual(d('2026-10-13T18:00:00Z'))
  })

  it('a period is the day since the previous occurrence, and each day has its own key (one run per policy per day)', () => {
    const s = daily()
    expect(periodEnding(s, d('2026-10-14T18:00:00Z'))).toEqual({ start: d('2026-10-13T18:00:00Z'), end: d('2026-10-14T18:00:00Z') })
    const keys = ['2026-10-14T18:00:00Z', '2026-10-14T23:00:00Z', '2026-10-15T17:59:59Z'].map((t) => periodKey(occurrenceAtOrBefore(s, d(t))))
    expect(keys).toEqual(['2026-10-14T18:00:00.000Z', '2026-10-14T18:00:00.000Z', '2026-10-14T18:00:00.000Z'])
    expect(periodKey(occurrenceAtOrBefore(s, d('2026-10-15T18:00:00Z')))).toBe('2026-10-15T18:00:00.000Z')
  })

  it('crosses months and years', () => {
    expect(nextOccurrence(daily({ hour: 0 }), d('2026-12-31T12:00:00Z'))).toEqual(d('2027-01-01T00:00:00Z'))
    expect(occurrenceAtOrBefore(daily(), d('2026-11-01T06:00:00Z'))).toEqual(d('2026-10-31T18:00:00Z'))
  })

  it('in a timezone, across daylight saving: the period spanning the change is 25 hours, and the gap and overlap run once', () => {
    const lisbon = daily({ timezone: 'Europe/Lisbon' })
    expect(nextOccurrence(lisbon, d('2026-10-24T12:00:00Z'))).toEqual(d('2026-10-24T17:00:00Z'))
    // Clocks go back on 25 October 2026.
    expect(periodEnding(lisbon, d('2026-10-25T18:00:00Z'))).toEqual({ start: d('2026-10-24T17:00:00Z'), end: d('2026-10-25T18:00:00Z') })
    // New York skips 02:00-03:00 on 8 March 2026 and repeats 01:00-02:00 on 1 November 2026.
    const gap = daily({ hour: 2, timezone: 'America/New_York' })
    expect(nextOccurrence(gap, d('2026-03-08T05:00:00Z'))).toEqual(d('2026-03-08T07:00:00Z')) // 03:00 EDT
    expect(nextOccurrence(gap, d('2026-03-08T07:00:00Z'))).toEqual(d('2026-03-09T06:00:00Z')) // 02:00 EDT
    const overlap = daily({ hour: 1, timezone: 'America/New_York' })
    const first = nextOccurrence(overlap, d('2026-10-31T12:00:00Z'))
    expect(first).toEqual(d('2026-11-01T05:00:00Z')) // 01:00 EDT
    expect(nextOccurrence(overlap, first)).toEqual(d('2026-11-02T06:00:00Z')) // 01:00 EST, the next day
  })
})
