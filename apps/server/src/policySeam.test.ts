// The policy seam's mapping in detail: schedules, every refusal in words, the audit stream in
// words, and the edges the page contract does not reach. The page contract
// (test/dashboardContract.test.ts) runs the dashboard's own page tests through these adapters.
import { AUDIT_EVENT_TYPES, type AuditEvent, type AuditEventType, createRolepay, parseAmount } from '@rolepay/core'
import { FakeActivityReader, FakePayoutChain, FakeRunProposer, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories, unclearCriteria } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { scriptedProposer } from '../test/coreBackend.js'
import { aiUsagePortFromCore, auditPortFromCore, auditSummary, payoutsPortFromCore, policyPortFromCore, toCoreSchedule, toPortSchedule } from './policySeam.js'

const GUILD = '1094309218049937418'
const ROLE = '400000000000000001'
const TREASURER = '300000000000000001'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const actor = { id: TREASURER, roleIds: [ROLE] }
const asTreasurer = { guildId: GUILD, actor: TREASURER, actorRoleIds: [ROLE] }
const MONDAY = { kind: 'weekly' as const, weekday: 1, hour: 18, timezone: 'UTC' }
const RULE = 'Every Monday: 1 USDC per answered question in #help, max 50 a week each.'
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}

async function world(opts: { proposer?: FakeRunProposer | null; activity?: FakeActivityReader | null; ai?: boolean; demoControls?: boolean } = {}) {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
  const activity = opts.activity === undefined ? new FakeActivityReader() : opts.activity
  const proposer = opts.proposer === undefined ? scriptedProposer() : opts.proposer
  const rolepay = createRolepay({
    chain,
    repositories: createMemoryRepositories({ clock }),
    vault: new PlainKeyVault(),
    ids: new SequentialIds(),
    clock,
    network: 'moderato',
    proposer,
    activity,
    ...(opts.demoControls ? { demoControls: true } : {}),
  })
  const r = await rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE })
  if (!r.ok) throw new Error(r.error.code)
  if (opts.ai !== false) await rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [ROLE] })
  if (activity) {
    // The scripted model names Mods as R2, #help as C1 and the private room as C2.
    activity.roles = [
      { id: ROLE, name: 'Treasurer' },
      { id: '400000000000000002', name: 'Mods' },
    ]
    activity.channels = [
      { id: '700000000000000002', name: 'help', kind: 'text' },
      { id: '700000000000000003', name: 'private', kind: 'text' },
    ]
  }
  const port = policyPortFromCore(rolepay, activity ? { names: activity } : {})
  return { clock, chain, rolepay, activity, proposer, port, audit: auditPortFromCore(rolepay) }
}

describe('schedules between the dashboard (weekday 0 = Sunday) and core (weekday names)', () => {
  it('map both ways, weekly and monthly', () => {
    expect(toCoreSchedule(MONDAY)).toEqual({ kind: 'weekly', weekday: 'monday', hour: 18, timezone: 'UTC' })
    expect(toPortSchedule({ kind: 'weekly', weekday: 'sunday', hour: 9, timezone: 'Europe/Lisbon' })).toEqual({ kind: 'weekly', weekday: 0, hour: 9, timezone: 'Europe/Lisbon' })
    const monthly = { kind: 'monthly' as const, day: 15, hour: 9, timezone: 'Europe/Lisbon' }
    expect(toPortSchedule(toCoreSchedule(monthly))).toEqual(monthly)
  })

  it('daily (the testnet demo controls) maps both ways too, and the port says whether core allows it', async () => {
    const daily = { kind: 'daily' as const, hour: 18, timezone: 'UTC' }
    expect(toCoreSchedule(daily)).toEqual(daily)
    expect(toPortSchedule(daily)).toEqual(daily)
    expect((await world()).port.dailySchedules).toBe(false)
    const demo = await world({ demoControls: true })
    expect(demo.port.dailySchedules).toBe(true)
    const created = await demo.port.create({ guildId: GUILD, actor, draft: { name: 'Judges', instruction: RULE, schedule: daily } })
    if (!created.ok) throw new Error(created.error.code)
    expect((await demo.port.get({ guildId: GUILD, policyId: created.value.policyId })).ok && (await demo.port.list({ guildId: GUILD }))[0]?.schedule).toEqual(daily)
  })
})

