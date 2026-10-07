import { describe, expect, it } from 'vitest'
import { emptyCriteria } from '../adapters/memory/fakeProposer.js'
import { createRolepay } from '../index.js'
import {
  ANA,
  BIG,
  DAILY,
  DAVE,
  GUILD,
  MONDAY,
  MONDAYS,
  RUI,
  T0,
  TODAY_18,
  TOKEN,
  TREASURER,
  TREASURY,
  addressOf,
  asTreasurer,
  asWriter,
  policyWorld,
  usd,
} from '../../test/support/policyWorld.js'

const HOUR = 3600
const DAY = 86_400

async function typesSince(w: Awaited<ReturnType<typeof policyWorld>>, after: string) {
  const r = await w.rolepay.audit.list({ guildId: GUILD, limit: 500 })
  if (!r.ok) throw new Error(r.error.code)
  const all = r.value.events.map((e) => e.type).reverse()
  return all.slice(all.indexOf(after as (typeof all)[number]) + 1)
}

describe('SchedulerService: propose mode', () => {
  it('nothing before the first period after approval; at Monday 18:00 one run, made by code over the week since the previous Monday', async () => {
    const w = await policyWorld()
    const p = await w.active()
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    w.travelTo(new Date(MONDAY.getTime() - 1000))
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])

    w.travelTo(MONDAY)
    const { events, errors } = await w.rolepay.scheduler.tick()
    expect(errors).toEqual([])
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e?.kind).toBe('generated')
    expect(e?.policyRun).toMatchObject({
      policyId: p.id,
      policyVersion: 1,
      status: 'proposed',
      mode: 'propose',
      periodStart: new Date('2026-10-05T18:00:00Z'),
      periodEnd: MONDAY,
      total: usd(64),
      remaining: usd(1000),
      hold: null,
    })
    expect(e?.policyRun.lines.map((l) => [l.discordUserId, l.amount, l.metrics.replies, l.capped])).toEqual([
      [BIG, usd(50), 70, true],
      [ANA, usd(12), 12, false],
      [RUI, usd(2), 2, false],
    ])
    expect(e?.policyRun.unregistered.map((u) => u.discordUserId)).toEqual([DAVE])
    // The run is a normal run waiting for the one-tap approval, created in the author's name.
    expect(e?.run).toMatchObject({ id: e?.policyRun.runId, status: 'pending_approval', createdBy: TREASURER, total: usd(64), note: 'Help desk' })
    expect(e?.run?.lines.map((l) => [l.payeeDiscordId, l.address, l.amount])).toEqual([
      [BIG, addressOf(BIG), usd(50)],
      [ANA, addressOf(ANA), usd(12)],
      [RUI, addressOf(RUI), usd(2)],
    ])
    expect(await typesSince(w, 'policy.approved')).toEqual(['run.created', 'run.submitted', 'policy_run.generated'])
    // Its audit events say which policy and version made it.
    const audit = await w.rolepay.audit.list({ guildId: GUILD, runId: e?.run?.id as string })
    expect(audit.ok && audit.value.events.map((x) => [x.type, x.policyId, x.policyVersion, x.policyRunId])).toEqual([
      ['policy_run.generated', p.id, 1, e?.policyRun.id],
      ['run.submitted', p.id, 1, e?.policyRun.id],
      ['run.created', p.id, 1, e?.policyRun.id],
    ])
    expect(await w.rolepay.policies.runFor({ guildId: GUILD, runId: e?.run?.id as string })).toMatchObject({ policy: { id: p.id }, policyRun: { id: e?.policyRun.id } })
  })

  it('one run per policy per period: a second tick, a restart and a second instance make nothing more', async () => {
    const w = await policyWorld()
    await w.active()
    w.travelTo(MONDAY)
    // Two instances (or two ticks) at the same moment.
    const restarted = createRolepay(w.deps)
    const [a, b] = await Promise.all([w.rolepay.scheduler.tick(), restarted.scheduler.tick()])
    expect(a.events.length + b.events.length).toBe(1)
    w.travel(30)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect((await createRolepay(w.deps).scheduler.tick()).events).toEqual([])
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
    // The next Monday is a new period.
    w.travelTo(new Date(MONDAY.getTime() + 7 * DAY * 1000))
    expect((await w.rolepay.scheduler.tick()).events.map((e) => e.policyRun.periodStart)).toEqual([MONDAY])
  })

  it('runs in the community timezone: Monday 18:00 in Lisbon is 17:00 UTC in October', async () => {
    const w = await policyWorld()
    await w.active({ schedule: { ...MONDAYS, timezone: 'Europe/Lisbon' } })
    w.travelTo(new Date('2026-10-12T16:59:59Z'))
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    w.travelTo(new Date('2026-10-12T17:00:00Z'))
    expect((await w.rolepay.scheduler.tick()).events.map((e) => e.policyRun.periodEnd)).toEqual([new Date('2026-10-12T17:00:00Z')])
  })

  it('a paused policy makes nothing, and resuming does not backfill the period it missed', async () => {
    const w = await policyWorld()
    const p = await w.active()
    await w.rolepay.policies.pause({ ...asTreasurer, policyId: p.id })
    w.travelTo(MONDAY)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    w.travel(HOUR)
    await w.rolepay.policies.resume({ ...asTreasurer, policyId: p.id })
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
  })
})

