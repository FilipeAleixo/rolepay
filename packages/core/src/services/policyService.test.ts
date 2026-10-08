import { describe, expect, it } from 'vitest'
import { emptyCriteria } from '../adapters/memory/fakeProposer.js'
import { createRolepay } from '../index.js'
import {
  ANA,
  APPROVER,
  BIG,
  DAILY,
  DAVE,
  GUILD,
  HELP,
  INSTRUCTION,
  JUDGES,
  LI,
  MODS,
  MONDAY,
  MONDAYS,
  OTHER_GUILD,
  POSTS,
  RUI,
  START_HERE,
  T0,
  TODAY_18,
  TOKEN,
  TREASURER,
  TREASURER_TWO,
  WELCOME,
  WRITER,
  asTreasurer,
  asWriter,
  helpDeskAnswer,
  judgesAnswer,
  policyWorld,
  usd,
} from '../../test/support/policyWorld.js'

/** The audit stream's event types, oldest first. */
async function types(w: Awaited<ReturnType<typeof policyWorld>>) {
  const r = await w.rolepay.audit.list({ guildId: GUILD, limit: 500 })
  if (!r.ok) throw new Error(r.error.code)
  return r.value.events.map((e) => e.type).reverse()
}

describe('PolicyService.create: the AI writes the rule once', () => {
  it('compiles the instruction once with criteria mode and keeps the original text next to the compiled rule, as a draft', async () => {
    const w = await policyWorld()
    const r = await w.rolepay.policies.create({ ...asTreasurer, name: 'Help desk', instruction: INSTRUCTION, schedule: MONDAYS, caps: { perRun: usd(500) }, channelId: POSTS })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const p = r.value
    expect(p).toMatchObject({
      communityId: GUILD,
      name: 'Help desk',
      instruction: INSTRUCTION,
      status: 'draft',
      version: 1,
      mode: 'propose',
      vetoWindowMinutes: 24 * 60,
      autopilot: null,
      approvedBy: null,
      createdBy: TREASURER,
      channelId: POSTS,
      schedule: MONDAYS,
      caps: { perRun: usd(500), perPerson: null },
    })
    expect(p.compiled).toMatchObject({
      criteria: { hasRole: [MODS], repliesIn: { channelIds: [HELP], min: 1 } },
      plan: { rule: { kind: 'perUnit', amount: usd(1), per: 'replies', cap: usd(50) } },
      note: 'Help desk',
      amountsInInstruction: true,
    })
    // One model call, which saw tokens and names only, never a Discord ID.
    expect(w.proposer.requests).toHaveLength(1)
    expect(JSON.stringify(w.proposer.requests[0])).not.toMatch(/\d{17,20}/)
    const versions = await w.rolepay.policies.detail({ guildId: GUILD, policyId: p.id })
    expect(versions.ok && versions.value.versions.map((v) => [v.version, v.instruction, v.authoredBy, v.approvedBy])).toEqual([[1, INSTRUCTION, TREASURER, null]])
    expect(await types(w)).toEqual(['policy.created', 'policy.compiled'])
  })

  it('a proposer may write a policy; nobody else; and only with AI on and a model configured', async () => {
    const w = await policyWorld()
    expect((await w.rolepay.policies.create({ ...asWriter, instruction: INSTRUCTION, schedule: MONDAYS })).ok).toBe(true)
    expect(await w.rolepay.policies.create({ guildId: GUILD, actor: LI, actorRoleIds: [MODS], instruction: INSTRUCTION, schedule: MONDAYS })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.rolepay.policies.create({ ...asTreasurer, guildId: OTHER_GUILD, instruction: INSTRUCTION, schedule: MONDAYS })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await (await policyWorld({ ai: false })).rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: MONDAYS })).toEqual({ ok: false, error: { code: 'ai_disabled' } })
    expect(await (await policyWorld({ proposer: null })).rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: MONDAYS })).toEqual({ ok: false, error: { code: 'ai_not_configured' } })
  })

  it('refuses a bad schedule or cap before calling the model, and an instruction the filters cannot express stores nothing', async () => {
    const w = await policyWorld()
    expect(await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: { kind: 'weekly', weekday: 'monday', hour: 25 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: { ...MONDAYS, timezone: 'Mars/Base' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: MONDAYS, caps: { perRun: 0n } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(w.proposer.requests).toHaveLength(0)
    w.proposer.onCriteria = () => helpDeskAnswer({ understood: false, problem: 'Voice activity is not available.' })
    expect(await w.rolepay.policies.create({ ...asTreasurer, instruction: 'pay 5 to everyone in voice', schedule: MONDAYS })).toEqual({ ok: false, error: { code: 'criteria_unclear', problem: 'Voice activity is not available.' } })
    expect((await w.rolepay.policies.list({ guildId: GUILD })).length).toBe(0)
  })
})

describe('PolicyService.preview: who it applies to right now', () => {
  it('each person with their metric, why they match and what the next run would pay; the unregistered and the near misses apart', async () => {
    const w = await policyWorld()
    const p = await w.draft({ caps: { perPerson: usd(40) } })
    const r = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const v = r.value
    expect(v.window).toEqual({ start: new Date('2026-10-05T18:00:00Z'), end: T0 })
    expect(v.nextRunAt).toEqual(MONDAY)
    expect(v.matches.map((m) => [m.discordUserId, m.registered, m.metrics.replies, m.amount, m.capped])).toEqual([
      [BIG, true, 70, usd(40), true],
      [ANA, true, 12, usd(12), false],
      [RUI, true, 2, usd(2), false],
      [DAVE, false, 4, null, false],
    ])
    expect(v.matches[1]?.reasons).toEqual([
      { condition: 'hasRole', count: null, min: null },
      { condition: 'repliesIn', count: 12, min: 1 },
    ])
    expect(v.matches[1]?.reasonText).toBe(`has <@&${MODS}>; 12 replies to other people in <#${HELP}> (at least 1)`)
    expect(v.total).toBe(usd(54))
    expect(v.remaining).toBe(usd(1000))
    expect(v.problems).toEqual([])
    expect(v.rule[0]).toBe('1 per reply to other people, at most 50 each.')
    expect(v.nearMisses).toEqual([])
    // Li answered 15 times but is not a Mod: not listed at all.
    expect(v.matches.some((m) => m.discordUserId === LI)).toBe(false)
  })

  describe('the token each person will receive (preferred stablecoins)', () => {
    const BETA = '0x20c0000000000000000000000000000000000002'
    async function preferring(opts: { switchOn: boolean }) {
      const w = await policyWorld()
      const community = await w.repos.communities.get(GUILD)
      if (!community) throw new Error('no community')
      await w.repos.communities.update({ ...community, preferredTokens: opts.switchOn })
      const ana = await w.repos.payees.get(GUILD, ANA)
      if (!ana) throw new Error('no payee')
      await w.repos.payees.upsert({ ...ana, preferredToken: BETA })
      const p = await w.draft()
      const r = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      return Object.fromEntries(r.value.matches.map((m) => [m.discordUserId, [m.token, m.swapped]]))
    }

    it('with the switch on, a payee who chose BetaUSD receives BetaUSD (swapped); one without a preference, the payout token', async () => {
      const tokens = await preferring({ switchOn: true })
      expect(tokens[ANA]).toEqual([BETA, true])
      expect(tokens[RUI]).toEqual([TOKEN, false])
      expect(tokens[DAVE]).toEqual([TOKEN, false]) // not registered: nothing to prefer
    })

    it('with the switch off, the preference is ignored: everyone receives the payout token', async () => {
      const tokens = await preferring({ switchOn: false })
      expect(tokens[ANA]).toEqual([TOKEN, false])
      expect(tokens[RUI]).toEqual([TOKEN, false])
    })
  })

  it('people just below the line are listed with how far they are', async () => {
    const w = await policyWorld()
    w.proposer.onCriteria = () => helpDeskAnswer({}, 3)
    const p = await w.draft({ instruction: 'Every Monday: 1 per answered question in #help for Mods with at least 3 answers, max 50 a week each' })
    const r = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    expect(r.ok && r.value.nearMisses).toEqual([{ userId: RUI, condition: 'repliesIn', count: 2, min: 3, text: `2 replies to other people in <#${HELP}> (at least 3)` }])
  })

  it('never paid: the history is read from Rolepay\'s own runs, so someone this community paid does not match, and each match says why', async () => {
    const w = await policyWorld({ demoControls: true })
    w.proposer.onCriteria = () => judgesAnswer()
    const p = await w.draft({ name: 'Judges', instruction: JUDGES, schedule: DAILY })
    const paid = await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: [{ discordUserId: ANA, amount: usd(5) }] })
    if (!paid.ok) throw new Error(paid.error.code)
    await w.rolepay.payRuns.submit({ guildId: GUILD, runId: paid.value.id, actor: TREASURER })
    await w.rolepay.payRuns.approve({ guildId: GUILD, runId: paid.value.id, actor: TREASURER, actorCanApprove: true })
    await w.rolepay.payRuns.execute({ guildId: GUILD, runId: paid.value.id })
    // A draft for Rui does not count: it never paid anyone.
    await w.rolepay.payRuns.create({ guildId: GUILD, createdBy: TREASURER, note: null, lines: [{ discordUserId: RUI, amount: usd(5) }] })
    w.activity.setReactions(START_HERE, WELCOME, '✅', [ANA, RUI])
    const r = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.value.matches.map((m) => [m.discordUserId, m.amount, m.reasonText])).toEqual([[RUI, usd(1), 'reacted to the message; never paid by this community']])
    expect(r.value.rule[1]).toBe(`Who: reacted ✅ to https://discord.com/channels/${GUILD}/${START_HERE}/${WELCOME}; has never been paid by this community.`)
    expect(r.value.window.start).toEqual(new Date('2026-10-06T18:00:00Z'))
  })

  it('says when the next run would be over the bot key budget or over the policy cap (it would be held whole)', async () => {
    const w = await policyWorld({ limit: 50 })
    const p = await w.draft({ caps: { perRun: usd(60) } })
    const r = await w.rolepay.policies.preview({ guildId: GUILD, policyId: p.id })
    expect(r.ok && r.value.total).toBe(usd(64))
    expect(r.ok && r.value.problems).toEqual(['over_policy_cap', 'over_budget'])
  })
})