describe('policyPortFromCore: refusals in words', () => {
  it('compiling: AI not set up, AI off, the model declined, an unknown reason, an unclear or unworkable rule; a person without the role; a value core refuses', async () => {
    const draft = { name: 'Help desk', instruction: RULE, schedule: MONDAY }
    const noModel = await world({ proposer: null })
    expect(await noModel.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ ok: false, error: { code: 'could_not_compile', message: expect.stringMatching(/no Anthropic API key/) } })
    const off = await world({ ai: false })
    expect(await off.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ error: { code: 'could_not_compile', message: expect.stringMatching(/ai_proposals:true/) } })
    const w = await world()
    const refusal = (reason: string) => () => ({ code: 'could_not_propose' as const, reason: reason as 'daily_cap', detail: '', usage: null })
    ;(w.proposer as FakeRunProposer).onCriteria = refusal('daily_cap')
    expect(await w.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ error: { code: 'could_not_compile', message: expect.stringMatching(/after midnight UTC/) } })
    ;(w.proposer as FakeRunProposer).onCriteria = refusal('something_new')
    expect(await w.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ error: { message: expect.stringMatching(/could not use/) } })
    ;(w.proposer as FakeRunProposer).onCriteria = () => unclearCriteria('It names no role or channel.')
    expect(await w.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ error: { message: 'The rule could not be compiled from that instruction: It names no role or channel.' } })
    ;(w.proposer as FakeRunProposer).onCriteria = () => ({ ...unclearCriteria(''), understood: true, conditions: { hasRole: ['R9'], lacksRole: [], joinedBefore: '', joinedAfter: '', activity: [], anchors: [], paidInRun: '' } })
    expect(await w.port.create({ guildId: GUILD, actor, draft })).toMatchObject({ error: { code: 'could_not_compile' } })
    expect(await w.port.create({ guildId: GUILD, actor: { id: TREASURER, roleIds: [] }, draft })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.port.create({ guildId: GUILD, actor, draft: { ...draft, name: 'x'.repeat(81) } })).toMatchObject({ error: { code: 'invalid_input', message: expect.any(String) } })
    // A daily schedule on a server without the testnet demo controls: refused before the model, in words.
    const asked = w.proposer?.requests.length
    expect(await w.port.create({ guildId: GUILD, actor, draft: { ...draft, schedule: { kind: 'daily', hour: 18, timezone: 'UTC' } } })).toEqual({
      ok: false,
      error: { code: 'schedule_not_allowed', message: 'A daily schedule is a testnet demo control, off on this server: choose weekly or monthly.' },
    })
    expect(w.proposer?.requests.length).toBe(asked)
  })

  it('states: resume an active policy, approve an old version, discard a version that is not the one waiting', async () => {
    const w = await world()
    const created = await w.port.create({ guildId: GUILD, actor, draft: { name: 'Help desk', instruction: RULE, schedule: MONDAY } })
    if (!created.ok) throw new Error(created.error.code)
    const ref = { guildId: GUILD, policyId: created.value.policyId, actor }
    expect(await w.port.discard({ ...ref, version: 2 })).toEqual({ ok: false, error: { code: 'version_mismatch' } })
    expect(await w.port.approve({ ...ref, version: 1 })).toEqual({ ok: true, value: undefined })
    expect(await w.port.resume(ref)).toEqual({ ok: false, error: { code: 'illegal_state' } })
    expect(await w.port.discard({ ...ref, version: 1 })).toEqual({ ok: false, error: { code: 'illegal_state' } })
    expect(await w.port.setMode({ ...ref, mode: 'autopilot', vetoWindowMinutes: 30 })).toEqual({ ok: false, error: { code: 'invalid_veto_window' } })
    // A new name or schedule is a new version without asking the model again.
    const asked = w.proposer?.requests.length
    expect(await w.port.edit({ ...ref, draft: { name: 'Renamed', instruction: `${RULE} `, schedule: { ...MONDAY, hour: 9 } } })).toEqual({ ok: true, value: { version: 2 } })
    expect(w.proposer?.requests.length).toBe(asked)
    expect(await w.port.edit({ ...ref, policyId: 'pol_nope', draft: { name: 'x', instruction: RULE, schedule: MONDAY } })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
  })

  it('a policy archived before anyone approved it: its only version reads as dropped', async () => {
    const w = await world()
    const created = await w.port.create({ guildId: GUILD, actor, draft: { name: 'Help desk', instruction: RULE, schedule: MONDAY } })
    if (!created.ok) throw new Error(created.error.code)
    const ref = { guildId: GUILD, policyId: created.value.policyId }
    expect((await w.port.versions(ref)).map((v) => v.status)).toEqual(['pending'])
    await w.port.archive({ ...ref, actor })
    expect((await w.port.versions(ref)).map((v) => v.status)).toEqual(['discarded'])
    expect(await w.port.versions({ guildId: GUILD, policyId: 'pol_nope' })).toEqual([])
    expect(await w.port.get({ guildId: GUILD, policyId: 'pol_nope' })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
  })

  it('a veto of a run no policy made, or of an unknown run, finds nothing to veto', async () => {
    const w = await world()
    expect(await w.port.veto({ guildId: GUILD, runId: 'run_nope', actor })).toEqual({ ok: false, error: { code: 'policy_run_not_found' } })
    expect(await w.port.runOrigins({ guildId: GUILD, runIds: ['run_nope', 'run_nope'] })).toEqual({})
  })
})