describe('SchedulerService: guardrails (held whole and explained, never paid in part)', () => {
  it('a run over the bot key remaining budget is held with the numbers; no run is created', async () => {
    const w = await policyWorld({ limit: 50 })
    await w.active()
    w.travelTo(MONDAY)
    const [e] = (await w.rolepay.scheduler.tick()).events
    expect(e).toMatchObject({ kind: 'generated', run: null, policyRun: { status: 'held', runId: null, hold: { code: 'over_budget', total: usd(64), limit: usd(50) }, total: usd(64) } })
    expect(await w.repos.runs.listByCommunity(GUILD)).toEqual([])
    expect(await typesSince(w, 'policy.approved')).toEqual(['policy_run.held'])
  })

  it('over the policy cap per run, too many people, no active key, or nobody matching', async () => {
    const capped = await policyWorld()
    await capped.active({ caps: { perRun: usd(60) } })
    capped.travelTo(MONDAY)
    expect((await capped.rolepay.scheduler.tick()).events[0]?.policyRun.hold).toEqual({ code: 'over_policy_cap', total: usd(64), limit: usd(60) })

    const noKey = await policyWorld()
    await noKey.active()
    await noKey.rolepay.communities.revokeBotKey({ guildId: GUILD, root: noKey.chain.rootSigner(TREASURY) })
    noKey.travelTo(MONDAY)
    expect((await noKey.rolepay.scheduler.tick()).events[0]?.policyRun.hold).toMatchObject({ code: 'no_active_key' })

    const quiet = await policyWorld()
    await quiet.active()
    quiet.travelTo(new Date(MONDAY.getTime() + 7 * DAY * 1000)) // the week after: nobody answered
    const [e] = (await quiet.rolepay.scheduler.tick()).events
    expect(e?.policyRun).toMatchObject({ status: 'empty', runId: null, total: 0n })
  })
})

