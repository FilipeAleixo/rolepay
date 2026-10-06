import { describe, expect, it } from 'vitest'
import { type Criteria, type CriteriaEvidence, type ScannedMessage, evaluateCriteria, needsMembers, resolveCriteria, scanPlan, seenUsers } from './criteria.js'
import type { RawCriteriaProposal } from './raw.js'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const HELP = '700000000000000001'
const GENERAL = '700000000000000002'
const THREAD = '700000000000000003'
const MODS = '400000000000000002'
const ADMINS = '400000000000000004'
const A = '200000000000000001'
const B = '200000000000000002'
const C = '200000000000000003'
const ME = '300000000000000001'
const MSG = { channelId: GENERAL, messageId: '810000000000000009' }
const usd = (n: number) => BigInt(n) * 1_000_000n
const refs = {
  users: { U1: C },
  roles: { R1: '400000000000000001', R2: MODS, R3: ADMINS },
  channels: { C1: HELP, C2: GENERAL, C3: THREAD },
  messages: { M1: MSG },
  emojis: { ':pepe:': '<:pepe:123456789012345678>' },
}

const raw = (over: Partial<RawCriteriaProposal> = {}, conditions: Partial<RawCriteriaProposal['conditions']> = {}): RawCriteriaProposal => ({
  understood: true,
  problem: null,
  conditions: {
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
    ...conditions,
  },
  exclude: [],
  excludeProposer: false,
  amount: { kind: 'flat', amount: '20', per: null, cap: null, total: null, splitBy: null },
  overrides: [],
  perPersonCap: null,
  note: null,
  assumptions: [],
  ...over,
})
const resolve = (r: RawCriteriaProposal, amounts = [usd(20)]) => resolveCriteria(r, { refs, now: NOW, instructionAmounts: amounts })

