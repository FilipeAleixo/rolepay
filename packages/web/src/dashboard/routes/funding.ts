import { Hono } from 'hono'
import { actionAccess, communityAccess } from '../access.js'
import { type DashboardKit, html, redirect } from '../kit.js'
import { fundingBody, fundingNotice } from '../views/funding.js'
import { shell } from '../views/layout.js'
import { MAX_NAMED } from './community.js'

/** Deposits listed on the page, newest first. */
const DEPOSITS_SHOWN = 100

/**
 * Funding: the community's funding sources, each with its deposit address (a Tempo virtual
 * address) and QR code, and the deposits they received. Read for any member; the Treasurer role
 * creates sources (gated like every action: CSRF, roles read fresh, core checks them again).
 */
export function fundingRoutes(kit: DashboardKit): Hono {
  const app = new Hono()

  app.get('/dashboard/:guildId/funding', async (c) => {
    const access = await communityAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const guildId = a.community.id
    const [status, month, deposits] = await Promise.all([
      kit.rolepay.funding.status({ guildId }),
      kit.rolepay.funding.month({ guildId }),
      kit.rolepay.funding.deposits({ guildId, limit: DEPOSITS_SHOWN }),
    ])
    if (!status.ok) throw new Error(status.error.code)
    const names = await kit.members.names(guildId, status.value.sources.map((s) => s.source.createdBy), { limit: MAX_NAMED })
    const body = fundingBody({
      guildId,
      status: status.value,
      month,
      deposits,
      treasury: a.community.treasuryAddress,
      payoutToken: a.community.payoutToken,
      explorer: kit.config.explorerUrl,
      names,
      canAct: a.viewer.canAct,
      csrf: a.viewer.csrf,
      notice: fundingNotice(c.req.query('done'), c.req.query('error')),
    })
    return html(shell({ title: `Funding: ${a.communityName} (Rolepay)`, testnet: kit.testnet, viewer: a.viewer, community: { id: guildId, name: a.communityName, section: 'funding' }, body }))
  })

  app.post('/dashboard/:guildId/funding/sources', async (c) => {
    const access = await actionAccess(kit, c)
    if (!access.ok) return access.response
    const a = access.value
    const back = `/dashboard/${a.community.id}/funding`
    const created = await kit.rolepay.funding.createSource({ guildId: a.community.id, actor: a.actor.id, actorRoleIds: a.actor.roleIds, name: a.form.name ?? '' })
    return redirect(`${back}?${created.ok ? 'done=source_created' : `error=${encodeURIComponent(created.error.code)}`}`, 303)
  })

  return app
}