describe('PolicyService.approve: only the current approver role activates a policy', () => {
  it('records who and when, on the policy and its version', async () => {
    const w = await policyWorld()
    const p = await w.draft()
    w.travel(60)
    const r = await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 1 })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.value).toMatchObject({ status: 'active', approvedBy: TREASURER, approvedAt: new Date(T0.getTime() + 60_000), activeSince: new Date(T0.getTime() + 60_000) })
    const d = await w.rolepay.policies.detail({ guildId: GUILD, policyId: p.id })
    expect(d.ok && d.value.versions[0]).toMatchObject({ approvedBy: TREASURER, approvedAt: new Date(T0.getTime() + 60_000) })
    expect(d.ok && d.value.nextRunAt).toEqual(MONDAY)
    expect(await types(w)).toEqual(['policy.created', 'policy.compiled', 'policy.approved'])
  })

  it('a proposer, Manage Server or anyone without the approver role cannot; nor can anyone approve a version they did not see', async () => {
    const w = await policyWorld()
    const p = await w.draft()
    expect(await w.rolepay.policies.approve({ ...asWriter, policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.rolepay.policies.approve({ guildId: GUILD, actor: LI, actorRoleIds: [], policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 2 })).toEqual({ ok: false, error: { code: 'version_mismatch', version: 1 } })
    expect(await w.rolepay.policies.approve({ ...asTreasurer, guildId: OTHER_GUILD, policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect((await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 1 })).ok).toBe(true)
    expect(await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'policy_not_draft', status: 'active' } })
  })

  it('an amount the instruction never states blocks approval (rewrite the instruction)', async () => {
    const w = await policyWorld()
    const p = await w.draft({ instruction: 'Every Monday: pay each Mod per answered question in #help' })
    expect(p.compiled.amountsInInstruction).toBe(false)
    expect(await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'policy_blocked', problems: ['amount_not_in_instruction'] } })
  })

  it('four eyes: with a separate approver required, the author cannot approve their own policy', async () => {
    const w = await policyWorld({ separateApprover: true })
    const p = await w.draft()
    expect(await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 1 })).toEqual({ ok: false, error: { code: 'creator_cannot_approve' } })
    expect((await w.rolepay.policies.approve({ ...asTreasurer, actor: TREASURER_TWO, policyId: p.id, version: 1 })).ok).toBe(true)
  })
})