describe('SchedulerService: autopilot', () => {
  it('posts the run with its veto window, then pays it once the window has passed, in the name of the approver who switched autopilot on', async () => {
    const w = await policyWorld()
    const p = await w.active({}, { vetoWindowMinutes: 24 * 60 })
    w.travelTo(MONDAY)
    const [gen] = (await w.rolepay.scheduler.tick()).events
    expect(gen?.policyRun).toMatchObject({ status: 'scheduled', mode: 'autopilot', executeAfter: new Date(MONDAY.getTime() + DAY * 1000) })
    expect(gen?.run?.status).toBe('pending_approval')

    w.travel(DAY - 1)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect(w.chain.landedTxCount).toBe(0)

    w.travel(1)
    const [rel] = (await w.rolepay.scheduler.tick()).events
    expect(rel).toMatchObject({ kind: 'released', outcome: 'paid', policyRun: { status: 'released', releasedBy: TREASURER }, run: { status: 'paid', approvedBy: TREASURER } })
    expect(w.chain.landedTxCount).toBe(1)
    expect([BIG, ANA, RUI].map((u) => w.chain.balance(TOKEN, addressOf(u)))).toEqual([usd(50), usd(12), usd(2)])
    expect(await typesSince(w, 'policy.mode_changed')).toEqual(['run.created', 'run.submitted', 'policy_run.generated', 'run.approved', 'run.executing', 'run.paid', 'policy_run.released'])
    // Nothing more on later ticks.
    w.travel(60)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect(w.chain.landedTxCount).toBe(1)
    expect((await w.rolepay.policies.listRuns({ guildId: GUILD, policyId: p.id })).map((r) => r.status)).toEqual(['released'])
  })

  it('a veto inside the window (the approver role only) cancels the run: never paid', async () => {
    const w = await policyWorld()
    await w.active({}, { vetoWindowMinutes: 60 })
    w.travelTo(MONDAY)
    const [gen] = (await w.rolepay.scheduler.tick()).events
    const policyRunId = gen?.policyRun.id as string
    expect(await w.rolepay.policies.veto({ ...asWriter, policyRunId })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    w.travel(30 * 60)
    const v = await w.rolepay.policies.veto({ ...asTreasurer, policyRunId })
    expect(v.ok && v.value.policyRun).toMatchObject({ status: 'vetoed', vetoedBy: TREASURER, vetoedAt: new Date(MONDAY.getTime() + 30 * 60_000) })
    expect(v.ok && v.value.run).toMatchObject({ status: 'cancelled', cancelledBy: TREASURER })
    w.travel(HOUR)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect(w.chain.landedTxCount).toBe(0)
    expect(await w.rolepay.policies.veto({ ...asTreasurer, policyRunId })).toEqual({ ok: false, error: { code: 'not_scheduled', status: 'vetoed' } })
    expect(await typesSince(w, 'policy_run.generated')).toEqual(['run.cancelled', 'policy_run.vetoed'])
  })

  it('a veto after the window but before the release still counts; after the release it is too late', async () => {
    const w = await policyWorld()
    await w.active({}, { vetoWindowMinutes: 60 })
    w.travelTo(MONDAY)
    const [gen] = (await w.rolepay.scheduler.tick()).events
    w.travel(2 * HOUR)
    expect((await w.rolepay.policies.veto({ ...asTreasurer, policyRunId: gen?.policyRun.id as string })).ok).toBe(true)

    const late = await policyWorld()
    await late.active({}, { vetoWindowMinutes: 60 })
    late.travelTo(MONDAY)
    const [g2] = (await late.rolepay.scheduler.tick()).events
    late.travel(HOUR)
    await late.rolepay.scheduler.tick()
    expect(await late.rolepay.policies.veto({ ...asTreasurer, policyRunId: g2?.policyRun.id as string })).toEqual({ ok: false, error: { code: 'not_scheduled', status: 'released' } })
  })

  it('stops (the run waits for a person) when the policy was paused, switched to propose, or the approver lost the role', async () => {
    for (const change of ['pause', 'propose', 'role'] as const) {
      const w = await policyWorld()
      const p = await w.active({}, { vetoWindowMinutes: 60 })
      w.travelTo(MONDAY)
      const [gen] = (await w.rolepay.scheduler.tick()).events
      if (change === 'pause') await w.rolepay.policies.pause({ ...asTreasurer, policyId: p.id })
      if (change === 'propose') await w.rolepay.policies.setMode({ ...asTreasurer, policyId: p.id, mode: 'propose' })
      if (change === 'role') w.activity.setMember(TREASURER, { roleIds: [], joinedAt: null })
      w.travel(HOUR)
      const [held] = (await w.rolepay.scheduler.tick()).events
      const code = { pause: 'policy_not_active', propose: 'autopilot_off', role: 'approver_changed' }[change]
      expect([change, held?.kind, held?.policyRun.hold?.code, held?.run?.status]).toEqual([change, 'held', code, 'pending_approval'])
      expect(held?.run?.id).toBe(gen?.run?.id)
      expect(w.chain.landedTxCount).toBe(0)
    }
  })

  it('a key that can no longer pay (revoked during the window) holds the approved run; it is never partly paid', async () => {
    const w = await policyWorld()
    await w.active({}, { vetoWindowMinutes: 60 })
    w.travelTo(MONDAY)
    await w.rolepay.scheduler.tick()
    await w.rolepay.communities.revokeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) })
    w.travel(HOUR)
    const [held] = (await w.rolepay.scheduler.tick()).events
    expect(held).toMatchObject({ kind: 'held', policyRun: { status: 'held', hold: { code: 'no_active_key' } }, run: { status: 'approved' } })
    expect(w.chain.landedTxCount).toBe(0)
  })

  it('no AI at runtime: the whole cycle runs with a model that fails on any call', async () => {
    const w = await policyWorld()
    await w.active({}, { vetoWindowMinutes: 60 })
    const calls = w.proposer.requests.length
    w.proposer.onCriteria = () => {
      throw new Error('the model must never be called at runtime')
    }
    w.travelTo(MONDAY)
    await w.rolepay.scheduler.tick()
    w.travel(HOUR)
    const [rel] = (await w.rolepay.scheduler.tick()).events
    expect(rel?.outcome).toBe('paid')
    expect(w.proposer.requests.length).toBe(calls)
  })
})

