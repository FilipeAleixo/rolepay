import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer } from './support.js'

const ALICE = '200000000000000001'

async function withLink(devClaim = true) {
  const s = await testServer({ devClaim })
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

describe('dev claim page (testnet only, PAYRUN_DEV_CLAIM=true)', () => {
  it('is off unless enabled', async () => {
    const s = await withLink(false)
    expect((await s.app.request(`/claim/${s.token}`)).status).toBe(404)
  })

  it('shows who the link is for, without consuming it', async () => {
    const s = await withLink()
    const res = await s.app.request(`/claim/${s.token}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(ALICE)
    expect(html).toContain('Test guild')
    expect(html).toContain('<form')
    expect((await s.payrun.payees.describeLink({ token: s.token })).ok).toBe(true)
  })

  it('registers a pasted address, then the link is spent', async () => {
    const s = await withLink()
    const address = '0x1111111111111111111111111111111111111111'
    const res = await s.app.request(`/claim/${s.token}`, { method: 'POST', body: new URLSearchParams({ address }) })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(address)
    expect(await s.payrun.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address } })
    const again = await s.app.request(`/claim/${s.token}`, { method: 'POST', body: new URLSearchParams({ address }) })
    expect(again.status).toBe(410)
  })

  it('with no address, registers a fresh throwaway one', async () => {
    const s = await withLink()
    await s.app.request(`/claim/${s.token}`, { method: 'POST', body: new URLSearchParams({ address: '' }) })
    const payee = await s.payrun.payees.get({ guildId: GUILD, discordUserId: ALICE })
    expect(payee.ok && payee.value.address).toMatch(/^0x[0-9a-f]{40}$/)
  })

  it('an unknown link is 404 and a bad address is 400, both with a readable page', async () => {
    const s = await withLink()
    expect((await s.app.request('/claim/not-a-real-token')).status).toBe(404)
    const bad = await s.app.request(`/claim/${s.token}`, { method: 'POST', body: new URLSearchParams({ address: '0x12' }) })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toMatch(/address/)
  })

  it('escapes what it echoes', async () => {
    const s = await withLink()
    const bad = await s.app.request(`/claim/${s.token}`, { method: 'POST', body: new URLSearchParams({ address: '<script>alert(1)</script>' }) })
    expect(await bad.text()).not.toContain('<script>alert')
  })
})
