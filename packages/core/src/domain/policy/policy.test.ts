import { describe, expect, it } from 'vitest'
import type { Criteria, CriteriaEvidence } from '../proposal/criteria.js'
import { evaluateCriteria } from '../proposal/criteria.js'
import {
  type CompiledRule,
  canApprovePolicies,
  capLines,
  describeRule,
  describeMatch,
  matchReasons,
  nearMisses,
  previewWindow,
  runWindow,
  windowedCriteria,
} from './policy.js'
import type { Schedule } from './schedule.js'

const HELP = '700000000000000002'
const GENERAL = '700000000000000003'
const MODS = '400000000000000002'
const BOTS = '400000000000000009'
const APPROVER = '400000000000000001'
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const LI = '200000000000000003'
const DAVE = '200000000000000004'
const usd = (n: number) => BigInt(n) * 1_000_000n
const d = (iso: string) => new Date(iso)

const criteria = (over: Partial<Criteria> = {}): Criteria => ({
  hasRole: [],
  lacksRole: [],
  joinedBefore: null,
  joinedAfter: null,
  messagesIn: null,
  activeDaysIn: null,
  repliesIn: null,
  reactedTo: null,
  mentionedIn: null,
  postedIn: null,
  paidInRun: null,
  exclude: [],
  excludeProposer: false,
  ...over,
})
const window = (min: number, channelIds = [HELP]) => ({ channelIds, since: d('2026-10-01T00:00:00Z'), until: d('2026-10-07T00:00:00Z'), min })