describe('SchedulerService: crashes and restarts', () => {
  it('a crash after the period was claimed and before the run was made: another tick takes over once the lease runs out', async () => {
    const w = await policyWorld()
    await w.active()
    const insert = w.repos.runs.insert.bind(w.repos.runs)
    let crash = true
    w.repos.runs.insert = async (r) => {
      if (crash) {
        crash = false
        throw new Error('process died')
      }
      return insert(r)
    }
    w.travelTo(MONDAY)
    const first = await w.rolepay.scheduler.tick()
    expect(first.errors).toHaveLength(1)
    w.travel(60)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([]) // still leased by the "dead" instance
    w.travel(300)
    const [e] = (await createRolepay(w.deps).scheduler.tick()).events
    expect(e?.policyRun.status).toBe('proposed')
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
  })

  it('a crash after the run was made and before it was linked never makes a second run', async () => {
    const w = await policyWorld()
    await w.active()
    const update = w.repos.policyRuns.update.bind(w.repos.policyRuns)
    let crash = true
    w.repos.policyRuns.update = async (r) => {
      if (crash && r.status === 'proposed') {
        crash = false
        throw new Error('process died')
      }
      return update(r)
    }
    w.travelTo(MONDAY)
    expect((await w.rolepay.scheduler.tick()).errors).toHaveLength(1)
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
    w.travel(301)
    const [e] = (await w.rolepay.scheduler.tick()).events
    expect(e?.policyRun).toMatchObject({ status: 'proposed', runId: (await w.repos.runs.listByCommunity(GUILD))[0]?.id })
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
  })

  it('a crash after an autopilot run was paid and before it was marked released pays nothing twice', async () => {
    const w = await policyWorld()
    await w.active({}, { vetoWindowMinutes: 60 })
    w.travelTo(MONDAY)
    await w.rolepay.scheduler.tick()
    const update = w.repos.policyRuns.update.bind(w.repos.policyRuns)
    let crash = true
    w.repos.policyRuns.update = async (r) => {
      if (crash && r.status === 'released') {
        crash = false
        throw new Error('process died')
      }
      return update(r)
    }
    w.travel(HOUR)
    expect((await w.rolepay.scheduler.tick()).errors).toHaveLength(1)
    expect(w.chain.landedTxCount).toBe(1)
    w.travel(301)
    const [rel] = (await createRolepay(w.deps).scheduler.tick()).events
    expect(rel).toMatchObject({ kind: 'released', outcome: 'paid' })
    expect(w.chain.landedTxCount).toBe(1)
  })
})

