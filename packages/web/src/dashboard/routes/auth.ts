import { Hono } from 'hono'
import { readCookie, setCookie } from '../cookies.js'
import { type DashboardKit, html, redirect, safeNext } from '../kit.js'
import { SESSION_TTL_SECONDS, SIGN_IN_TTL_SECONDS, sameSecret } from '../sessions.js'
import { homePage, notConfiguredPage, signInFailedPage, signInPage } from '../views/home.js'
import { messagePage } from '../views/layout.js'

/** At most this many of a person's servers are checked against Rolepay for the home list. */
const MAX_LISTED_GUILDS = 200

/**
 * Sign in with Discord (OAuth2 authorization code with PKCE and state), sign out, and the
 * dashboard home. Every sign-in mints a new server-side session (no fixation); the browser holds
 * only its random token in an HttpOnly cookie.
 */
export function authRoutes(kit: DashboardKit): Hono {
  const app = new Hono()
  const { store, names, testnet } = kit
  const secure = names.secure
  const clearState = setCookie(names.state, '', { maxAge: 0, secure })

  app.get('/dashboard', async (c) => {
    if (!kit.oauth) return html(notConfiguredPage(testnet), 503)
    const current = await kit.session(c.req.raw)
    if (!current) return html(signInPage({ testnet }))
    const { session } = current
    const listed = await Promise.all(
      session.guilds.slice(0, MAX_LISTED_GUILDS).map(async (g) => {
        const community = await kit.rolepay.communities.get(g.id)
        return community.ok ? { id: g.id, name: community.value.name ?? g.name } : null
      }),
    )
    const communities = listed.filter((g) => g !== null)
    return html(homePage({ testnet, viewer: { userName: session.userName, csrf: session.csrf }, communities }))
  })

  app.get('/auth/discord', async (c) => {
    if (!kit.oauth) return html(notConfiguredPage(testnet), 503)
    const { state, codeChallenge } = await store.beginSignIn(safeNext(c.req.query('next'), kit.config.origin))
    const consent = kit.oauth.authorizeUrl({ state, codeChallenge, redirectUri: kit.redirectUri })
    return redirect(consent, 302, [setCookie(names.state, state, { maxAge: SIGN_IN_TTL_SECONDS, secure })])
  })

  app.get('/auth/discord/callback', async (c) => {
    if (!kit.oauth) return html(notConfiguredPage(testnet), 503)
    const state = c.req.query('state') ?? ''
    const browserState = readCookie(c.req.raw, names.state) ?? ''
    // The state must be the one THIS browser started with (its cookie): otherwise someone could
    // sign a victim into the attacker's account by sending them a callback link (login CSRF).
    if (!state || !browserState || !sameSecret(state, browserState)) return html(signInFailedPage('invalid', testnet), 400, [clearState])
    const pending = await store.finishSignIn(state)
    if (c.req.query('error')) return html(signInFailedPage('cancelled', testnet), 400, [clearState])
    const code = c.req.query('code')
    if (!pending || !code) return html(signInFailedPage('invalid', testnet), 400, [clearState])
    const signedIn = await kit.oauth.signIn({ code, codeVerifier: pending.verifier, redirectUri: kit.redirectUri })
    if (!signedIn.ok) return html(signInFailedPage('refused', testnet), 502, [clearState])
    // Whatever session the browser carried ends here; the new one is minted by us.
    const previous = readCookie(c.req.raw, names.session)
    if (previous) await store.destroy(previous)
    const { token } = await store.create(signedIn.value, kit.clock.now())
    return redirect(pending.next, 303, [setCookie(names.session, token, { maxAge: SESSION_TTL_SECONDS, secure }), clearState])
  })

  app.post('/auth/logout', async (c) => {
    const current = await kit.session(c.req.raw)
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const csrf = typeof form.csrf === 'string' ? form.csrf : ''
    if (!current || !sameSecret(csrf, current.session.csrf)) {
      return html(messagePage({ title: 'refused', heading: 'That did not come from this dashboard', testnet, body: '<p><a href="/dashboard">Back to the dashboard</a></p>' }), 403)
    }
    await store.destroy(current.token)
    return redirect('/dashboard', 303, [setCookie(names.session, '', { maxAge: 0, secure })])
  })

  return app
}