/** "Every Monday: 1 per answered question in #help, max 50 a week each", for Mods. */
const helpDesk: CompiledRule = {
  criteria: criteria({ hasRole: [MODS], lacksRole: [BOTS], repliesIn: window(1) }),
  plan: { rule: { kind: 'perUnit', amount: usd(1), per: 'replies', cap: usd(50) }, overrides: [], perPersonCap: null },
  note: 'Help desk',
  assumptions: [],
  amountsInInstruction: true,
}
const mondays: Schedule = { kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC' }

describe('who may govern policies', () => {
  it('only a member holding the current approver role (Manage Server alone is not enough, and with no role set nobody is)', () => {
    expect(canApprovePolicies({ approverRoleId: APPROVER }, [APPROVER])).toBe(true)
    expect(canApprovePolicies({ approverRoleId: APPROVER }, [MODS])).toBe(false)
    expect(canApprovePolicies({ approverRoleId: null }, [APPROVER])).toBe(false)
  })
})

describe('the period a run covers', () => {
  it('a run counts activity from the previous occurrence up to its own', () => {
    expect(runWindow(mondays, d('2026-10-12T18:00:00Z'))).toEqual({ start: d('2026-10-05T18:00:00Z'), end: d('2026-10-12T18:00:00Z') })
  })

  it('never more than 31 days back, whatever the schedule', () => {
    const monthly: Schedule = { kind: 'monthly', day: 31, hour: 0, timezone: 'Europe/Lisbon' }
    // 31 October 00:00 Lisbon is 31 days and an hour after 30 September... the bound cuts the extra hour.
    const w = runWindow(monthly, d('2026-10-31T00:00:00Z'))
    expect(w.end.getTime() - w.start.getTime()).toBeLessThanOrEqual(31 * 86_400_000)
  })

  it('the preview counts the period in progress: from the last occurrence up to now', () => {
    expect(previewWindow(mondays, d('2026-10-14T10:00:00Z'))).toEqual({ start: d('2026-10-12T18:00:00Z'), end: d('2026-10-14T10:00:00Z'), nextRunAt: d('2026-10-19T18:00:00Z') })
  })

  it('every counting window of the compiled rule is moved onto the period (the channels and minimums stay)', () => {
    const c = criteria({ messagesIn: window(3, [GENERAL]), repliesIn: window(1), joinedBefore: d('2026-01-01T00:00:00Z') })
    const period = { start: d('2026-10-05T18:00:00Z'), end: d('2026-10-12T18:00:00Z') }
    expect(windowedCriteria(c, period)).toEqual({
      ...c,
      messagesIn: { channelIds: [GENERAL], since: period.start, until: period.end, min: 3 },
      repliesIn: { channelIds: [HELP], since: period.start, until: period.end, min: 1 },
    })
  })
})

describe('the policy cap per person', () => {
  it('cuts every line to the cap, overrides included, and marks it capped', () => {
    const lines = [
      { userId: ANA, amount: usd(80), capped: false, override: false },
      { userId: RUI, amount: usd(10), capped: false, override: false },
      { userId: LI, amount: usd(500), capped: false, override: true },
    ]
    expect(capLines(lines, usd(50))).toEqual([
      { userId: ANA, amount: usd(50), capped: true, override: false },
      { userId: RUI, amount: usd(10), capped: false, override: false },
      { userId: LI, amount: usd(50), capped: true, override: true },
    ])
    expect(capLines(lines, null)).toEqual(lines)
  })
})

describe('the rule in plain words', () => {
  it('says who, how much, when and the caps, with mentions for roles and channels', () => {
    expect(describeRule(helpDesk, { schedule: mondays, caps: { perRun: usd(500), perPerson: usd(40) } })).toEqual([
      '1 per reply to other people, at most 50 each.',
      `Who: has <@&${MODS}>; does not have <@&${BOTS}>; replied to other people at least once in <#${HELP}> during the period.`,
      'When: every Monday at 18:00 (UTC), counting activity since the previous run.',
      'Caps: at most 500 per run and 40 per person; a run over a cap or over the bot key budget is held whole, never paid in part.',
    ])
  })

  it('pools, flat amounts, overrides, anchors and exclusions', () => {
    const rule: CompiledRule = {
      criteria: criteria({
        reactedTo: { channelId: GENERAL, messageId: '810000000000000050', emoji: '✅' },
        exclude: [DAVE],
        excludeProposer: true,
        paidInRun: { last: true, runId: null },
        activeDaysIn: window(2, [GENERAL, HELP]),
      }),
      plan: { rule: { kind: 'pool', total: usd(100), splitBy: 'equal' }, overrides: [{ discordUserId: ANA, amount: usd(30) }], perPersonCap: usd(25) },
      note: null,
      assumptions: [],
      amountsInInstruction: true,
    }
    const GUILD = '1094309218049937418'
    const words = describeRule(rule, { schedule: mondays, caps: { perRun: null, perPerson: null }, money: (m) => `$${String(m / 1_000_000n)}`, guildId: GUILD })
    expect(words[0]).toBe(`$100 split equally, at most $25 each; <@${ANA}> gets $30.`)
    expect(words[1]).toBe(
      `Who: was active on at least 2 days in <#${GENERAL}>, <#${HELP}> during the period; reacted ✅ to https://discord.com/channels/${GUILD}/${GENERAL}/810000000000000050; was paid in the last paid run; never <@${DAVE}>; never the policy's author.`,
    )
    expect(words).toHaveLength(3)
  })
})

describe('why each person matches, and who is just below the line', () => {
  const c = criteria({ hasRole: [MODS], repliesIn: { channelIds: [HELP], since: d('2026-10-05T18:00:00Z'), until: d('2026-10-12T18:00:00Z'), min: 3 } })
  const reply = (authorId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ channelId: HELP, authorId, at: d(`2026-10-0${6 + (i % 3)}T10:00:00Z`), replyToAuthorId: DAVE }))
  const evidence: CriteriaEvidence = {
    messages: [...reply(ANA, 5), ...reply(RUI, 2), ...reply(LI, 9)],
    reactors: null,
    mentioned: null,
    threadPosters: null,
    paidUserIds: null,
    members: { [ANA]: { roleIds: [MODS], joinedAt: null }, [RUI]: { roleIds: [MODS], joinedAt: null }, [LI]: { roleIds: [], joinedAt: null }, [DAVE]: { roleIds: [MODS], joinedAt: null } },
  }
  const verdicts = evaluateCriteria(c, evidence, [ANA, RUI, LI, DAVE], APPROVER)

  it('a match is explained condition by condition, with the counts', () => {
    const ana = verdicts.find((v) => v.userId === ANA)
    expect(ana?.matched).toBe(true)
    const reasons = matchReasons(c, ana as (typeof verdicts)[number])
    expect(reasons).toEqual([
      { condition: 'hasRole', count: null, min: null },
      { condition: 'repliesIn', count: 5, min: 3 },
    ])
    expect(describeMatch(c, reasons)).toBe(`has <@&${MODS}>; 5 replies to other people in <#${HELP}> (at least 3)`)
  })

  it('a near miss failed only a count, and had some activity: Rui (2 of 3); Li is not a Mod and Dave has none', () => {
    expect(nearMisses(c, evidence, [ANA, RUI, LI, DAVE], APPROVER, verdicts)).toEqual([{ userId: RUI, condition: 'repliesIn', count: 2, min: 3 }])
  })
})
