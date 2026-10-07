import { describe, expect, it } from 'vitest'
import { GUILD, MONDAY, TREASURER, asTreasurer, policyWorld } from '../../test/support/policyWorld.js'

describe('AuditService: the governance report', () => {
  it('pages newest first with a cursor, filters by type, actor and policy, and refuses a bad query', async () => {
    const w = await policyWorld()
    const p = await w.active({}, { vetoWindowMinutes: 60 })
    w.travelTo(MONDAY)
    await w.rolepay.scheduler.tick()
    w.travel(3600)
    await w.rolepay.scheduler.tick()

    const first = await w.rolepay.audit.list({ guildId: GUILD, limit: 3 })
    if (!first.ok) throw new Error(first.error.code)
    expect(first.value.events.map((e) => e.type)).toEqual(['policy_run.released', 'run.paid', 'run.executing'])
    const second = await w.rolepay.audit.list({ guildId: GUILD, limit: 3, before: first.value.next })
    expect(second.ok && second.value.events.map((e) => e.type)).toEqual(['run.approved', 'policy_run.generated', 'run.submitted'])

    const mine = await w.rolepay.audit.list({ guildId: GUILD, actor: TREASURER })
    expect(mine.ok && mine.value.events.every((e) => e.actor === TREASURER)).toBe(true)
    expect(mine.ok && mine.value.events.map((e) => e.type)).toContain('run.approved') // autopilot approves in the treasurer's name
    const rolepayItself = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_run.generated', 'policy_run.released'] })
    expect(rolepayItself.ok && rolepayItself.value.events.map((e) => [e.type, e.actor, e.policyId])).toEqual([
      ['policy_run.released', null, p.id],
      ['policy_run.generated', null, p.id],
    ])
    expect(await w.rolepay.audit.list({ guildId: GUILD, limit: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.rolepay.audit.list({ guildId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('exports every matching event as CSV, oldest first, with no user text', async () => {
    const w = await policyWorld()
    const p = await w.active()
    await w.rolepay.policies.pause({ ...asTreasurer, policyId: p.id })
    const r = await w.rolepay.audit.exportCsv({ guildId: GUILD, policyId: p.id })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.filename).toBe(`rolepay-audit-${GUILD}.csv`)
    expect(r.value.count).toBe(4)
    const rows = r.value.csv.trim().split('\r\n')
    expect(rows[0]).toBe('seq,at,type,actor,policy_id,policy_version,policy_run_id,run_id,details')
    expect(rows.slice(1).map((row) => row.split(',')[2])).toEqual(['policy.created', 'policy.compiled', 'policy.approved', 'policy.paused'])
    expect(r.value.csv).not.toContain('answered question') // the instruction stays on the policy, not in the audit
  })
})
