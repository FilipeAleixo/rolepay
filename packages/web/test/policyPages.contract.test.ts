// The policy page contract against the in-memory port the other dashboard tests use. The same
// contract runs against core's real policy services in apps/server/test/dashboardContract.test.ts.
import { describe, expect, it } from 'vitest'
import { inMemoryBackend } from './contract/inMemoryBackend.js'
import { policyPagesContract } from './contract/policyPages.js'
import { GUILD, MEMBER, dashboardHarness, identity } from './dashboardHarness.js'

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