describe('PolicyService: edits make a new version that needs a new approval', () => {
  it('recompiles, stops the policy until approved, switches autopilot off, and keeps the history', async () => {
    const w = await policyWorld()
    const p = await w.active({}, { vetoWindowMinutes: 120 })
    expect(p.mode).toBe('autopilot')
    w.proposer.onCriteria = () => helpDeskAnswer({ amount: { kind: 'perUnit', amount: '2', per: 'replies', cap: '50', total: '', splitBy: '' } })
    const r = await w.rolepay.policies.edit({ ...asWriter, policyId: p.id, instruction: 'Every Monday: 2 per answered question in #help, max 50 a week each, for Mods' })
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    expect(r.value).toMatchObject({ version: 2, status: 'draft', mode: 'propose', autopilot: null, approvedBy: null, activeSince: null })
    expect(r.value.compiled.plan.rule).toMatchObject({ amount: usd(2) })
    expect(w.proposer.requests).toHaveLength(2)
    const d = await w.rolepay.policies.detail({ guildId: GUILD, policyId: p.id })
    expect(d.ok && d.value.versions.map((v) => [v.version, v.authoredBy, v.approvedBy])).toEqual([
      [1, TREASURER, TREASURER],
      [2, WRITER, null],
    ])
    expect((await w.rolepay.policies.approve({ ...asTreasurer, policyId: p.id, version: 2 })).ok).toBe(true)
  })

  it('a schedule or cap change needs no model call, but is still a new version', async () => {
    const w = await policyWorld()
    const p = await w.active()
    const r = await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, schedule: { ...MONDAYS, weekday: 'friday' }, caps: { perRun: usd(100), perPerson: null } })
    expect(r.ok && r.value).toMatchObject({ version: 2, status: 'draft', schedule: { weekday: 'friday' }, caps: { perRun: usd(100) } })
    expect(w.proposer.requests).toHaveLength(1)
  })

  it('discarding an edit restores the approved version, paused; discarding a new draft archives it', async () => {
    const w = await policyWorld()
    const p = await w.active()
    await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, name: 'Help desk, double' })
    const back = await w.rolepay.policies.discard({ ...asTreasurer, policyId: p.id })
    expect(back.ok && back.value).toMatchObject({ version: 1, status: 'paused', name: 'Help desk', approvedBy: TREASURER })
    const d = await w.rolepay.policies.detail({ guildId: GUILD, policyId: p.id })
    expect(d.ok && d.value.versions.map((v) => [v.version, v.discardedBy])).toEqual([
      [1, null],
      [2, TREASURER],
    ])
    const fresh = await w.draft()
    expect(await w.rolepay.policies.discard({ guildId: GUILD, actor: LI, actorRoleIds: [], policyId: fresh.id })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    const gone = await w.rolepay.policies.discard({ ...asTreasurer, policyId: fresh.id })
    expect(gone.ok && gone.value.status).toBe('archived')
  })
})

