import { createHash } from 'node:crypto'
import { type Clock, NETWORKS, type Rolepay } from '@rolepay/core'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { WebConfig } from './config.js'
import { type DashboardDeps, dashboardRoutes } from './dashboard/index.js'
import { DASHBOARD_STYLE } from './dashboard/views/layout.js'
import { fontFile } from './fonts.js'
import type { Assets, PasskeySessions, RateLimiter } from './ports.js'
import { accountRoutes } from './routes/account.js'
import { claimRoutes } from './routes/claim.js'
import { landingRoutes } from './routes/landing.js'
import { setupRoutes } from './routes/setup.js'
import { STYLE } from './views/page.js'
import { MARK_SVG } from './views/theme.js'

export type WebAppDeps = {
  rolepay: Rolepay
  clock: Clock
  config: WebConfig
  sessions: PasskeySessions
  assets: Assets
  /** The WebAuthn ceremony endpoints (Accounts SDK `Handler.webAuthn`), mounted at /webauthn. */
  passkeys?: { fetch: (req: Request) => Response | Promise<Response> }
  /**
   * Budgets for the public POST endpoints (/webauthn, /claim, /setup): each request takes one
   * from its client's budget and one from that endpoint group's overall budget, so spoofing the
   * client key cannot get past the second, and one group cannot starve another. `clientKey` defaults to the last X-Forwarded-For hop (the one the tunnel
   * or proxy in front appended).
   */
  rateLimits?: { perClient: RateLimiter; overall: RateLimiter; clientKey?: (req: Request) => string }
  /** The web dashboard (Discord sign-in, /dashboard). Absent: not served. */
  dashboard?: DashboardDeps
}

/** The client as the proxy in front saw it: the last X-Forwarded-For hop, which it appended. */
const lastForwardedHop = (req: Request) => req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct'
/**
 * Content-Security-Policy for every response: scripts only from this origin (the one bundle),
 * the inline stylesheet by its hash, fonts and images only from this origin (images also as data:
 * URIs, for the grain and the select's chevron), connections only to this origin, the RPC and the
 * sponsor (the page signs and sends the treasurer's transactions itself), and no framing, plugins
 * or base-URL tricks. The JSON page config is a data block, never executed.
 */
function contentSecurityPolicy(config: WebConfig): string {
  const origin = (u: string | null) => (u && URL.canParse(u) ? [new URL(u).origin] : [])
  const connect = ["'self'", ...new Set([...origin(config.rpcUrl), ...origin(config.sponsorUrl)])]
  const styles = [STYLE, DASHBOARD_STYLE].map((s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`)
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src ${styles.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ')
}

const RATE_LIMITED_PREFIXES = /^\/(webauthn|claim|setup|dashboard)\//

/**
 * Which budget a request takes from: the public POSTs (passkeys, claim, setup, dashboard actions),
 * and every request of the Discord sign-in (each one writes a record or calls Discord), never
 * the dashboard's pages.
 */
const rateLimitGroup = (method: string, path: string) =>
  path.startsWith('/auth/') ? 'auth' : method === 'POST' ? RATE_LIMITED_PREFIXES.exec(path)?.[1] : undefined

/**
 * The web pages: the home page, the recipient claim page and the treasurer setup page, their
 * JSON endpoints, the WebAuthn ceremony endpoints, the client bundle, the fonts and the favicon.
 * One origin for all of it, because passkeys are bound to it.
 */
export function createWebApp(deps: WebAppDeps): Hono {
  const { config } = deps
  const testnet = NETWORKS[config.network].testnet
  const app = new Hono()
  const csp = contentSecurityPolicy(config)
  const https = new URL(config.origin).protocol === 'https:'

  app.use(async (c, next) => {
    // State-changing requests must come from our own pages (CSRF). Browsers always send
    // Origin on a POST fetch; Sec-Fetch-Site backs it up.
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin')
      const site = c.req.header('sec-fetch-site')
      if ((origin && origin !== config.origin) || (site && site !== 'same-origin' && site !== 'none')) {
        return c.json({ ok: false, error: { code: 'cross_origin' } }, 403)
      }
    }
    await next()
    c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store')
    // no-referrer, except where a route asks for same-origin (the dashboard's forms need it: see dashboard/kit.ts).
    c.header('referrer-policy', c.res.headers.get('referrer-policy') === 'same-origin' ? 'same-origin' : 'no-referrer')
    c.header('x-content-type-options', 'nosniff')
    c.header('x-frame-options', 'DENY')
    c.header('content-security-policy', csp)
    // Browsers only honour HSTS over https; never sent for http://localhost.
    if (https) c.header('strict-transport-security', 'max-age=31536000')
  })

  if (deps.rateLimits) {
    const { perClient, overall } = deps.rateLimits
    const clientKey = deps.rateLimits.clientKey ?? lastForwardedHop
    app.use(async (c, next) => {
      const group = rateLimitGroup(c.req.method, c.req.path)
      if (group && (!(await perClient.take(`${group}:${clientKey(c.req.raw)}`)) || !(await overall.take(group)))) {
        return c.json({ ok: false, error: { code: 'rate_limited' } }, 429, { 'retry-after': '30' })
      }
      await next()
    })
  }

  if (deps.passkeys) {
    const passkeys = deps.passkeys
    // Behind a tunnel or proxy the request arrives as plain http; the handler marks its session
    // cookie Secure from the URL's protocol, so it gets the public URL instead.
    app.all('/webauthn/*', async (c) => {
      const url = new URL(c.req.url)
      const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? null : await c.req.arrayBuffer()
      return passkeys.fetch(new Request(`${config.origin}${url.pathname}${url.search}`, { method: c.req.method, headers: c.req.raw.headers, body }))
    })
  }

  // The bundle is about 1.5 MB (viem's Tempo ABIs, the Accounts SDK); gzip takes it to a fraction.
  app.use('/assets/*', compress())
  app.get('/assets/:name', async (c) => {
    const body = await deps.assets.get(c.req.param('name'))
    if (body === null) return c.notFound()
    return c.body(body, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
  })

  // The fonts (woff2, never compressed again) and their licences: fixed files, cached for good.
  app.get('/assets/fonts/:file', async (c) => {
    const file = await fontFile(c.req.param('file'))
    if (!file) return c.notFound()
    return c.body(file.body, 200, { 'content-type': file.type, 'cache-control': 'public, max-age=31536000, immutable' })
  })
  app.get('/favicon.svg', (c) => c.body(MARK_SVG, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' }))

  const chain = { network: config.network, explorerUrl: config.explorerUrl, testnet }
  app.route('/', landingRoutes({ testnet, discordAppId: config.discordAppId }))
  app.route('/', claimRoutes({ payees: deps.rolepay.payees, sessions: deps.sessions, ...chain }))
  app.route('/', accountRoutes({ config, testnet }))
  app.route('/', setupRoutes({ rolepay: deps.rolepay, sessions: deps.sessions, config, clock: deps.clock, testnet }))
  if (deps.dashboard) app.route('/', dashboardRoutes({ ...deps.dashboard, rolepay: deps.rolepay, clock: deps.clock, config, testnet }))
  return app
}
