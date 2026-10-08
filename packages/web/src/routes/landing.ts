import { Hono } from 'hono'
import { landingPage } from '../views/landing.js'

export type LandingRoutesDeps = { testnet: boolean; discordAppId?: string | undefined; demoInviteUrl?: string | undefined }

/** /: the home page, the first thing a visitor to the server's address sees. Read only, no script. */
export function landingRoutes(deps: LandingRoutesDeps): Hono {
  const app = new Hono()
  app.get('/', (c) => c.html(landingPage(deps)))
  return app
}
