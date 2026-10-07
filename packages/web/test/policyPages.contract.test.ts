// The policy page contract against the in-memory port the other dashboard tests use. The same
// contract runs against core's real policy services in apps/server/test/dashboardContract.test.ts.
import { describe, expect, it } from 'vitest'
import { inMemoryBackend } from './contract/inMemoryBackend.js'
import { policyPagesContract } from './contract/policyPages.js'
import { GUILD, MEMBER, TREASURER, dashboardHarness, identity } from './dashboardHarness.js'

policyPagesContract('InMemoryPolicies', inMemoryBackend)

const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

describe('a server without the policy services', () => {
  it('the Policies page says they are not available on this server yet; a policy is not found', async () => {
    const h = dashboardHarness({ policies: false })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}/policies`)
    expect(res.status).toBe(200)
    expect(text(await res.text())).toMatch(/not available on this server yet/)
    expect((await browser.get(`/dashboard/${GUILD}/policies/pol_1`)).status).toBe(404)
  })

  it('the Audit log says it is not available on this server yet; its CSV is not found', async () => {
    const h = dashboardHarness({ policies: false })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    expect(text(await (await browser.get(`/dashboard/${GUILD}/audit`)).text())).toMatch(/not available on this server yet/)
    expect((await browser.get(`/dashboard/${GUILD}/audit/csv`)).status).toBe(404)
  })
})

describe('a daily schedule (the testnet demo controls only)', () => {
  const judges = { name: 'Judges', instruction: '1 AlphaUSD to every registered payee who reacted to the welcome post and has never been paid', kind: 'daily', weekday: '1', day: '1', hour: '18', timezone: 'UTC' }

  it('where the policy services allow it, the form offers it and the pages say it in words', async () => {
    const h = dashboardHarness()
    h.policies.dailySchedules = true
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    expect(await (await browser.get(`/dashboard/${GUILD}/policies/new`)).text()).toContain('<option value="daily">Daily (testnet demo)</option>')
    const res = await browser.act(`/dashboard/${GUILD}/policies`, judges)
    expect(res.status).toBe(303)
    const location = res.headers.get('location') as string
    const page = await (await browser.get(location)).text()
    expect(text(page)).toMatch(/Every day at 18:00 \(UTC\)/)
    expect(text(await (await browser.get(`/dashboard/${GUILD}/policies`)).text())).toMatch(/Judges Every day at 18:00 \(UTC\)/)
    // Editing it keeps the daily choice selected.
    expect(await (await browser.get(`${location.split('?')[0]}/edit`)).text()).toContain('<option value="daily" selected>Daily (testnet demo)</option>')
  })

  it('elsewhere the form offers weekly and monthly only, and a daily one posted anyway is refused in words before the services are asked', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    expect(await (await browser.get(`/dashboard/${GUILD}/policies/new`)).text()).not.toContain('value="daily"')
    const res = await browser.act(`/dashboard/${GUILD}/policies`, judges)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(text(html)).toMatch(/A daily schedule is a testnet demo control, off on this server: choose weekly or monthly\./)
    expect(html).toContain('name="instruction"')
    expect(h.policies.calls).toEqual([])
  })

  it('the policy services refuse it too (an approval or resume after the demo controls went off), and the page says why', async () => {
    const h = dashboardHarness()
    await h.community()
    const policyId = h.policies.seed(GUILD, { name: 'Judges', instruction: judges.instruction, status: 'draft', schedule: { kind: 'daily', hour: 18, timezone: 'UTC' } })
    const { browser } = await h.signIn(identity(TREASURER))
    const res = await browser.act(`/dashboard/${GUILD}/policies/${policyId}/approve`, { version: '1' })
    expect(res.headers.get('location')).toBe(`/dashboard/${GUILD}/policies/${policyId}?error=schedule_not_allowed`)
    expect(text(await (await browser.get(res.headers.get('location') as string)).text())).toMatch(/A daily schedule is a testnet demo control, off on this server/)
  })
})