describe('PolicyService: pause, resume, modes and veto windows (the approver role only)', () => {
  it('pause and resume; resuming never backfills the periods it missed', async () => {
    const w = await policyWorld()
    const p = await w.active()
    expect(await w.rolepay.policies.pause({ ...asWriter, policyId: p.id })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect((await w.rolepay.policies.pause({ ...asTreasurer, policyId: p.id })).ok).toBe(true)
    expect(await w.rolepay.policies.pause({ ...asTreasurer, policyId: p.id })).toEqual({ ok: false, error: { code: 'policy_not_active', status: 'paused' } })
    w.travel(86_400)
    const resumed = await w.rolepay.policies.resume({ ...asTreasurer, policyId: p.id })
    expect(resumed.ok && resumed.value).toMatchObject({ status: 'active', activeSince: new Date(T0.getTime() + 86_400_000) })
    expect(await types(w)).toEqual(['policy.created', 'policy.compiled', 'policy.approved', 'policy.paused', 'policy.resumed'])
  })

  it('autopilot is an explicit switch by an approver, on an approved policy, with a veto window of at least an hour', async () => {
    const w = await policyWorld()
    const draft = await w.draft()
    expect(await w.rolepay.policies.setMode({ ...asTreasurer, policyId: draft.id, mode: 'autopilot' })).toEqual({ ok: false, error: { code: 'policy_not_approved' } })
    await w.rolepay.policies.approve({ ...asTreasurer, policyId: draft.id, version: 1 })
    expect(await w.rolepay.policies.setMode({ ...asWriter, policyId: draft.id, mode: 'autopilot' })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    expect(await w.rolepay.policies.setMode({ ...asTreasurer, policyId: draft.id, mode: 'autopilot', vetoWindowMinutes: 30 })).toEqual({ ok: false, error: { code: 'invalid_veto_window', min: 60, max: 10_080 } })
    const r = await w.rolepay.policies.setMode({ ...asTreasurer, policyId: draft.id, mode: 'autopilot', vetoWindowMinutes: 90 })
    expect(r.ok && r.value).toMatchObject({ mode: 'autopilot', vetoWindowMinutes: 90, autopilot: { enabledBy: TREASURER, enabledAt: T0, approverRoleId: APPROVER } })
    const back = await w.rolepay.policies.setMode({ ...asTreasurer, policyId: draft.id, mode: 'propose' })
    expect(back.ok && back.value).toMatchObject({ mode: 'propose', autopilot: null, vetoWindowMinutes: 90 })
  })

  it('a server running with a shorter minimum (the testnet dev setting) allows a one-minute veto window for testing', async () => {
    const w = await policyWorld({ minVetoMinutes: 1 })
    const p = await w.active({}, { vetoWindowMinutes: 1 })
    expect(p.vetoWindowMinutes).toBe(1)
  })

  it('four eyes: the author of the rule cannot switch its autopilot on', async () => {
    const w = await policyWorld({ separateApprover: true })
    const p = await w.draft()
    await w.rolepay.policies.approve({ ...asTreasurer, actor: TREASURER_TWO, policyId: p.id, version: 1 })
    expect(await w.rolepay.policies.setMode({ ...asTreasurer, policyId: p.id, mode: 'autopilot' })).toEqual({ ok: false, error: { code: 'creator_cannot_approve' } })
    expect((await w.rolepay.policies.setMode({ ...asTreasurer, actor: TREASURER_TWO, policyId: p.id, mode: 'autopilot' })).ok).toBe(true)
  })

  it('archive is final', async () => {
    const w = await policyWorld()
    const p = await w.active()
    expect((await w.rolepay.policies.archive({ ...asTreasurer, policyId: p.id })).ok).toBe(true)
    expect(await w.rolepay.policies.resume({ ...asTreasurer, policyId: p.id })).toEqual({ ok: false, error: { code: 'policy_archived' } })
    expect(await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, name: 'x' })).toEqual({ ok: false, error: { code: 'policy_archived' } })
  })
})