describe('resolveCriteria (the model writes the filter, code checks it)', () => {
  it('maps tokens to Discord IDs and dates to a window that ends now', () => {
    const r = resolve(raw({ exclude: ['U1'], excludeProposer: true }, { hasRole: ['R2'], repliesIn: { channels: ['C1'], since: '2026-09-06', until: null, min: 10 } }))
    expect(r).toMatchObject({
      ok: true,
      value: {
        criteria: { hasRole: [MODS], repliesIn: { channelIds: [HELP], since: new Date('2026-09-06T00:00:00Z'), until: NOW, min: 10 }, exclude: [C], excludeProposer: true },
        plan: { rule: { kind: 'flat', amount: usd(20) }, overrides: [], perPersonCap: null },
        lookbackClamped: false,
        amountsInInstruction: true,
      },
    })
  })

  it('cuts the lookback to 31 days and says so', () => {
    const r = resolve(raw({}, { messagesIn: { channels: ['C1'], since: '2026-01-01', until: null, min: 1 } }))
    expect(r.ok && r.value.criteria.messagesIn?.since).toEqual(new Date(NOW.getTime() - 31 * 86_400_000))
    expect(r.ok && r.value.lookbackClamped).toBe(true)
  })

  it('an end day counts up to its last moment, never past now', () => {
    const r = resolve(raw({}, { messagesIn: { channels: ['C1'], since: '2026-09-10', until: '2026-09-20', min: 1 } }))
    expect(r.ok && r.value.criteria.messagesIn?.until).toEqual(new Date('2026-09-20T23:59:59.999Z'))
  })

  it('says when the instruction cannot be expressed', () => {
    expect(resolve(raw({ understood: false, problem: 'Voice activity is not available.' }))).toEqual({ ok: false, error: { code: 'criteria_unclear', problem: 'Voice activity is not available.' } })
  })

  it('refuses unknown tokens, bad dates, missing amounts and too many channels, listing why', () => {
    const r = resolve(
      raw(
        { amount: { kind: 'perUnit', amount: '1', per: 'replies', cap: null, total: null, splitBy: null }, exclude: ['U9'] },
        { hasRole: ['R9'], messagesIn: { channels: ['C1', 'C2', 'C3'], since: 'last month', until: null, min: 1 }, reactedTo: { message: 'M7', emoji: null } },
      ),
    )
    expect(r.ok).toBe(false)
    const issues = !r.ok && r.error.code === 'criteria_invalid' ? r.error.issues.join(' | ') : ''
    expect(issues).toMatch(/role "R9"/)
    expect(issues).toMatch(/person "U9"/)
    expect(issues).toMatch(/"last month" is not a date/)
    expect(issues).toMatch(/message "M7" is not linked/)
    expect(issues).toMatch(/depends on replies/)
  })

  it('refuses more than 5 channels in one proposal', () => {
    const many = { ...refs, channels: Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((n) => [`C${n}`, `70000000000000001${n}`])) }
    const r = resolveCriteria(raw({}, { messagesIn: { channels: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], since: '2026-10-01', until: null, min: 1 } }), {
      refs: many,
      now: NOW,
      instructionAmounts: [usd(20)],
    })
    expect(r).toMatchObject({ ok: false, error: { code: 'criteria_invalid' } })
  })

  it('pool and perUnit rules, overrides and a per-person cap', () => {
    const r = resolve(
      raw(
        {
          amount: { kind: 'pool', amount: null, per: null, cap: null, total: '500', splitBy: 'messages' },
          overrides: [{ user: 'U1', amount: '100' }],
          perPersonCap: '150',
          note: '  October help desk ',
        },
        { messagesIn: { channels: ['C1'], since: '2026-10-01', until: null, min: 1 } },
      ),
      [usd(500), usd(100), usd(150)],
    )
    expect(r).toMatchObject({
      ok: true,
      value: { plan: { rule: { kind: 'pool', total: usd(500), splitBy: 'messages' }, overrides: [{ discordUserId: C, amount: usd(100) }], perPersonCap: usd(150) }, note: 'October help desk', amountsInInstruction: true },
    })
  })

  it('notes an amount the instruction never stated (a model error a person must check)', () => {
    const r = resolve(raw({ amount: { kind: 'flat', amount: '25', per: null, cap: null, total: null, splitBy: null } }))
    expect(r.ok && r.value.amountsInInstruction).toBe(false)
  })

  it('tokens that are object built-ins ("constructor", "__proto__") are unknown, never a function', () => {
    const r = resolve(raw({ exclude: ['constructor'] }, { hasRole: ['__proto__'], reactedTo: { message: 'toString', emoji: null } }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code === 'criteria_invalid' && r.error.issues.length).toBe(3)
  })

  it('a custom emoji maps back to its Discord form; a long one is cut', () => {
    expect(resolve(raw({}, { reactedTo: { message: 'M1', emoji: ':pepe:' } }))).toMatchObject({ ok: true, value: { criteria: { reactedTo: { emoji: '<:pepe:123456789012345678>' } } } })
    const long = resolve(raw({}, { reactedTo: { message: 'M1', emoji: 'x'.repeat(500) } }))
    expect(long.ok && long.value.criteria.reactedTo?.emoji?.length).toBe(100)
  })

  it('reactions, mentions, threads and past runs', () => {
    const r = resolve(raw({}, { reactedTo: { message: 'M1', emoji: '✅' }, mentionedIn: { message: 'M1' }, postedIn: { thread: 'C3' }, paidInRun: 'last' }))
    expect(r).toMatchObject({
      ok: true,
      value: { criteria: { reactedTo: { ...MSG, emoji: '✅' }, mentionedIn: MSG, postedIn: { threadId: THREAD }, paidInRun: { last: true, runId: null } } },
    })
    expect(resolve(raw({}, { paidInRun: 'run_abc' }))).toMatchObject({ ok: true, value: { criteria: { paidInRun: { last: false, runId: 'run_abc' } } } })
    expect(resolve(raw({}, { paidInRun: 'not a run id with spaces' })).ok).toBe(false)
  })
})

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
const evidence = (over: Partial<CriteriaEvidence> = {}): CriteriaEvidence => ({ messages: [], reactors: null, mentioned: null, threadPosters: null, paidUserIds: null, members: {}, ...over })
const m = (authorId: string, day: number, over: Partial<ScannedMessage> = {}): ScannedMessage => ({ channelId: HELP, authorId, at: new Date(Date.UTC(2026, 9, day, 10)), replyToAuthorId: null, ...over })
const since = new Date('2026-10-01T00:00:00Z')

