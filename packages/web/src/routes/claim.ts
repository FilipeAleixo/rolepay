import type { PayeeService } from '@payrun/core'
import { Hono } from 'hono'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySessions } from '../ports.js'
import { claimPage } from '../views/claim.js'
import { linkErrorPage } from '../views/page.js'

export type ClaimRoutesDeps = { payees: PayeeService; sessions: PasskeySessions; network: string; explorerUrl: string; testnet: boolean }

/**
 * /claim/:token: the recipient creates (or signs in with) a passkey account and it is
 * registered as where this community pays them. The address always comes from the
 * passkey session the server verified, never from the page.
 */
export function claimRoutes(deps: ClaimRoutesDeps): Hono {
  const app = new Hono()

  app.get('/claim/:token', async (c) => {
    const token = c.req.param('token')
    const link = await deps.payees.describeLink({ token })
    if (!link.ok) return c.html(linkErrorPage(link.error.code, '/payee link', deps.testnet), linkStatus(link.error.code) as 404)
    const communityName = link.value.communityName ?? 'your Discord server'
    return c.html(
      claimPage(
        { page: 'claim', token, communityName, passkeyName: `payrun: ${communityName}`, network: deps.network, explorerUrl: deps.explorerUrl },
        deps.testnet,
      ),
    )
  })

  app.post('/claim/:token', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const token = c.req.param('token')
    const link = await deps.payees.describeLink({ token })
    const registered = await deps.payees.register({ token, address: session.address })
    if (!registered.ok) return failure(registered.error.code === 'invalid_input' ? 400 : linkStatus(registered.error.code), registered.error)
    return jsonResponse(200, { ok: true, address: registered.value.address, communityName: link.ok ? (link.value.communityName ?? null) : null })
  })

  return app
}
