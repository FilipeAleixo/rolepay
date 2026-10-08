import { Hono } from 'hono'
import { type DashboardContext, dashboardKit, html } from './kit.js'
import { authRoutes } from './routes/auth.js'
import { auditRoutes } from './routes/audit.js'
import { communityRoutes } from './routes/community.js'
import { fundingRoutes } from './routes/funding.js'
import { liveRoutes } from './routes/live.js'
import { policyRoutes } from './routes/policies.js'
import { messagePage } from './views/layout.js'

export type { DashboardDeps } from './kit.js'

/**
 * The web dashboard: sign in with Discord, then per community the Overview, Runs, Payees,
 * Policies, Funding and Audit log pages. Server-rendered HTML with no script: forms post (with a CSRF
 * token) and redirect back. Reads and writes only through core services, plus the policy and
 * audit ports (policyPort.ts) until the policy services are wired.
 */
export function dashboardRoutes(ctx: DashboardContext): Hono {
  const kit = dashboardKit(ctx)
  const app = new Hono()
  app.route('/', authRoutes(kit))
  app.route('/', communityRoutes(kit))
  app.route('/', policyRoutes(kit))
  app.route('/', fundingRoutes(kit))
  app.route('/', auditRoutes(kit))
  app.route('/', liveRoutes(kit))
  app.onError((error) => {
    ctx.onError?.(error)
    return html(
      messagePage({ title: 'error', heading: 'Something went wrong', testnet: ctx.testnet, body: '<p>Rolepay could not load this page. Try again in a moment.</p><p><a href="/dashboard">Back to the dashboard</a></p>' }),
      500,
    )
  })
  return app
}
