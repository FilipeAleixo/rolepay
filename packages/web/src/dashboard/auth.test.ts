import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GUILD, MEMBER, OUTSIDER, TREASURER, dashboardHarness, identity } from '../../test/dashboardHarness.js'

const cookieNamed = (setCookies: string[], name: string) => setCookies.find((c) => c.startsWith(`${name}=`))
const SESSION = 'rolepay_session'
const STATE = 'rolepay_oauth_state'

describe('dashboard sign-in with Discord', () => {
  it('without a client secret the dashboard says sign-in is not configured, and never redirects to Discord', async () => {
    const h = dashboardHarness({ oauth: false })
    const page = await h.browser().get('/dashboard')
    expect(page.status).toBe(503)
    expect(await page.text()).toMatch(/Sign-in is not configured/)
    const start = await h.browser().get('/auth/discord')
    expect(start.status).toBe(503)
    expect(start.headers.get('location')).toBeNull()
  })

  it('signed out, /dashboard offers Sign in with Discord and shows nothing else', async () => {
    const h = dashboardHarness()
    await h.community()
    const page = await h.browser().get('/dashboard')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('href="/auth/discord"')
    expect(html).toContain('Sign in with Discord')
    expect(html).not.toContain('Mods guild')
  })

  it('starts the code flow with a fresh state and an S256 PKCE challenge, bound to this browser by an HttpOnly cookie', async () => {
    const h = dashboardHarness()
    const b = h.browser()
    const res = await b.get('/auth/discord')
    expect(res.status).toBe(302)
    const [auth] = h.oauth.authorizations
    expect(auth?.redirectUri).toBe('http://localhost:8787/auth/discord/callback')
    expect(auth?.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(auth?.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const cookie = cookieNamed(b.setCookies, STATE) ?? ''
    expect(cookie).toContain(`${STATE}=${auth?.state}`)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    // A second start is a different state and challenge.
    await h.browser().get('/auth/discord')
    expect(h.oauth.authorizations[1]?.state).not.toBe(auth?.state)
    expect(h.oauth.authorizations[1]?.codeChallenge).not.toBe(auth?.codeChallenge)
  })

  it('the callback exchanges the code with the matching PKCE verifier, opens a server-side session and lists the servers that use Rolepay', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser, callback } = await h.signIn(identity(TREASURER))
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/dashboard')
    expect(h.oauth.exchanges).toEqual([{ code: 'fake-code-1', verifierMatched: true }])
    const session = cookieNamed(browser.setCookies, SESSION) ?? ''
    expect(session).toMatch(/HttpOnly/)
    expect(session).toMatch(/SameSite=Lax/)
    expect(session).toMatch(/Path=\//)
    // The state cookie is spent.
    expect(browser.cookies.has(STATE)).toBe(false)
    const html = await (await browser.get('/dashboard')).text()
    expect(html).toContain('Tess')
    expect(html).toContain(`href="/dashboard/${GUILD}"`)
    expect(html).toContain('Mods guild')
    expect(html).not.toContain('Not on Rolepay')
  })

  it('keeps only a hash of the session token on the server', async () => {
    const h = dashboardHarness()
    const { browser } = await h.signIn(identity(MEMBER))
    const token = browser.cookies.get(SESSION) as string
    expect(await h.kv.get(`dashboard:session:${token}`)).toBeUndefined()
    const hashed = createHash('sha256').update(token).digest('hex')
    expect(await h.kv.get(`dashboard:session:${hashed}`)).toMatchObject({ userId: MEMBER.id, userName: MEMBER.name })
  })

  it('refuses a callback whose state is not the one this browser started with (login CSRF), and signs nobody in', async () => {
    const h = dashboardHarness()
    h.oauth.signInAs(identity(OUTSIDER))
    // The attacker starts a sign-in on their own browser and sends the victim the callback link.
    const attacker = h.browser()
    const consent = new URL((await attacker.get('/auth/discord')).headers.get('location') as string)
    const victim = h.browser()
    const res = await victim.get(consent.pathname + consent.search)
    expect(res.status).toBe(400)
    expect(victim.cookies.has(SESSION)).toBe(false)
    expect(h.oauth.exchanges).toEqual([])
  })

  it('a state works once, and not after ten minutes', async () => {
    const h = dashboardHarness()
    h.oauth.signInAs(identity(MEMBER))
    const b = h.browser()
    const consent = new URL((await b.get('/auth/discord')).headers.get('location') as string)
    const stateCookie = b.cookies.get(STATE) as string
    expect((await b.get(consent.pathname + consent.search)).status).toBe(303)
    // Replayed with the same state cookie.
    const replay = h.browser()
    replay.cookies.set(STATE, stateCookie)
    expect((await replay.get(consent.pathname + consent.search)).status).toBe(400)

    const late = h.browser()
    const lateConsent = new URL((await late.get('/auth/discord')).headers.get('location') as string)
    h.clock.advance(601)
    expect((await late.get(lateConsent.pathname + lateConsent.search)).status).toBe(400)
    expect(late.cookies.has(SESSION)).toBe(false)
  })

  it('when Discord refuses the code, nobody is signed in and the page says so in plain words', async () => {
    const h = dashboardHarness()
    h.oauth.refuseNext()
    const { browser, callback } = await h.signIn(identity(MEMBER))
    expect(callback.status).toBe(502)
    expect(await callback.text()).toMatch(/Discord did not confirm the sign-in/)
    expect(browser.cookies.has(SESSION)).toBe(false)
  })

  it('a cancelled consent screen (error=access_denied) signs nobody in', async () => {
    const h = dashboardHarness()
    const b = h.browser()
    const consent = new URL((await b.get('/auth/discord')).headers.get('location') as string)
    const res = await b.get(`/auth/discord/callback?error=access_denied&state=${consent.searchParams.get('state')}`)
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/Sign-in was cancelled/)
    expect(b.cookies.has(SESSION)).toBe(false)
  })

  it('session fixation: signing in always mints a new session and ends the one the browser carried', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser: attacker } = await h.signIn(identity(OUTSIDER))
    const planted = attacker.cookies.get(SESSION) as string
    const victim = h.browser()
    victim.cookies.set(SESSION, planted)
    await h.signIn(identity(TREASURER), victim)
    const fresh = victim.cookies.get(SESSION) as string
    expect(fresh).not.toBe(planted)
    expect(await (await victim.get('/dashboard')).text()).toContain('Tess')
    // The planted token is dead: whoever holds it is signed out.
    expect(await (await attacker.get('/dashboard')).text()).toContain('Sign in with Discord')
  })

  it('an unknown or forged session cookie reads as signed out', async () => {
    const h = dashboardHarness()
    const b = h.browser()
    b.cookies.set(SESSION, 'forged-token')
    expect(await (await b.get('/dashboard')).text()).toContain('Sign in with Discord')
  })

  it('logout needs the CSRF token; then the session is gone on the server and the cookie is cleared', async () => {
    const h = dashboardHarness()
    await h.community()
    const { browser } = await h.signIn(identity(TREASURER))
    const token = browser.cookies.get(SESSION) as string
    expect((await browser.post('/auth/logout')).status).toBe(403)
    expect((await browser.post('/auth/logout', { csrf: 'wrong' })).status).toBe(403)
    expect(await (await browser.get('/dashboard')).text()).toContain('Tess')

    const out = await browser.act('/auth/logout')
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe('/dashboard')
    expect(cookieNamed(browser.setCookies.slice(-1), SESSION)).toMatch(/Max-Age=0/)
    expect(browser.cookies.has(SESSION)).toBe(false)
    // The old token no longer works anywhere, even if someone kept a copy.
    const copy = h.browser()
    copy.cookies.set(SESSION, token)
    expect(await (await copy.get('/dashboard')).text()).toContain('Sign in with Discord')
  })

  it('a cross-site logout is refused (Origin), whatever it carries', async () => {
    const h = dashboardHarness()
    const { browser } = await h.signIn(identity(MEMBER))
    const csrf = await browser.csrf()
    const res = await browser.request('/auth/logout', {
      method: 'POST',
      body: new URLSearchParams({ csrf }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
    expect(browser.cookies.has(SESSION)).toBe(true)
  })

  it('sessions end after eight hours', async () => {
    const h = dashboardHarness()
    const { browser } = await h.signIn(identity(MEMBER))
    h.clock.advance(8 * 3600 + 1)
    expect(await (await browser.get('/dashboard')).text()).toContain('Sign in with Discord')
  })

  it('returns to the dashboard page that asked for sign-in, never to another site', async () => {
    const h = dashboardHarness()
    await h.community()
    const back = await h.signIn(identity(MEMBER), undefined, `/dashboard/${GUILD}/runs?status=paid`)
    expect(back.callback.headers.get('location')).toBe(`/dashboard/${GUILD}/runs?status=paid`)
    for (const next of ['https://evil.example/dashboard', '//evil.example/dashboard', '/\\evil.example', '/claim/x', 'javascript:alert(1)']) {
      const r = await h.signIn(identity(MEMBER), undefined, next)
      expect(r.callback.headers.get('location')).toBe('/dashboard')
    }
  })

  it('on https the session cookie is Secure and __Host- prefixed', async () => {
    const h = dashboardHarness({ origin: 'https://demo.rolepay.test' })
    const { browser } = await h.signIn(identity(MEMBER))
    const session = cookieNamed(browser.setCookies, `__Host-${SESSION}`) ?? ''
    expect(session).toMatch(/; Secure/)
    expect(session).toMatch(/HttpOnly/)
    expect(session).not.toMatch(/Domain=/i)
    expect(cookieNamed(browser.setCookies, `__Host-${STATE}`)).toMatch(/; Secure/)
  })
})