describe('policyPortFromCore: who it applies to, when it cannot be worked out', () => {
  it('an unknown policy; a server not connected to Discord; a channel the bot cannot read', async () => {
    const w = await world()
    expect(await w.port.preview({ guildId: GUILD, policyId: 'pol_nope' })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
    const created = await w.port.create({ guildId: GUILD, actor, draft: { name: 'Private', instruction: 'Every Monday: 1 USDC per answered question in the private room, max 50 a week each.', schedule: MONDAY } })
    if (!created.ok) throw new Error(created.error.code)
    const ref = { guildId: GUILD, policyId: created.value.policyId }
    w.activity?.forbidden.add('700000000000000003')
    expect(await w.port.preview(ref)).toMatchObject({ ok: false, error: { code: 'cannot_read', message: expect.stringMatching(/View Channel and Read Message History/) } })
    const blind = policyPortFromCore(createRolepay({ ...(await bare()), activity: null }))
    expect(await blind.preview({ guildId: GUILD, policyId: 'pol_nope' })).toMatchObject({ ok: false })
  })

  it('without an active key, the next run would be held, and says so; a cap per run holds it too', async () => {
    const w = await world()
    const created = await w.rolepay.policies.create({ ...asTreasurer, name: 'Capped', instruction: RULE, schedule: toCoreSchedule(MONDAY), caps: { perRun: usd('1'), perPerson: null } })
    if (!created.ok) throw new Error(created.error.code)
    const activity = w.activity as FakeActivityReader
    activity.setMember('200000000000000011', { roleIds: ['400000000000000002'], joinedAt: null })
    for (let i = 0; i < 3; i++) {
      activity.addMessages({
        id: String(810000000000000100n + BigInt(i)),
        channelId: '700000000000000002',
        authorId: '200000000000000011',
        authorIsBot: false,
        content: '',
        mentionIds: [],
        at: new Date(w.clock.now().getTime() - (i + 1) * 60_000),
        replyTo: { messageId: '810000000000000000', authorId: '200000000000000090' },
      })
    }
    const link = await w.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: '200000000000000011' })
    if (!link.ok) throw new Error(link.error.code)
    await w.rolepay.payees.register({ token: link.value.token, address: '0x1111111111111111111111111111111111111111' })
    const p = await w.port.preview({ guildId: GUILD, policyId: created.value.id })
    if (!p.ok) throw new Error(p.error.code)
    expect(p.value.total).toBe(usd('3'))
    expect(p.value.remainingBudget).toBeNull()
    expect(p.value.held).toContain("over the policy's cap per run (1 AlphaUSD)")
    expect(p.value.held).toContain('There is no active bot key')
  })

  it('when Discord does not answer, the rule names roles and channels by ID', async () => {
    const w = await world()
    const created = await w.port.create({ guildId: GUILD, actor, draft: { name: 'Help desk', instruction: RULE, schedule: MONDAY } })
    if (!created.ok) throw new Error(created.error.code)
    const failing = policyPortFromCore(w.rolepay, {
      names: {
        guildNames: async () => {
          throw new Error('discord down')
        },
      },
    })
    const d = await failing.get({ guildId: GUILD, policyId: created.value.policyId })
    expect(d.ok && d.value.ruleInWords).toContain('has @role 400000000000000002')
    expect(d.ok && d.value.ruleInWords).toContain('#700000000000000002')
    const plain = policyPortFromCore(w.rolepay)
    const again = await plain.get({ guildId: GUILD, policyId: created.value.policyId })
    expect(again.ok && again.value.ruleInWords).toContain('@role 400000000000000002')
  })
})

