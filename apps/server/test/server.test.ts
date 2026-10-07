import { slashCommand } from '@rolepay/discord/testing'
import { describe, expect, it, vi } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer } from './support.js'

const ALICE = '200000000000000001'

async function withLink() {
  const s = await testServer()
  await s.rolepay.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })
  const link = await s.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
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

  it('rate limits the public page endpoints by default, per client', async () => {
    const s = await testServer()
    const post = (ip: string) =>
      s.app.request('/claim/not-a-token', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'https://rolepay.test', 'x-forwarded-for': ip } })
    const statuses = []
    for (let i = 0; i < 31; i++) statuses.push((await post('203.0.113.7')).status)
    expect(statuses.slice(0, 30).every((st) => st !== 429)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect((await post('203.0.113.8')).status).not.toBe(429)
  })

  it('behind Fly, the client is Fly-Client-IP (ROLEPAY_CLIENT_IP_HEADER): a forged X-Forwarded-For buys no fresh budget', async () => {
    const s = await testServer({ env: { ROLEPAY_CLIENT_IP_HEADER: 'Fly-Client-IP' } })
    const post = (client: string, forwarded: string) =>
      s.app.request('/claim/not-a-token', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', origin: 'https://rolepay.test', 'fly-client-ip': client, 'x-forwarded-for': forwarded },
      })
    const statuses = []
    for (let i = 0; i < 31; i++) statuses.push((await post('203.0.113.7', `198.51.100.${i}`)).status)
    expect(statuses.slice(0, 30).every((st) => st !== 429)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect((await post('203.0.113.8', '198.51.100.0')).status).not.toBe(429)
  })

  it('a replayed signed interaction (inside the 5-minute window) never mints a second claim link', async () => {
    const s = await withLink()
    const link = slashCommand({ guildId: GUILD, channelId: '700000000000000001' }, 'payee', 'link', {}, { userId: ALICE })
    const first = await s.interact(link)
    expect(JSON.stringify(await first.json())).toContain('/claim/')
    const replay = await s.interact(link)
    expect(replay.status).toBe(409)
    expect(await replay.text()).not.toContain('/claim/')
  })

  it('the recovery interval also sweeps expired key-value records off the disk (abandoned proposal forms, old proposals)', async () => {
    const s = await testServer()
    await s.kv.set('discord:pending-source:x:y', { content: 'Winners' }, { ttl: 60 })
    s.clock.advance(61)
    const sweep = vi.spyOn(s.kv, 'sweep')
    const recovery = s.startRecovery()
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled())
    await recovery.stop()
    expect(await sweep.mock.results[0]?.value).toBe(1)
  })

  it('refuses a request body over 1 MB before anything reads it, so one request cannot exhaust a small machine', async () => {
    const s = await testServer()
    const big = 'x'.repeat(1024 * 1024 + 1)
    const headers = { 'content-type': 'application/json', origin: 'https://rolepay.test' }
    for (const path of ['/discord/interactions', '/webauthn/register/options', '/claim/not-a-token', '/setup/not-a-token/key']) {
      const res = await s.app.request(path, { method: 'POST', body: big, headers })
      expect([path, res.status]).toEqual([path, 413])
      expect(await res.json()).toEqual({ ok: false, error: { code: 'body_too_large' } })
    }
    // Without a Content-Length (a stream) it is counted as it arrives.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const streamed = await s.app.request('/discord/interactions', { method: 'POST', body: stream, headers, duplex: 'half' } as RequestInit)
    expect(streamed.status).toBe(413)
    // A normal interaction still goes through.
    const ping = { id: '800000000000000002', application_id: '500000000000000001', type: 1, token: 't', version: 1 }
    expect((await s.interact(ping)).status).toBe(200)
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
    expect(await s.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address } })
  })

  it('serves the setup page for a setup link, and the client bundle', async () => {
    const s = await testServer()
    const link = await s.rolepay.communities.issueSetupLink({
      guildId: GUILD,
      discordUserId: ALICE,
      settings: { name: 'Test guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: null },
    })
    if (!link.ok) throw new Error()
    expect((await s.app.request(`/setup/${link.value.token}`)).status).toBe(200)
    expect((await s.app.request('/assets/rolepay.js')).status).toBe(200)
  })

  it('serves the home page at /, with the install link for this Discord application (DISCORD_APP_ID), and its fonts and favicon', async () => {
    const s = await testServer()
    const home = await s.app.request('/')
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('href="https://discord.com/oauth2/authorize?client_id=500000000000000001&amp;scope=bot+applications.commands&amp;permissions=84992"')
    expect(html).toContain('Testnet demo')
    expect((await s.app.request('/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml')
    expect((await s.app.request('/assets/fonts/lora-latin-400-normal.woff2')).headers.get('content-type')).toBe('font/woff2')
  })
})
