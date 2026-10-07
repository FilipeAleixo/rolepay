// The dashboard as the server wires it: the bot's Discord REST client is the member view, the
// config decides whether sign-in exists, and the policy seam is a dependency.
import { FakeDiscordOAuth, InMemoryPolicies } from '@rolepay/web/testing'
import { describe, expect, it } from 'vitest'
import { restGuildMembers } from '../src/dashboard.js'
import { GUILD, TOKEN, TREASURY, testServer } from './support.js'

const ROLE = '400000000000000001'
const TESS = '300000000000000001'
const FELIX = '200000000000000001'

type Server = Awaited<ReturnType<typeof testServer>>

/** Signs in through the real routes with the fake Discord consent screen; returns the cookie header to send. */
async function signIn(s: Server, oauth: FakeDiscordOAuth, user: { id: string; name: string }) {
  oauth.signInAs({ user, guilds: [{ id: GUILD, name: 'Test guild' }] })
  const start = await s.app.request('https://rolepay.test/auth/discord')
  const state = start.headers.getSetCookie()[0]?.split(';')[0] as string
  const back = new URL(start.headers.get('location') as string)
  const done = await s.app.request(`https://rolepay.test${back.pathname}${back.search}`, { headers: { cookie: state } })
  expect(done.status).toBe(303)
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-rolepay_session='))?.split(';')[0] as string
}

async function registered(s: Server) {
  await s.rolepay.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE })
  s.rest.setMember(GUILD, TESS, [ROLE], null, 'Tess')
  s.rest.setMember(GUILD, FELIX, [], null, 'Felix')
}

describe('the dashboard in the server', () => {
  it('without ROLEPAY_DISCORD_CLIENT_SECRET, says sign-in is not configured', async () => {
    const s = await testServer()
    const res = await s.app.request('/dashboard')
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/Sign-in is not configured/)
  })

  it("with the secret, sends the browser to Discord's consent screen for this app, back to PUBLIC_URL/auth/discord/callback", async () => {
    const s = await testServer({ env: { ROLEPAY_DISCORD_CLIENT_SECRET: 'oauth-secret' } })
    const res = await s.app.request('https://rolepay.test/auth/discord')
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location') as string)
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('500000000000000001')
    expect(url.searchParams.get('redirect_uri')).toBe('https://rolepay.test/auth/discord/callback')
    expect(url.searchParams.get('scope')).toBe('identify guilds')
    expect(res.headers.get('location')).not.toContain('oauth-secret')
  })

  it("roles come from the bot's view of the member (Discord REST as the bot): Felix reads, Tess is the Treasurer", async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ dashboard: { oauth } })
    await registered(s)
    const felix = await signIn(s, oauth, { id: FELIX, name: 'felix_k' })
    const page = await s.app.request(`https://rolepay.test/dashboard/${GUILD}`, { headers: { cookie: felix } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Felix · read only')
    const tess = await signIn(s, oauth, { id: TESS, name: 'tess' })
    expect(await (await s.app.request(`https://rolepay.test/dashboard/${GUILD}`, { headers: { cookie: tess } })).text()).toContain('Tess · Treasurer')
  })

  it('the policy seam: without policy services the pages say so; with them (here the in-memory port) they show and act', async () => {
    const oauth = new FakeDiscordOAuth()
    const bare = await testServer({ dashboard: { oauth } })
    await registered(bare)
    const cookie = await signIn(bare, oauth, { id: FELIX, name: 'felix_k' })
    expect(await (await bare.app.request(`https://rolepay.test/dashboard/${GUILD}/policies`, { headers: { cookie } })).text()).toMatch(/not available on this server yet/)

    const policies = new InMemoryPolicies()
    const s = await testServer({ dashboard: { oauth, policies, audit: policies } })
    await registered(s)
    const id = policies.seed(GUILD, { name: 'Weekly helpers', instruction: 'Every Monday...' })
    const tess = await signIn(s, oauth, { id: TESS, name: 'tess' })
    expect(await (await s.app.request(`https://rolepay.test/dashboard/${GUILD}/policies`, { headers: { cookie: tess } })).text()).toContain('Weekly helpers')
    const page = await (await s.app.request(`https://rolepay.test/dashboard/${GUILD}/policies/${id}`, { headers: { cookie: tess } })).text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string
    const paused = await s.app.request(`https://rolepay.test/dashboard/${GUILD}/policies/${id}/pause`, {
      method: 'POST',
      headers: { cookie: tess, origin: 'https://rolepay.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    })
    expect(paused.status).toBe(303)
    expect(policies.calls).toEqual([{ method: 'pause', guildId: GUILD, policyId: id, actor: { id: TESS, roleIds: [ROLE] } }])
  })

  it('an unexpected dashboard failure is logged (URLs redacted) and the page stays generic', async () => {
    const oauth = new FakeDiscordOAuth()
    const s = await testServer({ dashboard: { oauth } })
    await registered(s)
    const cookie = await signIn(s, oauth, { id: FELIX, name: 'felix_k' })
    s.rolepay.payRuns.list = async () => {
      throw new Error('fetch https://rpc.example/key-123 failed')
    }
    const res = await s.app.request(`https://rolepay.test/dashboard/${GUILD}/runs`, { headers: { cookie } })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('key-123')
    expect(s.logs).toContainEqual({ event: 'dashboard_error', fields: { error: 'fetch <url> failed' } })
  })
})

describe('restGuildMembers (the member view over the bot REST client)', () => {
  it('maps a member to roles and display name, and a non-member to null', async () => {
    const members = restGuildMembers({
      getMember: async (_g: string, u: string) => (u === FELIX ? { roles: [ROLE], joinedAt: null, name: 'Felix' } : null),
    })
    expect(await members.member(GUILD, FELIX)).toEqual({ roles: [ROLE], name: 'Felix' })
    expect(await members.member(GUILD, TESS)).toBeNull()
  })
})
