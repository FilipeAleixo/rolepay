import { describe, expect, it } from 'vitest'
import { type Run, type RunEvent, newRun, transition } from '../run.js'
import { type Criteria, type CriteriaEvidence, type ScannedMessage, evaluateCriteria, needsMembers, paidPayees, resolveCriteria, scanPlan, seenUsers } from './criteria.js'
import type { RawActivity, RawAnchor, RawCriteriaProposal } from './raw.js'

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

// The raw shape has no nulls (structured outputs cap union-typed fields): "" and [] mean "not set".
const rule = (r: Partial<RawCriteriaProposal['amount']> & Pick<RawCriteriaProposal['amount'], 'kind'>): RawCriteriaProposal['amount'] => ({ amount: '', per: '', cap: '', total: '', splitBy: '', ...r })
const act = (metric: RawActivity['metric'], channels: string[], since: string, until = '', min = 1): RawActivity => ({ metric, channels, since, until, min })
const anchor = (kind: RawAnchor['kind'], fields: Partial<Omit<RawAnchor, 'kind'>>): RawAnchor => ({ kind, message: '', thread: '', emoji: '', ...fields })
const raw = (over: Partial<RawCriteriaProposal> = {}, conditions: Partial<RawCriteriaProposal['conditions']> = {}): RawCriteriaProposal => ({
  understood: true,
  problem: '',
  conditions: { hasRole: [], lacksRole: [], joinedBefore: '', joinedAfter: '', activity: [], anchors: [], paidInRun: '', neverPaid: false, ...conditions },
  exclude: [],
  excludeProposer: false,
  amount: rule({ kind: 'flat', amount: '20' }),
  overrides: [],
  perPersonCap: '',
  note: '',
  assumptions: [],
  ...over,
})
const resolve = (r: RawCriteriaProposal, amounts = [usd(20)]) => resolveCriteria(r, { refs, now: NOW, instructionAmounts: amounts })

