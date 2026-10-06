import { type Clock, NETWORKS, type Payrun } from '@payrun/core'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { WebConfig } from './config.js'
import type { Assets, PasskeySessions } from './ports.js'
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
}

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

  if (deps.passkeys) {
    const passkeys = deps.passkeys
    app.all('/webauthn/*', (c) => passkeys.fetch(c.req.raw))
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
