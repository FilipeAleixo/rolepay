import { type Clock, NETWORKS, type Payrun } from '@payrun/core'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { WebConfig } from './config.js'
import type { Assets, PasskeySessions, RateLimiter } from './ports.js'
import { claimRoutes } from './routes/claim.js'
import { setupRoutes } from './routes/setup.js'

export type WebAppDeps = {
  payrun: Payrun
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
}

/** The client as the proxy in front saw it: the last X-Forwarded-For hop, which it appended. */
const lastForwardedHop = (req: Request) => req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'direct'
const RATE_LIMITED_PREFIXES = /^\/(webauthn|claim|setup)\//

/**
 * The web pages: the recipient claim page and the treasurer setup page, their JSON
 * endpoints, the WebAuthn ceremony endpoints and the client bundle. One origin for all
 * of it, because passkeys are bound to it.
 */
export function createWebApp(deps: WebAppDeps): Hono {
  const { config } = deps
  const testnet = NETWORKS[config.network].testnet
  const app = new Hono()

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
    c.header('referrer-policy', 'no-referrer')
    c.header('x-content-type-options', 'nosniff')
    c.header('x-frame-options', 'DENY')
  })

  if (deps.rateLimits) {
    const { perClient, overall } = deps.rateLimits
    const clientKey = deps.rateLimits.clientKey ?? lastForwardedHop
    app.use(async (c, next) => {
      const group = c.req.method === 'POST' ? RATE_LIMITED_PREFIXES.exec(c.req.path)?.[1] : undefined
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

  const chain = { network: config.network, explorerUrl: config.explorerUrl, testnet }
  app.route('/', claimRoutes({ payees: deps.payrun.payees, sessions: deps.sessions, ...chain }))
  app.route('/', setupRoutes({ payrun: deps.payrun, sessions: deps.sessions, config, clock: deps.clock, testnet }))
  return app
}