describe('SchedulerService: a daily policy (the testnet demo controls)', () => {
  /** "1 to every Mod", every day at 18:00 UTC: Ana, Rui and Big are registered Mods. */
  const flatToMods = (w: Awaited<ReturnType<typeof policyWorld>>, roleToken = 'R2') => {
    w.proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' } }, { hasRole: [roleToken] })
  }

  it('one run a day at its hour, over the day since the previous run; a second tick, a restart and a second instance make nothing more', async () => {
    const w = await policyWorld({ demoControls: true })
    flatToMods(w)
    const p = await w.active({ instruction: 'Every day: 1 to every Mod', schedule: DAILY })
    w.travelTo(new Date(TODAY_18.getTime() - 1000))
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    w.travelTo(TODAY_18)
    const [a, b] = await Promise.all([w.rolepay.scheduler.tick(), createRolepay(w.deps).scheduler.tick()])
    const made = [...a.events, ...b.events]
    expect(made).toHaveLength(1)
    expect(made[0]?.policyRun).toMatchObject({ policyId: p.id, status: 'proposed', periodStart: new Date('2026-10-06T18:00:00Z'), periodEnd: TODAY_18, total: usd(3) })
    w.travel(HOUR)
    expect((await createRolepay(w.deps).scheduler.tick()).events).toEqual([])
    // Tomorrow is a new period, and the day after another: one run each.
    w.travelTo(new Date(TODAY_18.getTime() + DAY * 1000))
    expect((await w.rolepay.scheduler.tick()).events.map((e) => e.policyRun.periodStart)).toEqual([TODAY_18])
    w.travelTo(new Date(TODAY_18.getTime() + (2 * DAY + 5) * 1000))
    expect((await w.rolepay.scheduler.tick()).events).toHaveLength(1)
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(3)
  })

  it('a server that was down for days makes one run, for the latest day, not a backlog', async () => {
    const w = await policyWorld({ demoControls: true })
    flatToMods(w)
    await w.active({ instruction: 'Every day: 1 to every Mod', schedule: DAILY })
    w.travelTo(new Date(TODAY_18.getTime() + (3 * DAY + HOUR) * 1000))
    expect((await w.rolepay.scheduler.tick()).events.map((e) => e.policyRun.periodEnd)).toEqual([new Date(TODAY_18.getTime() + 3 * DAY * 1000)])
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
  })

  it('on autopilot with the demo minimum window (1 minute) it pays with nobody online, in the name of the approver who switched it on', async () => {
    const w = await policyWorld({ demoControls: true, minVetoMinutes: 1 })
    flatToMods(w)
    await w.active({ instruction: 'Every day: 1 to every Mod', schedule: DAILY }, { vetoWindowMinutes: 1 })
    w.travelTo(TODAY_18)
    const [gen] = (await w.rolepay.scheduler.tick()).events
    expect(gen?.policyRun).toMatchObject({ status: 'scheduled', executeAfter: new Date(TODAY_18.getTime() + 60_000) })
    w.travel(60)
    const [rel] = (await w.rolepay.scheduler.tick()).events
    expect(rel).toMatchObject({ kind: 'released', outcome: 'paid', run: { approvedBy: TREASURER } })
    expect(w.chain.balance(TOKEN, addressOf(ANA))).toBe(usd(1))
  })

  it('zero matches: no pay run, the day is recorded once as empty (the audit log says so quietly), and the next day is checked again', async () => {
    const w = await policyWorld({ demoControls: true })
    flatToMods(w, 'R1') // the Treasurer role: nobody registered holds it
    await w.active({ instruction: 'Every day: 1 to every Treasurer', schedule: DAILY }, { vetoWindowMinutes: 60 })
    w.travelTo(TODAY_18)
    const [e] = (await w.rolepay.scheduler.tick()).events
    expect(e).toMatchObject({ kind: 'generated', run: null, policyRun: { status: 'empty', runId: null, total: 0n, lines: [] } })
    expect((await w.rolepay.scheduler.tick()).events).toEqual([])
    expect(await createRolepay(w.deps).scheduler.tick()).toEqual({ events: [], errors: [] })
    expect(await w.repos.runs.listByCommunity(GUILD)).toEqual([])
    expect(await typesSince(w, 'policy.mode_changed')).toEqual(['policy_run.empty'])
    w.travelTo(new Date(TODAY_18.getTime() + DAY * 1000))
    expect((await w.rolepay.scheduler.tick()).events.map((x) => x.policyRun.status)).toEqual(['empty'])
    expect(await typesSince(w, 'policy.mode_changed')).toEqual(['policy_run.empty', 'policy_run.empty'])
    expect(w.chain.landedTxCount).toBe(0)
  })

  it('a server without the demo controls never runs a daily policy (one approved while they were on), and run_now refuses it', async () => {
    const w = await policyWorld({ demoControls: true })
    flatToMods(w)
    const p = await w.active({ instruction: 'Every day: 1 to every Mod', schedule: DAILY })
    const without = createRolepay({ ...w.deps, demoControls: false })
    w.travelTo(TODAY_18)
    expect(await without.scheduler.tick()).toEqual({ events: [], errors: [] })
    expect(await without.scheduler.runNow({ ...asTreasurer, policyId: p.id })).toEqual({ ok: false, error: { code: 'schedule_not_allowed', kind: 'daily' } })
    expect(await w.repos.runs.listByCommunity(GUILD)).toEqual([])
    expect(await w.rolepay.policies.listRuns({ guildId: GUILD, policyId: p.id })).toEqual([])
  })
})

describe('SchedulerService.runNow (the testnet dev shortcut: "time skips to Monday")', () => {
  it('makes the next period run now, for an approver; the scheduled tick later does not make it again', async () => {
    const w = await policyWorld()
    const p = await w.active({}, { vetoWindowMinutes: 60 })
    expect(await w.rolepay.scheduler.runNow({ ...asWriter, policyId: p.id })).toEqual({ ok: false, error: { code: 'not_permitted' } })
    const r = await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: p.id })
    expect(r.ok && r.value.policyRun).toMatchObject({ status: 'scheduled', periodEnd: MONDAY, executeAfter: new Date(T0.getTime() + HOUR * 1000) })
    expect(await w.rolepay.scheduler.runNow({ ...asTreasurer, policyId: p.id })).toMatchObject({ ok: false, error: { code: 'already_run' } })
    w.travelTo(MONDAY)
    expect((await w.rolepay.scheduler.tick()).events.filter((e) => e.kind === 'generated')).toEqual([])
    expect(await w.repos.runs.listByCommunity(GUILD)).toHaveLength(1)
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_run.generated'] })
    expect(audit.ok && audit.value.events.map((e) => e.actor)).toEqual([TREASURER])
  })
})