describe('evaluateCriteria (code runs the filter over the candidates)', () => {
  it('counts messages, distinct active days and replies to other people, per window', () => {
    const messages = [m(A, 2), m(A, 2), m(A, 3, { replyToAuthorId: B }), m(A, 3, { replyToAuthorId: A }), m(B, 4, { replyToAuthorId: A }), m(B, 4, { channelId: GENERAL }), m(B, 1, { at: new Date('2026-09-30T23:00:00Z') })]
    const w = { channelIds: [HELP], since, until: NOW }
    const c = criteria({ messagesIn: { ...w, min: 1 }, activeDaysIn: { ...w, min: 1 }, repliesIn: { ...w, min: 1 } })
    expect(evaluateCriteria(c, evidence({ messages }), [A, B, C], ME).map((v) => [v.userId, v.matched, v.metrics])).toEqual([
      [A, true, { messages: 4, activeDays: 2, replies: 1 }],
      [B, true, { messages: 1, activeDays: 1, replies: 1 }],
      [C, false, { messages: 0, activeDays: 0, replies: 0 }],
    ])
  })

  it('needs every condition (AND), and says which failed first', () => {
    const c = criteria({ hasRole: [MODS], lacksRole: [ADMINS], repliesIn: { channelIds: [HELP], since, until: NOW, min: 2 } })
    const messages = [m(A, 2, { replyToAuthorId: C }), m(A, 3, { replyToAuthorId: C }), m(B, 2, { replyToAuthorId: C }), m(B, 3, { replyToAuthorId: C })]
    const members = { [A]: { roleIds: [MODS], joinedAt: null }, [B]: { roleIds: [MODS, ADMINS], joinedAt: null }, [C]: { roleIds: [], joinedAt: null } }
    const v = evaluateCriteria(c, evidence({ messages, members }), [A, B, C, '200000000000000009'], ME)
    expect(v.map((x) => [x.userId, x.matched, x.failed])).toEqual([
      [A, true, null],
      [B, false, 'lacksRole'],
      [C, false, 'hasRole'],
      ['200000000000000009', false, 'not_member'],
    ])
    expect(needsMembers(c)).toBe(true)
  })

  it('join dates: before the day, or after it', () => {
    const members = { [A]: { roleIds: [], joinedAt: new Date('2026-08-31T23:59:00Z') }, [B]: { roleIds: [], joinedAt: new Date('2026-09-02T00:00:00Z') }, [C]: { roleIds: [], joinedAt: new Date('2026-09-01T12:00:00Z') } }
    const before = evaluateCriteria(criteria({ joinedBefore: new Date('2026-09-01T00:00:00Z') }), evidence({ members }), [A, B, C], ME)
    expect(before.filter((v) => v.matched).map((v) => v.userId)).toEqual([A])
    const after = evaluateCriteria(criteria({ joinedAfter: new Date('2026-09-01T00:00:00Z') }), evidence({ members }), [A, B, C], ME)
    expect(after.filter((v) => v.matched).map((v) => v.userId)).toEqual([B])
  })

  it('reactions, mentions, thread posts and past runs are membership checks', () => {
    const c = criteria({ reactedTo: { ...MSG, emoji: '✅' }, mentionedIn: MSG, postedIn: { threadId: THREAD }, paidInRun: { last: true, runId: 'run_1' } })
    const ev = evidence({ reactors: [A, B, C], mentioned: [A, B], threadPosters: [A, B, C], paidUserIds: [A, C] })
    expect(evaluateCriteria(c, ev, [A, B, C], ME).map((v) => [v.userId, v.failed])).toEqual([
      [A, null],
      [B, 'paidInRun'],
      [C, 'mentionedIn'],
    ])
  })

  it('exclusions: listed people and, with excludeProposer, the person asking', () => {
    const c = criteria({ exclude: [B], excludeProposer: true })
    expect(evaluateCriteria(c, evidence(), [A, B, ME], ME).map((v) => v.matched)).toEqual([true, false, false])
  })

  it('no conditions: every candidate matches (every registered payee)', () => {
    expect(evaluateCriteria(criteria(), evidence(), [A, B], ME).every((v) => v.matched)).toBe(true)
    expect(needsMembers(criteria())).toBe(false)
  })
})

describe('scanPlan and seenUsers', () => {
  it('reads each counted channel once over the span of all windows', () => {
    const c = criteria({
      messagesIn: { channelIds: [HELP, GENERAL], since: new Date('2026-09-20T00:00:00Z'), until: NOW, min: 1 },
      repliesIn: { channelIds: [HELP], since, until: new Date('2026-10-05T00:00:00Z'), min: 1 },
    })
    expect(scanPlan(c)).toEqual({ channelIds: [HELP, GENERAL], since: new Date('2026-09-20T00:00:00Z'), until: NOW })
    expect(scanPlan(criteria())).toBeNull()
  })

  it('lists the people the evidence shows, most active first', () => {
    const c = criteria({ messagesIn: { channelIds: [HELP], since, until: NOW, min: 1 } })
    expect(seenUsers(c, evidence({ messages: [m(B, 2), m(A, 2), m(A, 3)], reactors: [C] }))).toEqual([A, B, C])
  })
})