describe('resolveCriteria (the model writes the filter, code checks it)', () => {
  it('maps tokens to Discord IDs and dates to a window that ends now', () => {
    const r = resolve(raw({ exclude: ['U1'], excludeProposer: true }, { hasRole: ['R2'], activity: [act('replies', ['C1'], '2026-09-06', '', 10)] }))
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
    const r = resolve(raw({}, { activity: [act('messages', ['C1'], '2026-01-01')] }))
    expect(r.ok && r.value.criteria.messagesIn?.since).toEqual(new Date(NOW.getTime() - 31 * 86_400_000))
    expect(r.ok && r.value.lookbackClamped).toBe(true)
  })

  it('an end day counts up to its last moment, never past now', () => {
    const r = resolve(raw({}, { activity: [act('messages', ['C1'], '2026-09-10', '2026-09-20')] }))
    expect(r.ok && r.value.criteria.messagesIn?.until).toEqual(new Date('2026-09-20T23:59:59.999Z'))
  })

  it('says when the instruction cannot be expressed', () => {
    expect(resolve(raw({ understood: false, problem: 'Voice activity is not available.' }))).toEqual({ ok: false, error: { code: 'criteria_unclear', problem: 'Voice activity is not available.' } })
  })

  it('refuses unknown tokens, bad dates, missing amounts and too many channels, listing why', () => {
    const r = resolve(
      raw(
        { amount: rule({ kind: 'perUnit', amount: '1', per: 'replies' }), exclude: ['U9'] },
        { hasRole: ['R9'], activity: [act('messages', ['C1', 'C2', 'C3'], 'last month')], anchors: [anchor('reactedTo', { message: 'M7' })] },
      ),
    )
    expect(r.ok).toBe(false)
    const issues = !r.ok && r.error.code === 'criteria_invalid' ? r.error.issues.join(' | ') : ''
    // People read these: a made-up token is "the role the AI named", never "R9".
    expect(issues).toMatch(/the role the AI named is not one the instruction or the server names/)
    expect(issues).toMatch(/the person the AI named is not one/)
    expect(issues).toMatch(/"last month" is not a date/)
    expect(issues).toMatch(/the message the AI named is not linked/)
    expect(issues).toMatch(/depends on replies/)
    expect(issues).not.toMatch(/R9|U9|M7/)
    // A name instead of a token is worth quoting: it says what the AI looked for.
    const named = resolve(raw({}, { hasRole: ['Moderators'] }))
    expect(!named.ok && named.error.code === 'criteria_invalid' && named.error.issues).toEqual(['the role "Moderators" is not one the instruction or the server names'])
  })

  it("the model's words (assumptions, the note, the problem) name roles, channels, people and messages, never tokens", () => {
    const r = resolve(
      raw(
        {
          note: 'Help desk, except U1',
          assumptions: ['@R2 means the Mods role, and replies are counted in #C1.', 'M1 is the winners post; an R token was not needed.'],
        },
        { hasRole: ['R2'], activity: [act('replies', ['C1'], '2026-09-06')] },
      ),
    )
    expect(r.ok && r.value.assumptions).toEqual([`<@&${MODS}> means the Mods role, and replies are counted in <#${HELP}>.`, 'The message is the winners post; a role was not needed.'])
    expect(r.ok && r.value.note).toBe(`Help desk, except <@${C}>`)
    expect(resolve(raw({ understood: false, problem: 'Voice activity in C2 is not available, and U9 is nobody.' }))).toEqual({
      ok: false,
      error: { code: 'criteria_unclear', problem: `Voice activity in <#${GENERAL}> is not available, and someone is nobody.` },
    })
  })

  it('refuses more than 5 channels in one proposal', () => {
    const many = { ...refs, channels: Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((n) => [`C${n}`, `70000000000000001${n}`])) }
    const r = resolveCriteria(raw({}, { activity: [act('messages', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'], '2026-10-01')] }), {
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
          amount: rule({ kind: 'pool', total: '500', splitBy: 'messages' }),
          overrides: [{ user: 'U1', amount: '100' }],
          perPersonCap: '150',
          note: '  October help desk ',
        },
        { activity: [act('messages', ['C1'], '2026-10-01')] },
      ),
      [usd(500), usd(100), usd(150)],
    )
    expect(r).toMatchObject({
      ok: true,
      value: { plan: { rule: { kind: 'pool', total: usd(500), splitBy: 'messages' }, overrides: [{ discordUserId: C, amount: usd(100) }], perPersonCap: usd(150) }, note: 'October help desk', amountsInInstruction: true },
    })
  })

  it('notes an amount the instruction never stated (a model error a person must check)', () => {
    const r = resolve(raw({ amount: rule({ kind: 'flat', amount: '25' }) }))
    expect(r.ok && r.value.amountsInInstruction).toBe(false)
  })

  it('tokens that are object built-ins ("constructor", "__proto__") are unknown, never a function', () => {
    const r = resolve(raw({ exclude: ['constructor'] }, { hasRole: ['__proto__'], anchors: [anchor('reactedTo', { message: 'toString' })] }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code === 'criteria_invalid' && r.error.issues.length).toBe(3)
  })

  it('a custom emoji maps back to its Discord form; a long one is cut', () => {
    expect(resolve(raw({}, { anchors: [anchor('reactedTo', { message: 'M1', emoji: ':pepe:' })] }))).toMatchObject({ ok: true, value: { criteria: { reactedTo: { emoji: '<:pepe:123456789012345678>' } } } })
    const long = resolve(raw({}, { anchors: [anchor('reactedTo', { message: 'M1', emoji: 'x'.repeat(500) })] }))
    expect(long.ok && long.value.criteria.reactedTo?.emoji?.length).toBe(100)
  })

  it('reactions, mentions, threads and past runs', () => {
    const r = resolve(
      raw({}, { anchors: [anchor('reactedTo', { message: 'M1', emoji: '✅' }), anchor('mentionedIn', { message: 'M1' }), anchor('postedIn', { thread: 'C3' })], paidInRun: 'last' }),
    )
    expect(r).toMatchObject({
      ok: true,
      value: { criteria: { reactedTo: { ...MSG, emoji: '✅' }, mentionedIn: MSG, postedIn: { threadId: THREAD }, paidInRun: { last: true, runId: null } } },
    })
    expect(resolve(raw({}, { paidInRun: 'run_abc' }))).toMatchObject({ ok: true, value: { criteria: { paidInRun: { last: false, runId: 'run_abc' } } } })
    expect(resolve(raw({}, { paidInRun: 'not a run id with spaces' })).ok).toBe(false)
  })

  it('never paid: people this community has never paid ("first-time"); not together with paid in a run, which nobody could meet', () => {
    expect(resolve(raw({}, { anchors: [anchor('reactedTo', { message: 'M1', emoji: '✅' })], neverPaid: true }))).toMatchObject({ ok: true, value: { criteria: { reactedTo: { ...MSG, emoji: '✅' }, neverPaid: true } } })
    const plain = resolve(raw())
    expect(plain.ok && plain.value.criteria.neverPaid).toBe(false)
    const both = resolve(raw({}, { paidInRun: 'last', neverPaid: true }))
    expect(!both.ok && both.error.code === 'criteria_invalid' && both.error.issues.join(' | ')).toMatch(/paid in a run and never paid/)
  })

  it('"" and [] mean not set: nothing in the raw answer becomes a null condition', () => {
    expect(resolve(raw())).toMatchObject({
      ok: true,
      value: {
        criteria: {
          joinedBefore: null,
          joinedAfter: null,
          messagesIn: null,
          activeDaysIn: null,
          repliesIn: null,
          reactedTo: null,
          mentionedIn: null,
          postedIn: null,
          paidInRun: null,
        },
        plan: { perPersonCap: null },
        note: null,
      },
    })
    expect(resolve(raw({}, { anchors: [anchor('reactedTo', { message: 'M1', emoji: '  ' })] }))).toMatchObject({ ok: true, value: { criteria: { reactedTo: { emoji: null } } } })
    expect(resolve(raw({ understood: false, problem: ' ' }))).toMatchObject({ ok: false, error: { code: 'criteria_unclear', problem: expect.stringMatching(/could not be expressed/) } })
  })

  it('each activity metric maps to its window, with join dates and a perUnit cap', () => {
    const r = resolve(
      raw(
        { amount: rule({ kind: 'perUnit', amount: '2', per: 'activeDays', cap: '30' }) },
        {
          joinedBefore: '2026-09-01',
          joinedAfter: '2026-01-01',
          activity: [act('messages', ['C1'], '2026-10-01', '', 5), act('activeDays', ['C2'], '2026-10-01', '2026-10-03', 2), act('replies', ['C1', 'C2'], '2026-10-02')],
        },
      ),
      [usd(2), usd(30)],
    )
    expect(r).toMatchObject({
      ok: true,
      value: {
        criteria: {
          joinedBefore: new Date('2026-09-01T00:00:00Z'),
          joinedAfter: new Date('2026-01-01T00:00:00Z'),
          messagesIn: { channelIds: [HELP], min: 5, until: NOW },
          activeDaysIn: { channelIds: [GENERAL], min: 2, until: new Date('2026-10-03T23:59:59.999Z') },
          repliesIn: { channelIds: [HELP, GENERAL], min: 1, since: new Date('2026-10-02T00:00:00Z') },
        },
        plan: { rule: { kind: 'perUnit', amount: usd(2), per: 'activeDays', cap: usd(30) } },
      },
    })
  })

  it('refuses a metric or an anchor kind given twice, an anchor without its token, and a rule missing its unit', () => {
    const r = resolve(
      raw(
        { amount: rule({ kind: 'perUnit', amount: '1' }) },
        {
          activity: [act('messages', ['C1'], '2026-10-01'), act('messages', ['C2'], '2026-10-01')],
          anchors: [anchor('reactedTo', { message: 'M1' }), anchor('reactedTo', { message: 'M1', emoji: '✅' }), anchor('mentionedIn', {}), anchor('postedIn', {})],
        },
      ),
    )
    const issues = !r.ok && r.error.code === 'criteria_invalid' ? r.error.issues.join(' | ') : ''
    expect(issues).toMatch(/messages: given twice/)
    expect(issues).toMatch(/reacted to: given twice/)
    expect(issues).toMatch(/mentioned in: say which message/)
    expect(issues).toMatch(/posted in: say which thread/)
    expect(issues).toMatch(/what the amount is per/)
    const pool = resolve(raw({ amount: rule({ kind: 'pool', total: '20' }) }))
    expect(!pool.ok && pool.error.code === 'criteria_invalid' && pool.error.issues.join(' | ')).toMatch(/how to split it/)
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
  neverPaid: false,
  exclude: [],
  excludeProposer: false,
  ...over,
})
const evidence = (over: Partial<CriteriaEvidence> = {}): CriteriaEvidence => ({ messages: [], reactors: null, mentioned: null, threadPosters: null, paidUserIds: null, paidBefore: null, members: {}, ...over })
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

  it('never paid: someone this community already paid does not match; without the history read, nobody does (it never pays by default)', () => {
    const c = criteria({ reactedTo: { ...MSG, emoji: '✅' }, neverPaid: true })
    expect(evaluateCriteria(c, evidence({ reactors: [A, B, C], paidBefore: [B] }), [A, B, C], ME).map((v) => [v.userId, v.matched, v.failed])).toEqual([
      [A, true, null],
      [B, false, 'neverPaid'],
      [C, true, null],
    ])
    expect(evaluateCriteria(c, evidence({ reactors: [A] }), [A], ME).map((v) => v.failed)).toEqual(['neverPaid'])
    // A first-timer filter alone: every registered payee nobody has paid yet.
    expect(evaluateCriteria(criteria({ neverPaid: true }), evidence({ paidBefore: [A] }), [A, B], ME).map((v) => v.matched)).toEqual([false, true])
    expect(seenUsers(c, evidence({ reactors: [A], paidBefore: [B] }))).toEqual([A])
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

describe('paidPayees: who a community has paid, for never paid', () => {
  const GUILD = '1094309218049937418'
  const OTHER = '1094309218049937419'
  const people = Array.from({ length: 9 }, (_, i) => `20000000000000010${i}`)
  const run = (n: number, events: RunEvent[], communityId = GUILD): Run => {
    const made = newRun({ id: `run_np${n}`, communityId, token: '0x20c0000000000000000000000000000000000001', note: null, createdBy: ME, lines: [{ payeeDiscordId: people[n] as string, address: `0x${String(n + 1).repeat(40)}`, amount: 1_000_000n }], now: NOW })
    if (!made.ok) throw new Error(made.error.code)
    return events.reduce((r, e) => {
      const next = transition(r, e, NOW)
      if (!next.ok) throw new Error(`${e.type}: ${next.error.code}`)
      return next.value
    }, made.value)
  }
  const submit: RunEvent = { type: 'submit', actor: ME }
  const approve: RunEvent = { type: 'approve', actor: ME }
  const start: RunEvent = { type: 'start_attempt', fromBlock: 1n, validBefore: 2_000_000_000 }
  const paid: RunEvent = { type: 'mark_paid', txHash: `0x${'ab'.repeat(32)}`, blockNumber: 7n }
  const failed = (reason: 'rejected' | 'partial_match'): RunEvent => ({ type: 'mark_failed', reason, detail: 'fixture' })

  it('a paid line counts; so does a run being paid now (approved or executing) and a failure where money may have moved; drafts, unapproved, cancelled runs, failures that sent nothing and other communities do not', () => {
    const runs = [
      run(0, [submit, approve, start, paid]), // paid
      run(1, []), // a draft
      run(2, [submit]), // waiting for approval
      run(3, [submit, { type: 'cancel', actor: ME }]), // cancelled (a veto)
      run(4, [submit, approve, start, failed('rejected')]), // failed, nothing sent (retryable)
      run(5, [submit, approve, start, failed('partial_match')]), // failed, the chain shows money moving: a person must look
      run(6, [submit, approve]), // approved: about to be paid
      run(7, [submit, approve, start]), // executing: being paid
      run(8, [submit, approve, start, paid], OTHER), // paid, by another community
    ]
    expect(paidPayees(runs, GUILD)).toEqual([people[0], people[5], people[6], people[7]])
    expect(paidPayees([], GUILD)).toEqual([])
  })
})
