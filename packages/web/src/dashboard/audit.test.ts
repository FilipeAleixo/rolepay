import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function setup() {
  const h = dashboardHarness()
  await h.community()
  const policyId = h.policies.seed(GUILD, { id: 'pol_1', name: 'Weekly helpers', instruction: 'x' })
  const at = (m: number) => new Date(Date.UTC(2026, 9, 5, 18, m))
  h.policies.addEvent(GUILD, { id: 'evt_1', at: at(0), type: 'policy.approved', actorId: TREASURER.id, policyId, runId: null, summary: 'Approved version 1 of "Weekly helpers".' })
  h.policies.addEvent(GUILD, { id: 'evt_2', at: at(1), type: 'run.generated', actorId: null, policyId, runId: 'run_000007', summary: 'Generated a run of 62 AlphaUSD for 3 people.' })
  h.policies.addEvent(GUILD, { id: 'evt_3', at: at(2), type: 'run.vetoed', actorId: MEMBER.id, policyId, runId: 'run_000007', summary: '=cmd|"/c calc"!A1' })
  return { h, policyId }
}

describe('Audit log', () => {
  it('lists every event newest first: when, what, who (Rolepay for the scheduler), which policy and run, in plain words', async () => {
    const { h, policyId } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/audit`)
    expect(res.status).toBe(200)
    const html = await res.text()
    const t = text(html.slice(html.indexOf('<table')))
    expect(t.indexOf('run.vetoed')).toBeLessThan(t.indexOf('run.generated'))
    expect(t.indexOf('run.generated')).toBeLessThan(t.indexOf('policy.approved'))
    expect(t).toContain('2026-10-05 18:02 UTC')
    expect(t).toContain('Tess')
    expect(t).toContain('Felix')
    expect(t).toContain('Rolepay')
    expect(html).toContain(`href="/dashboard/${GUILD}/policies/${policyId}"`)
    expect(html).toContain(`href="/dashboard/${GUILD}/runs/run_000007"`)
    expect(t).toContain('Generated a run of 62 AlphaUSD for 3 people.')
  })

  it('filters by type, actor and policy, and keeps them selected', async () => {
    const { h } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const byType = await (await browser.get(`/dashboard/${GUILD}/audit?type=run.vetoed`)).text()
    expect(text(byType)).toContain('run.vetoed')
    expect(text(byType)).not.toContain('Generated a run')
    expect(byType).toMatch(/<option value="run.vetoed" selected>/)
    const byActor = text(await (await browser.get(`/dashboard/${GUILD}/audit?actor=${TREASURER.id}`)).text())
    expect(byActor).toContain('Approved version 1')
    expect(byActor).not.toContain('Generated a run')
    const byPolicy = text(await (await browser.get(`/dashboard/${GUILD}/audit?policy=pol_other`)).text())
    expect(byPolicy).toMatch(/No events match/)
  })

  it('pages back through older events', async () => {
    const h = dashboardHarness()
    await h.community()
    for (let i = 0; i < 55; i++) h.policies.addEvent(GUILD, { id: `evt_${String(i).padStart(3, '0')}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)), type: 'run.generated', actorId: null, policyId: null, runId: null, summary: `event ${i}` })
    const { browser } = await h.signIn(identity(MEMBER))
    const first = await (await browser.get(`/dashboard/${GUILD}/audit?type=run.generated`)).text()
    expect(text(first)).toContain('event 54')
    expect(text(first)).not.toContain('event 4 ')
    const older = /href="([^"]*before=evt_005[^"]*)"/.exec(first)?.[1]?.replaceAll('&amp;', '&')
    expect(older).toContain('type=run.generated')
    const second = text(await (await browser.get(older as string)).text())
    expect(second).toContain('event 4 ')
    expect(second).not.toContain('event 54')
  })

  it('exports the filtered log as CSV: every matching event, formulas defused, names included', async () => {
    const { h } = await setup()
    const { browser } = await h.signIn(identity(MEMBER))
    const page = await (await browser.get(`/dashboard/${GUILD}/audit?type=run.vetoed`)).text()
    expect(page).toContain(`href="/dashboard/${GUILD}/audit/csv?type=run.vetoed"`)
    const res = await browser.get(`/dashboard/${GUILD}/audit/csv`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="rolepay-audit-1094309218049937418-\d{4}-\d{2}-\d{2}\.csv"$/)
    const lines = (await res.text()).trimEnd().split('\r\n')
    expect(lines[0]).toBe('at,type,actor_id,actor_name,policy_id,policy_name,run_id,summary')
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe(`2026-10-05T18:02:00.000Z,run.vetoed,${MEMBER.id},Felix,pol_1,Weekly helpers,run_000007,"'=cmd|""/c calc""!A1"`)
    expect(lines[2]).toContain(',,Rolepay,')
    const filtered = (await (await browser.get(`/dashboard/${GUILD}/audit/csv?type=policy.approved`)).text()).trimEnd().split('\r\n')
    expect(filtered).toHaveLength(2)
  })

  it('members and the Treasurer alike can read and export it; outsiders cannot', async () => {
    const { h } = await setup()
    const { browser } = await h.signIn(identity({ id: '200000000000000099', name: 'Mallory' }, [{ id: GUILD, name: 'Mods guild' }]))
    expect((await browser.get(`/dashboard/${GUILD}/audit`)).status).toBe(403)
    expect((await browser.get(`/dashboard/${GUILD}/audit/csv`)).status).toBe(403)
  })

  it('without the audit stream, says it is not available on this server yet', async () => {
    const h = dashboardHarness({ policies: false })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}/audit`)).text())).toMatch(/not available on this server yet/)
    expect((await browser.get(`/dashboard/${GUILD}/audit/csv`)).status).toBe(404)
  })
})