async function bare() {
  const clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
  return { chain: new FakePayoutChain({ startTime: 0 }), repositories: createMemoryRepositories({ clock }), vault: new PlainKeyVault(), ids: new SequentialIds(), clock, network: 'moderato' as const }
}

describe('auditPortFromCore', () => {
  it('offers every event type core writes, and matches nothing for a cursor, a type or an actor that is not one', async () => {
    const w = await world()
    expect(w.audit.eventTypes).toEqual(AUDIT_EVENT_TYPES)
    await w.port.create({ guildId: GUILD, actor, draft: { name: 'Help desk', instruction: RULE, schedule: MONDAY } })
    expect((await w.audit.events({ guildId: GUILD, limit: 10 })).map((e) => e.type)).toEqual(['policy.compiled', 'policy.created'])
    expect(await w.audit.events({ guildId: GUILD, limit: 10, beforeId: 'evt_1' })).toEqual([])
    expect(await w.audit.events({ guildId: GUILD, limit: 10, type: 'run.vetoed' })).toEqual([])
    expect(await w.audit.events({ guildId: GUILD, limit: 10, actorId: 'not-an-id' })).toEqual([])
    expect((await w.audit.events({ guildId: GUILD, limit: 10_000 })).length).toBe(2)
    const [newest] = await w.audit.events({ guildId: GUILD, limit: 1 })
    expect((await w.audit.events({ guildId: GUILD, limit: 10, beforeId: newest?.id })).map((e) => e.type)).toEqual(['policy.created'])
  })
})