describe('PolicyService: reading', () => {
  it('lists policies with their next run, and the next runs across the community', async () => {
    const w = await policyWorld()
    const a = await w.active()
    w.travel(60)
    const b = await w.draft({ name: 'Monthly', schedule: { kind: 'monthly', day: 1, hour: 9, timezone: 'UTC' } })
    await w.rolepay.policies.approve({ ...asTreasurer, policyId: b.id, version: 1 })
    w.travel(60)
    const c = await w.draft({ name: 'Still a draft' })
    const list = await w.rolepay.policies.list({ guildId: GUILD })
    expect(list.map((x) => [x.policy.id, x.nextRunAt])).toEqual([
      [c.id, null],
      [b.id, new Date('2026-11-01T09:00:00Z')],
      [a.id, MONDAY],
    ])
    expect((await w.rolepay.policies.nextRuns({ guildId: GUILD })).map((x) => [x.policyId, x.at])).toEqual([
      [a.id, MONDAY],
      [b.id, new Date('2026-11-01T09:00:00Z')],
    ])
    expect(await w.rolepay.policies.get({ guildId: OTHER_GUILD, policyId: a.id })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
  })
})

describe('PolicyService: a daily schedule exists only with the testnet demo controls', () => {
  it('without them, creating a daily policy is refused before the model is called, and nothing is stored or billed', async () => {
    const w = await policyWorld()
    expect(w.rolepay.policies.dailySchedules).toBe(false)
    expect(await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: DAILY })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect(w.proposer.requests).toHaveLength(0)
    expect(await w.repos.aiUsage.list(GUILD)).toEqual([])
    expect(await w.rolepay.policies.list({ guildId: GUILD })).toEqual([])
  })

  it('without them, an edit that would leave a policy daily is refused, a recompile included', async () => {
    const w = await policyWorld()
    const p = await w.active()
    expect(await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, schedule: DAILY })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect(await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, instruction: `${INSTRUCTION}, every day`, schedule: DAILY })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect(w.proposer.requests).toHaveLength(1)
    const stored = await w.rolepay.policies.get({ guildId: GUILD, policyId: p.id })
    expect(stored.ok && [stored.value.version, stored.value.status]).toEqual([1, 'active'])
  })

  it('off Moderato they never exist, whatever the caller passes (config refuses the flag there too)', async () => {
    const w = await policyWorld({ demoControls: true })
    const mainnet = createRolepay({ ...w.deps, network: 'mainnet', demoControls: true })
    expect(mainnet.policies.dailySchedules).toBe(false)
    expect(await mainnet.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: DAILY })).toMatchObject({ ok: false, error: { code: 'schedule_not_allowed' } })
  })

  it('with them, a daily policy is written, approved and runs every day at its hour; its rule says so in plain words', async () => {
    const w = await policyWorld({ demoControls: true })
    expect(w.rolepay.policies.dailySchedules).toBe(true)
    const p = await w.active({ schedule: DAILY })
    expect(p).toMatchObject({ status: 'active', schedule: DAILY })
    const d = await w.rolepay.policies.detail({ guildId: GUILD, policyId: p.id })
    expect(d.ok && d.value.nextRunAt).toEqual(TODAY_18)
    expect(d.ok && d.value.rule[2]).toBe('When: every day at 18:00 (UTC), counting activity since the previous run.')
    expect((await w.rolepay.policies.nextRuns({ guildId: GUILD })).map((r) => r.at)).toEqual([TODAY_18])
    const edited = await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, schedule: { ...DAILY, hour: 9 } })
    expect(edited.ok && edited.value.schedule).toEqual({ ...DAILY, hour: 9 })
  })

  it('a daily policy left over from a server that had them is not approved, resumed or listed with a next run by one that does not', async () => {
    const w = await policyWorld({ demoControls: true })
    const draft = await w.draft({ schedule: DAILY })
    const active = await w.active({ name: 'Judges', schedule: DAILY })
    await w.rolepay.policies.pause({ ...asTreasurer, policyId: active.id })
    const without = createRolepay({ ...w.deps, demoControls: false }).policies
    expect(await without.approve({ ...asTreasurer, policyId: draft.id, version: 1 })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect(await without.resume({ ...asTreasurer, policyId: active.id })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect((await w.rolepay.policies.resume({ ...asTreasurer, policyId: active.id })).ok).toBe(true)
    expect((await without.list({ guildId: GUILD })).map((x) => x.nextRunAt)).toEqual([null, null])
    expect(await without.nextRuns({ guildId: GUILD })).toEqual([])
  })
})

