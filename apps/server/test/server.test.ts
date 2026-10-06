import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer } from './support.js'

const ALICE = '200000000000000001'

async function withLink() {
  const s = await testServer()
  await s.payrun.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
  const link = await s.payrun.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
  if (!link.ok) throw new Error(link.error.code)
  return { ...s, token: link.value.token }
}

describe('server routes', () => {
  it('GET /health answers with the network and the queue size', async () => {
    const s = await testServer()
    const res = await s.app.request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, network: 'moderato', jobsInFlight: 0 })
  })

  it('POST /discord/interactions refuses unsigned requests and answers a signed PING', async () => {
    const s = await testServer()
    const ping = { id: '800000000000000001', application_id: '500000000000000001', type: 1, token: 't', version: 1 }
    expect((await s.interact(ping, false)).status).toBe(401)
    const res = await s.interact(ping)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ type: 1 })
  })

  it('anything else is 404', async () => {
    const s = await testServer()
    expect((await s.app.request('/nope')).status).toBe(404)
  })
})

describe('web pages through the composed server', () => {
  it('serves the claim page and registers the passkey session address on it', async () => {
    const s = await withLink()
    const page = await s.app.request(`/claim/${s.token}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Get paid by Test guild')
    const address = '0x1111111111111111111111111111111111111111'
    const res = await s.browserPost(`/claim/${s.token}`, address)
    expect(res.status).toBe(200)
    expect(await s.payrun.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address } })
  })

  it('serves the setup page for a setup link, and the client bundle', async () => {
    const s = await testServer()
    const link = await s.payrun.communities.issueSetupLink({
      guildId: GUILD,
      discordUserId: ALICE,
      settings: { name: 'Test guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: null },
    })
    if (!link.ok) throw new Error()
    expect((await s.app.request(`/setup/${link.value.token}`)).status).toBe(200)
    expect((await s.app.request('/assets/payrun.js')).status).toBe(200)
  })
})