describe('auditSummary: every event in plain words, from codes, counts and amounts only', () => {
  const event = (type: AuditEventType, details: AuditEvent['details'] = {}): AuditEvent => ({
    seq: 1,
    communityId: GUILD,
    at: new Date('2026-10-06T12:00:00Z'),
    type,
    actor: TREASURER,
    policyId: 'pol_1',
    policyVersion: 2,
    policyRunId: null,
    runId: null,
    details,
  })
  const say = (type: AuditEventType, details: AuditEvent['details'] = {}) => auditSummary(event(type, details), 'AlphaUSD')

  it('has words for every type', () => {
    for (const type of AUDIT_EVENT_TYPES) expect(say(type), type).toMatch(/^[A-Z].*\.$/)
  })

  it('policy events', () => {
    expect(say('policy.created')).toBe('Wrote the policy as a draft (version 2).')
    expect(say('policy.compiled', { amountsInInstruction: false })).toBe('Compiled the instruction once into a rule; it uses an amount the instruction does not state, so it cannot be approved.')
    expect(say('policy.edited', { recompiled: true, autopilotOff: true })).toBe('Edited it: version 2 waits for approval (compiled again from a new instruction); autopilot is off.')
    expect(say('policy.edited', { recompiled: false, autopilotOff: false })).toBe('Edited it: version 2 waits for approval.')
    expect(say('policy.discarded', { discarded: 3, restored: 2 })).toBe('Discarded version 3; back to version 2, paused.')
    expect(say('policy.discarded', { discarded: 1, restored: null })).toBe('Discarded version 1; the policy is archived.')
    expect(say('policy.mode_changed', { to: 'autopilot', vetoWindowMinutes: 1 })).toContain('a veto window of 1 minute')
    expect(say('policy.mode_changed', { to: 'autopilot', vetoWindowMinutes: 90 })).toContain('90 minutes')
    expect(say('policy.mode_changed', { to: 'autopilot', vetoWindowMinutes: 60 })).toContain('1 hour')
    expect(say('policy.mode_changed', { to: 'autopilot', vetoWindowMinutes: 1440 })).toContain('24 hours')
    expect(say('policy.mode_changed', { to: 'propose' })).toBe('Switched to propose: each run waits for approval.')
  })

  it('policy run events', () => {
    expect(say('policy_run.generated', { mode: 'autopilot', total: '62', lines: 2, unregistered: 1, executeAfter: '2026-10-12T19:00:00.000Z' })).toBe(
      "Made the period's run: 62 AlphaUSD for 2 people, pays at 2026-10-12 19:00 UTC unless vetoed; 1 person matched but is not registered.",
    )
    expect(say('policy_run.generated', { mode: 'propose', total: '1', lines: 1, unregistered: 0, executeAfter: null })).toBe("Made the period's run: 1 AlphaUSD for 1 person, waiting for approval.")
    expect(say('policy_run.held', { code: 'over_budget', total: '120', limit: '87.5' })).toBe('Held the run whole: more than the bot key has left (120 AlphaUSD against 87.5 AlphaUSD).')
    expect(say('policy_run.held', { code: 'no_active_key', total: '5', limit: null })).toBe('Held the run whole: no active bot key (5 AlphaUSD).')
    expect(say('policy_run.held', { code: 'something_new', total: null, limit: null })).toBe('Held the run whole: something_new.')
    expect(say('policy_run.empty', { unregistered: 0 })).toBe('Nobody to pay this period.')
    expect(say('policy_run.empty', { unregistered: 3 })).toBe('Nobody to pay this period; 3 people matched but are not registered.')
    expect(say('policy_run.released', { outcome: 'pending' })).toBe('Released the run after its veto window: payment in progress.')
    expect(say('policy_run.released', { outcome: 'odd' })).toBe('Released the run after its veto window: odd.')
  })

  it('pay run events', () => {
    expect(say('run.created', { total: '4', lines: 2 })).toBe('Created a run of 4 AlphaUSD for 2 people.')
    expect(say('run.executing', { attempt: 2 })).toBe('Started paying (attempt 2).')
    expect(say('run.failed', { reason: 'rejected', retryable: true })).toBe('The payment failed (rejected); it can be retried.')
    expect(say('run.failed', { reason: 'partial_match', retryable: false })).toBe('The payment failed (partial_match).')
    expect(auditSummary(event('run.paid', { lines: 1 }), 'AlphaUSD')).toBe('Paid ? AlphaUSD to 1 person.')
  })
})

describe('aiUsagePortFromCore: the AI spend, read from the rows core writes', () => {
  it('the month so far, each proposal with its model, time, cost and the run it became, and the compile of each policy version', async () => {
    const w = await world()
    const fake = w.proposer as FakeRunProposer
    fake.usage = { ...fake.usage, model: 'claude-sonnet-5-5' } // 7 ms and 10,800 micro-dollars a call
    const ai = aiUsagePortFromCore(w.rolepay)
    const draft = { name: 'Help desk', instruction: RULE, schedule: MONDAY }
    const created = await w.port.create({ guildId: GUILD, actor, draft })
    if (!created.ok) throw new Error(created.error.code)
    const policyId = created.value.policyId
    expect((await w.port.edit({ guildId: GUILD, policyId, actor, draft: { ...draft, instruction: `${RULE} From today.` } })).ok).toBe(true)
    const ALICE = '200000000000000011'
    const link = await w.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!link.ok) throw new Error(link.error.code)
    await w.rolepay.payees.register({ token: link.value.token, address: '0x1111111111111111111111111111111111111111' })
    const winners = { id: '810000000000000001', channelId: '700000000000000001', authorId: TREASURER, authorIsBot: false, content: `Winner: <@${ALICE}>`, mentionIds: [ALICE], at: w.clock.now(), replyTo: null }
    const proposed = await w.rolepay.proposals.proposeFromMessages({ ...asTreasurer, instruction: '5 each', source: { kind: 'messages', channelId: winners.channelId, messages: [winners] } })
    if (!proposed.ok) throw new Error(proposed.error.code)
    const made = await w.rolepay.proposals.createRun({ ...asTreasurer, proposalId: proposed.value.id })
    if (!made.ok) throw new Error(made.error.code)

    expect(await ai.spend({ guildId: GUILD })).toEqual({ since: new Date('2026-10-01T00:00:00Z'), calls: 3, totalMicroUsd: 32_400n, unpriced: 0, proposals: 1, averagePerProposalMicroUsd: 10_800n })
    const call = { at: w.clock.now(), model: 'Sonnet 5.5', latencyMs: 7, costMicroUsd: 10_800n }
    expect(await ai.proposals({ guildId: GUILD, limit: 10 })).toEqual([{ ...call, mode: 'messages', actorId: TREASURER, outcome: 'proposed', runId: made.value.run.id }])
    expect(await ai.compiles({ guildId: GUILD, policyId })).toEqual({ 1: call, 2: call })
    expect(await ai.compiles({ guildId: GUILD, policyId: 'pol_unknown' })).toEqual({})
  })
})

