import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, OTHER_GUILD, OUTSIDER, ROLE, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'
import { DASHBOARD_STYLE } from './views/layout.js'

describe('dashboard security headers and errors', () => {
  it('pages carry the strict CSP (the dashboard stylesheet allowed by its hash, scripts only from this origin), no-store and no framing; HSTS on https', async () => {
    const h = dashboardHarness({ origin: 'https://demo.rolepay.test' })
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    const res = await browser.get(`/dashboard/${GUILD}`)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`'sha256-${createHash('sha256').update(DASHBOARD_STYLE).digest('base64')}'`)
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000')
    // One script, from this origin (the live updates), and no inline script at all.
    const scripts = [...(await res.text()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    expect(scripts.map((m) => m[0])).toEqual(['<script type="module" src="/assets/live.js"></script>'])
  })

  it('pages use Referrer-Policy same-origin: under no-referrer a browser sends "Origin: null" on its own form posts, which the same-origin check refuses; nothing goes to other sites either way', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    for (const path of ['/dashboard', `/dashboard/${GUILD}`, `/dashboard/${GUILD}/runs`]) expect((await browser.get(path)).headers.get('referrer-policy'), path).toBe('same-origin')
    expect((await browser.get('/auth/discord')).headers.get('referrer-policy')).toBe('same-origin')
    // The claim and setup pages keep no-referrer.
    expect((await browser.get('/claim/nope')).headers.get('referrer-policy')).toBe('no-referrer')
    // A post a page elsewhere made (Origin null, cross-site) is still refused.
    const csrf = await browser.csrf()
    const forged = await browser.request('/auth/logout', {
      method: 'POST',
      body: new URLSearchParams({ csrf }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null', 'sec-fetch-site': 'cross-site' },
    })
    expect(forged.status).toBe(403)
  })

  it('an unexpected failure shows a generic page and reports the error to the server, never to the page', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    h.rolepay.payRuns.list = async () => {
      throw new Error('database exploded at /var/secret/path')
    }
    const res = await browser.get(`/dashboard/${GUILD}/runs`)
    expect(res.status).toBe(500)
    const html = await res.text()
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('secret')
    expect(h.errors).toHaveLength(1)
  })
})

describe('dashboard authorisation per community (the bot view of the member, never the browser)', () => {
  it('signed out, a community page asks to sign in and comes back to it afterwards', async () => {
    const h = dashboardHarness()
    await h.community()
    const res = await h.browser().get(`/dashboard/${GUILD}/runs?status=paid`)
    expect(res.status).toBe(401)
    const html = await res.text()
    expect(html).toContain(`href="/auth/discord?next=${encodeURIComponent(`/dashboard/${GUILD}/runs?status=paid`)}"`)
    expect(html).not.toContain('Mods guild')
  })

  it('a member sees the community read only; the approver role is labelled Treasurer', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser: member } = await h.signIn(identity(MEMBER))
    const page = await member.get(`/dashboard/${GUILD}`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Felix · read only')
    const { browser: treasurer } = await h.signIn(identity(TREASURER))
    expect(await (await treasurer.get(`/dashboard/${GUILD}`)).text()).toContain('Tess · Treasurer')
  })

  it('someone the bot does not see in the server is refused, exactly like a server that does not use Rolepay', async () => {
    const h = dashboardHarness()
    await h.community()
    // Discord listed the guild at sign-in, but the bot says they are not a member: the bot wins.
    const { browser } = await h.signIn(identity(OUTSIDER, [{ id: GUILD, name: 'Mods guild' }]))
    const refused = await browser.get(`/dashboard/${GUILD}`)
    expect(refused.status).toBe(403)
    const unregistered = await browser.get(`/dashboard/${OTHER_GUILD}`)
    expect(unregistered.status).toBe(403)
    const text = await refused.text()
    expect(text).toBe(await unregistered.text())
    expect(text).not.toContain('Mods guild')
    for (const path of ['runs', 'payees', 'policies', 'audit', 'runs/run_000001']) expect((await browser.get(`/dashboard/${GUILD}/${path}`)).status).toBe(403)
  })

  it('a malformed community ID is not found', async () => {
    const h = dashboardHarness()
    const { browser } = await h.signIn(identity(MEMBER))
    expect((await browser.get('/dashboard/not-a-guild')).status).toBe(404)
  })

  it('a member who leaves the server loses access within a minute; a role change shows within a minute', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    expect((await browser.get(`/dashboard/${GUILD}`)).status).toBe(200)
    h.members.set(GUILD, MEMBER.id, [ROLE], 'Felix')
    h.clock.advance(61)
    expect(await (await browser.get(`/dashboard/${GUILD}`)).text()).toContain('Felix · Treasurer')
    h.members.remove(GUILD, MEMBER.id)
    h.clock.advance(61)
    expect((await browser.get(`/dashboard/${GUILD}`)).status).toBe(403)
  })

  it('reads the member from the bot at most once a minute while browsing', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(MEMBER))
    const before = h.members.lookups
    for (const path of ['', '/runs', '/payees']) await browser.get(`/dashboard/${GUILD}${path}`)
    // One lookup for the viewer; page lookups for other people's names are separate and cached for longer.
    expect(h.members.lookups - before).toBeLessThanOrEqual(2)
  })
})