describe('PolicyService: the ai_usage record of each compile', () => {
  it('create, and an edit with a new instruction, each store one row linked to the version they made; other edits call no model', async () => {
    const w = await policyWorld()
    const p = await w.draft()
    expect((await w.rolepay.policies.edit({ ...asTreasurer, policyId: p.id, name: 'Renamed' })).ok).toBe(true)
    const e = await w.rolepay.policies.edit({ ...asWriter, policyId: p.id, instruction: `${INSTRUCTION}, from today` })
    expect(e.ok && e.value.version).toBe(3)
    expect((await w.repos.aiUsage.list(GUILD)).map((u) => [u.purpose, u.actor, u.model, u.outcome, u.policyId, u.policyVersion, u.costMicroUsd, u.proposalId])).toEqual([
      ['policy_compile', WRITER, 'fake-proposer', 'proposed', p.id, 3, 10_800n, null],
      ['policy_compile', TREASURER, 'fake-proposer', 'proposed', p.id, 1, 10_800n, null],
    ])
  })

  it('a compile that fails after the model call is stored with its code and links no version; past the daily cap nothing is', async () => {
    const w = await policyWorld()
    w.proposer.onCriteria = () => emptyCriteria({ understood: false, problem: 'Voice activity is not available.' })
    expect((await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: MONDAYS })).ok).toBe(false)
    w.proposer.onCriteria = () => ({ code: 'could_not_propose', reason: 'daily_cap', detail: 'daily cap of 50 model calls reached', usage: null })
    expect((await w.rolepay.policies.create({ ...asTreasurer, instruction: INSTRUCTION, schedule: MONDAYS })).ok).toBe(false)
    expect((await w.repos.aiUsage.list(GUILD)).map((u) => [u.purpose, u.outcome, u.policyId, u.policyVersion, u.costMicroUsd])).toEqual([['policy_compile', 'criteria_unclear', null, null, 10_800n]])
  })
})