describe('payoutsPortFromCore: what was paid each week, from the runs core paid', () => {
  it('the last 12 UTC weeks, a policy run apart from a run made by hand, paid runs only; null for an unknown community', async () => {
    const w = await world()
    const ALICE = '200000000000000011'
    const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
      if (!r.ok) throw new Error(r.error.code)
      return r.value
    }
    // Alice is a Mod who answered three questions in #help, registered, and the treasury has a key.
    const activity = w.activity as FakeActivityReader
    activity.setMember(ALICE, { roleIds: ['400000000000000002'], joinedAt: null })
    for (let i = 0; i < 3; i++) {
      activity.addMessages({ id: String(810000000000000200n + BigInt(i)), channelId: '700000000000000002', authorId: ALICE, authorIsBot: false, content: '', mentionIds: [], at: new Date(w.clock.now().getTime() - (i + 1) * 60_000), replyTo: { messageId: '810000000000000000', authorId: '200000000000000090' } })
    }
    const link = must(await w.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE }))
    must(await w.rolepay.payees.register({ token: link.token, address: '0x1111111111111111111111111111111111111111' }))
    must(await w.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 30 * 86_400, expiresAt: Math.floor(w.clock.now().getTime() / 1000) + 60 * 86_400 }))
    must(await w.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) }))
    w.chain.fund(TOKEN, TREASURY, usd('1000'))
    const pay = async (runId: string) => {
      must(await w.rolepay.payRuns.approve({ guildId: GUILD, runId, actor: TREASURER, actorCanApprove: true }))
      expect(must(await w.rolepay.payRuns.execute({ guildId: GUILD, runId })).status).toBe('paid')
    }
    // A policy's run (1 per answer: 3 AlphaUSD), and a run made by hand (5), both paid; a third waits for approval.
    const policy = must(await w.rolepay.policies.create({ ...asTreasurer, name: 'Help desk', instruction: RULE, schedule: toCoreSchedule(MONDAY) }))
    must(await w.rolepay.policies.approve({ ...asTreasurer, policyId: policy.id, version: 1 }))
    const made = must(await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: policy.id }))
    if (!made.run) throw new Error(`no run: ${made.policyRun.status}`)
    await pay(made.run.id)
    const byHand = must(await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, lines: [{ discordUserId: ALICE, amount: usd('5') }] }))
    must(await w.rolepay.payRuns.submit({ guildId: GUILD, runId: byHand.id, actor: TREASURER }))
    await pay(byHand.id)
    const waiting = must(await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, lines: [{ discordUserId: ALICE, amount: usd('7') }] }))
    must(await w.rolepay.payRuns.submit({ guildId: GUILD, runId: waiting.id, actor: TREASURER }))

    const port = payoutsPortFromCore(w.rolepay)
    const view = await port.paidByWeek({ guildId: GUILD })
    expect(view).toMatchObject({ token: TOKEN, total: usd('8'), policy: usd('3'), manual: usd('5'), runs: 2 })
    expect(view?.weeks).toHaveLength(12)
    expect(view?.weeks[11]).toEqual({ start: new Date('2026-10-05T00:00:00Z'), policy: usd('3'), manual: usd('5'), runs: 2, partial: true })
    expect(view?.weeks[0]?.start).toEqual(new Date('2026-07-20T00:00:00Z'))
    expect(await port.paidByWeek({ guildId: '1094309218049937499' })).toBeNull()
  })
})
